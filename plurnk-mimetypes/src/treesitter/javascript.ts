import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// JavaScript SPEC §3 mapping via tree-sitter-javascript.
//
//   function_declaration       → function
//   class_declaration          → class (recurse, inClass=true)
//   method_definition          → method (in class body)
//   field_definition           → field (in class body)
//   lexical_declaration        → variable / constant (const → constant if SCREAMING, else variable)
//   variable_declaration (var) → variable
//   export_statement / export_default → unwrap and dispatch
//
// Container semantics (issue #18): symbols inside a class carry the dotted
// path of enclosing emitted scope names. Top-level symbols carry no container.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, "");
    return out;
}

export function walk(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, container);
    }
}

export function dispatch(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    switch (node.type) {
        case "function_declaration":
        case "generator_function_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "function",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "class_declaration":
        case "abstract_class_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "class", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, container.length > 0 ? `${container}.${name}` : name);
            return;
        }
        case "method_definition": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "method",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "field_definition":
        case "public_field_definition": {
            // field_definition uses the `property` field; public_field_definition
            // uses `name`. Probe both.
            const name = childFieldText(node, "property") ?? childFieldText(node, "name");
            if (name) push(out, "field", name, node, container);
            return;
        }
        case "lexical_declaration":
        case "variable_declaration": {
            // const/let/var: iterate variable_declarator children. Class bodies
            // never contain lexical_declaration (members are method_definition /
            // field_definition), so kinds here are scope-independent — a non-empty
            // container only ever means a TS namespace body.
            const isConst = node.type === "lexical_declaration"
                && node.text.startsWith("const");
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type !== "variable_declarator") continue;
                const name = childFieldText(child, "name");
                if (!name) continue;
                const value = child.childForFieldName("value");
                if (value && (value.type === "function" || value.type === "arrow_function")) {
                    out.push({
                        name,
                        kind: "function",
                        ...position(child),
                        ...(container.length > 0 && { container }),
                        params: extractParams(value.childForFieldName("parameters")),
                    });
                    continue;
                }
                const kind: SymbolKind = isConst && isScreamingSnake(name) ? "constant" : "variable";
                push(out, kind, name, child, container);
            }
            return;
        }
        case "export_statement": {
            // export <decl> or export default <decl>; unwrap to inner declaration.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                dispatch(child, out, container);
            }
            return;
        }
        default:
            return;
    }
}

export function position(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    };
}

export function childFieldText(node: TreeSitterNode, field: string): string | null {
    const child = node.childForFieldName(field);
    return child ? child.text : null;
}

export function extractParams(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.namedChildCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        const name = paramName(child);
        if (name) out.push(name);
    }
    return out;
}

function paramName(node: TreeSitterNode): string | null {
    switch (node.type) {
        case "identifier":
            return node.text;
        case "required_parameter":
        case "optional_parameter":
        case "assignment_pattern":
        case "rest_pattern":
            return firstIdentifierText(node);
        case "object_pattern":
        case "array_pattern":
            // Destructured — use the source text as the param descriptor
            // (collapsed to one entry, since param identity is structural).
            return node.text;
        default:
            return firstIdentifierText(node);
    }
}

function firstIdentifierText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier") return child.text;
    }
    return null;
}

function isScreamingSnake(name: string): boolean {
    if (name.length === 0) return false;
    let hasLetter = false;
    for (const c of name) {
        if (c >= "A" && c <= "Z") hasLetter = true;
        else if (c === "_" || (c >= "0" && c <= "9")) continue;
        else return false;
    }
    return hasLetter;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container: string): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}

export { refsQuery } from "./queries/javascript.ts";
