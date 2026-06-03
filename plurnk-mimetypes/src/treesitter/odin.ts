import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Odin SPEC §3 mapping via tree-sitter-odin.
//
//   package_declaration   → module
//   procedure_declaration → function (identifier + procedure → parameters)
//   struct_declaration    → class + fields
//   enum_declaration      → enum + identifier children as constants
//   union_declaration     → class
//   const_declaration     → constant
//   variable_declaration  → variable
//   type_declaration      → type
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
        case "package_declaration": {
            const ident = firstIdentifierText(node);
            if (ident) push(out, "module", ident, node);
            return;
        }
        case "procedure_declaration": {
            const ident = firstIdentifierText(node);
            if (!ident) return;
            const proc = findChildOfType(node, "procedure");
            const params = extractParams(proc ? findChildOfType(proc, "parameters") : null);
            out.push({
                name: ident,
                kind: "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params,
            });
            return;
        }
        case "struct_declaration":
        case "union_declaration": {
            const ident = firstIdentifierText(node);
            if (!ident) return;
            push(out, "class", ident, node);
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "field") {
                    const fname = firstIdentifierText(child);
                    if (fname) push(out, "field", fname, child);
                }
            }
            return;
        }
        case "enum_declaration": {
            const idents: TreeSitterNode[] = [];
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (child && child.type === "identifier") idents.push(child);
            }
            if (idents.length === 0) return;
            push(out, "enum", idents[0].text, node);
            for (let i = 1; i < idents.length; i += 1) {
                push(out, "constant", idents[i].text, idents[i]);
            }
            return;
        }
        case "const_declaration": {
            const ident = firstIdentifierText(node);
            if (ident) push(out, "constant", ident, node);
            return;
        }
        case "variable_declaration": {
            const ident = firstIdentifierText(node);
            if (ident) push(out, "variable", ident, node);
            return;
        }
        case "type_declaration": {
            const ident = firstIdentifierText(node);
            if (ident) push(out, "type", ident, node);
            return;
        }
        default:
            return;
    }
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
            // parameter: first identifier is the name (later identifiers are type pieces).
            const ident = firstIdentifierText(child);
            if (ident) out.push(ident);
        }
    }
    return out;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
