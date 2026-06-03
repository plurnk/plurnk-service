import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Zig SPEC §3 mapping via @tree-sitter-grammars/tree-sitter-zig.
//
//   function_declaration → function with params
//   variable_declaration:
//     value = struct_declaration → class (with container_field children as fields)
//     value = enum_declaration   → enum (with container_field children as constants)
//     value = union_declaration  → class
//     value = error_set_declaration → enum
//     other (literal/builtin)    → constant (if SCREAMING) or variable
//   test_declaration → function (Zig's test blocks)
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    for (let i = 0; i < root.namedChildCount; i += 1) {
        const child = root.namedChild(i);
        if (!child) continue;
        dispatch(child, out);
    }
    return out;
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[]): void {
    switch (node.type) {
        case "function_declaration": {
            const name = childFieldText(node, "name") ?? firstIdentifierText(node);
            if (!name) return;
            out.push({
                name,
                kind: "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params: extractParams(findChildOfType(node, "parameters")),
            });
            return;
        }
        case "variable_declaration": {
            // First named child is the identifier; second is the value.
            const ident = node.namedChild(0);
            if (!ident || ident.type !== "identifier") return;
            const name = ident.text;
            // Scan for typed container values (struct/enum/union/error_set).
            for (let i = 1; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "struct_declaration") {
                    push(out, "class", name, node);
                    emitContainerFields(child, out, "field");
                    return;
                }
                if (child.type === "enum_declaration") {
                    push(out, "enum", name, node);
                    emitContainerFields(child, out, "constant");
                    return;
                }
                if (child.type === "union_declaration") {
                    push(out, "class", name, node);
                    emitContainerFields(child, out, "field");
                    return;
                }
                if (child.type === "error_set_declaration") {
                    push(out, "enum", name, node);
                    return;
                }
            }
            push(out, isScreamingSnake(name) ? "constant" : "variable", name, node);
            return;
        }
        case "test_declaration": {
            // test "name" { ... } — surface as function with the literal name.
            const str = findChildOfType(node, "string");
            if (str) {
                const text = str.text.replace(/^"/, "").replace(/"$/, "");
                push(out, "function", text, node);
            }
            return;
        }
        default:
            return;
    }
}

function emitContainerFields(container: TreeSitterNode, out: MimeSymbol[], kind: SymbolKind): void {
    for (let i = 0; i < container.namedChildCount; i += 1) {
        const child = container.namedChild(i);
        if (!child) continue;
        if (child.type === "container_field") {
            const name = childFieldText(child, "name") ?? firstIdentifierText(child);
            if (name) push(out, kind, name, child);
        }
    }
}

function childFieldText(node: TreeSitterNode, field: string): string | null {
    const child = node.childForFieldName(field);
    return child ? child.text : null;
}

function findChildOfType(node: TreeSitterNode, type: string): TreeSitterNode | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === type) return child;
    }
    return null;
}

function firstIdentifierText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier") return child.text;
    }
    return null;
}

function extractParams(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.namedChildCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        if (child.type === "parameter") {
            const name = childFieldText(child, "name") ?? firstIdentifierText(child);
            if (name) out.push(name);
        }
    }
    return out;
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
