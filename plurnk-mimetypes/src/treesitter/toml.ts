import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// TOML SPEC §3 mapping via @tree-sitter-grammars/tree-sitter-toml.
//
// Two channels:
//   - symbols (extract): tree-sitter walk surfacing tables/keys as a
//     module/field outline. Coarse, for the model's preview.
//   - deep-json (deepJson): the parsed TOML value via `smol-toml`. This is
//     what jsonpath queries against — users writing `$.server.host` want
//     the parsed value tree.
export async function deepJson(content: string): Promise<unknown> {
    const { parse } = await import("smol-toml" as string) as { parse(text: string): unknown };
    try {
        return parse(content);
    } catch {
        return null;
    }
}

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
            if (key) push(out, "module", key, node, "");
            // Pairs inside the table carry the emitted table name verbatim
            // as their container — dotted headers stay one segment.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "pair") {
                    const pkey = firstKeyText(child);
                    if (pkey) push(out, "field", pkey, child, key ?? "");
                }
            }
            return;
        }
        case "pair": {
            // Top-level pair (before any [table] header).
            const key = firstKeyText(node);
            if (key) push(out, "field", key, node, "");
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

function push(
    out: MimeSymbol[],
    kind: SymbolKind,
    name: string,
    node: TreeSitterNode,
    container: string,
): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
        ...(container.length > 0 && { container }),
    });
}
