import type { MimeSymbol } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Python SPEC §3 mapping. Tree-sitter-python produces a `module` root whose
// children are top-level statements. We walk the named children at each
// scope and emit symbols for the declaration node types:
//
//   function_definition          → function (top-level) / method (in class)
//   async_function_definition    → same
//   class_definition             → class; methods inside become method
//   decorated_definition         → unwrap to inner function/class
//   assignment   (top-level)     → variable / constant (heuristic: SCREAMING_SNAKE_CASE
//                                  → constant; otherwise variable)
//   import_statement / from ...  → excluded
//
// Function-body locals are excluded by not recursing into function bodies.
// Class-body recursion is necessary to surface methods + class-level fields.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    for (let i = 0; i < node.childCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        // expression_statement wraps top-level/class-body assignments — peek
        // through it to the actual statement.
        if (child.type === "expression_statement") {
            const inner = child.namedChild(0);
            if (inner) dispatch(inner, out, inClass);
            continue;
        }
        dispatch(child, out, inClass);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    switch (node.type) {
        case "function_definition":
        case "async_function_definition": {
            const name = childFieldText(node, "name");
            if (!name) return;
            const params = extractParameters(node.childForFieldName("parameters"));
            out.push({
                name,
                kind: inClass ? "method" : "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params,
            });
            // Don't recurse into function bodies — gate locals.
            return;
        }
        case "class_definition": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "class",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
            });
            // Recurse into the class body, marking inClass = true so nested
            // functions become methods.
            const body = node.childForFieldName("body");
            if (body) walk(body, out, true);
            return;
        }
        case "decorated_definition": {
            // The decorated definition's inner definition is the actual
            // declaration. Find the function_definition or class_definition
            // child and dispatch.
            for (let i = 0; i < node.childCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "function_definition"
                    || child.type === "async_function_definition"
                    || child.type === "class_definition") {
                    dispatch(child, out, inClass);
                    return;
                }
            }
            return;
        }
        case "assignment": {
            // At module or class scope: surface as variable/constant/field.
            // Tree-sitter's assignment node has `left` (target), `right`
            // (value). Single-target assignments like `X = 1` or
            // `x: int = 1` yield identifier or typed_default_parameter as left.
            const left = node.childForFieldName("left");
            if (!left) return;
            const name = identifierText(left);
            if (!name) return;
            const kind: "field" | "constant" | "variable" =
                inClass ? "field" : (isScreamingSnake(name) ? "constant" : "variable");
            out.push({
                name,
                kind,
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
            });
            return;
        }
        default:
            return;
    }
}

function childFieldText(node: TreeSitterNode, field: string): string | null {
    const child = node.childForFieldName(field);
    return child ? child.text : null;
}

function identifierText(node: TreeSitterNode): string | null {
    if (node.type === "identifier") return node.text;
    // Patterns like `x: int = 1` have `typed_default_parameter` or similar
    // wrappers. Look for the first identifier child.
    for (let i = 0; i < node.childCount; i += 1) {
        const child = node.namedChild(i);
        if (child?.type === "identifier") return child.text;
    }
    return null;
}

function isScreamingSnake(name: string): boolean {
    // All caps, digits, underscores; at least one letter.
    if (name.length === 0) return false;
    let hasLetter = false;
    for (const c of name) {
        if (c >= "A" && c <= "Z") hasLetter = true;
        else if (c === "_" || (c >= "0" && c <= "9")) continue;
        else return false;
    }
    return hasLetter;
}

// parameters: typed parameter list. Tree-sitter exposes each as
// `identifier`, `typed_parameter`, `default_parameter`, or
// `typed_default_parameter`. We extract the identifier text for each.
function extractParameters(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.childCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        const name = parameterName(child);
        if (name) out.push(name);
    }
    return out;
}

function parameterName(node: TreeSitterNode): string | null {
    switch (node.type) {
        case "identifier":
            return node.text;
        case "typed_parameter":
        case "default_parameter":
        case "typed_default_parameter": {
            // First identifier child is the param name.
            for (let i = 0; i < node.childCount; i += 1) {
                const child = node.namedChild(i);
                if (child?.type === "identifier") return child.text;
            }
            return null;
        }
        case "list_splat_pattern":
        case "dictionary_splat_pattern":
            // *args / **kwargs — skip; they're variadic markers not
            // declarations.
            return null;
        default:
            return null;
    }
}
