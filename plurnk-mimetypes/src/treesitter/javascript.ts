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
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, /*inClass*/ false);
    return out;
}

export function walk(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, inClass);
    }
}

export function dispatch(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    switch (node.type) {
        case "function_declaration":
        case "generator_function_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "class_declaration":
        case "abstract_class_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "class", name, node);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, true);
            return;
        }
        case "method_definition": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "method",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "field_definition":
        case "public_field_definition": {
            // field_definition uses the `property` field; public_field_definition
            // uses `name`. Probe both.
            const name = childFieldText(node, "property") ?? childFieldText(node, "name");
            if (name) push(out, "field", name, node);
            return;
        }
        case "lexical_declaration":
        case "variable_declaration": {
            // const/let/var: iterate variable_declarator children.
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
                        kind: inClass ? "method" : "function",
                        line: child.startPosition.row + 1,
                        endLine: child.endPosition.row + 1,
                        params: extractParams(value.childForFieldName("parameters")),
                    });
                    continue;
                }
                const kind: SymbolKind = inClass
                    ? "field"
                    : (isConst && isScreamingSnake(name) ? "constant" : "variable");
                push(out, kind, name, child);
            }
            return;
        }
        case "export_statement": {
            // export <decl> or export default <decl>; unwrap to inner declaration.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                dispatch(child, out, inClass);
            }
            return;
        }
        default:
            return;
    }
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

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
