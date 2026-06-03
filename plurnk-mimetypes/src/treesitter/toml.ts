import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// TOML SPEC §3 mapping via @tree-sitter-grammars/tree-sitter-toml.
//
//   table       → module (key is bare_key or dotted_key)
//   table_array → module (key)
//   pair        → field (key + value, value not recursed since TOML values
//                 are scalars or inline tables/arrays)
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
        case "table":
        case "table_array_element": {
            const key = firstKeyText(node);
            if (key) push(out, "module", key, node);
            // Pairs inside the table.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "pair") {
                    const pkey = firstKeyText(child);
                    if (pkey) push(out, "field", pkey, child);
                }
            }
            return;
        }
        case "pair": {
            // Top-level pair (before any [table] header).
            const key = firstKeyText(node);
            if (key) push(out, "field", key, node);
            return;
        }
        default:
            return;
    }
}

function firstKeyText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "bare_key" || child.type === "dotted_key"
            || child.type === "quoted_key") {
            return child.text.replace(/^['"]|['"]$/g, "");
        }
    }
    return null;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
