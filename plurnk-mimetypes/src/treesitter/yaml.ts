import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// YAML SPEC §3 mapping via @tree-sitter-grammars/tree-sitter-yaml.
//
// Two channels:
//   - symbols (extract): tree-sitter walk surfacing every mapping key as a
//     field-like outline entry. Coarse but useful for the model's preview.
//   - deep-json (deepJson): the parsed YAML value via the `yaml` library —
//     this is the jsonpath query target. Users writing `$.server.host`
//     expect the parsed value tree, not the AST. The framework projects
//     this to deep-xml.
export async function deepJson(content: string): Promise<unknown> {
    const { parse } = await import("yaml" as string) as { parse(text: string): unknown };
    try {
        const value = parse(content);
        return value ?? null;
    } catch {
        return null;
    }
}

export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[]): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "block_mapping_pair" || child.type === "flow_pair") {
            handlePair(child, out);
            continue;
        }
        walk(child, out);
    }
}

function handlePair(pair: TreeSitterNode, out: MimeSymbol[]): void {
    const key = pair.childForFieldName("key");
    if (!key) return;
    const keyText = scalarText(key);
    if (keyText) push(out, "field", keyText, pair);
    const value = pair.childForFieldName("value");
    if (value) walk(value, out);
}

function scalarText(node: TreeSitterNode): string | null {
    // key is typically a flow_node → plain_scalar → string_scalar
    if (node.type === "string_scalar" || node.type === "plain_scalar") {
        return node.text;
    }
    if (node.type === "flow_node") {
        const inner = node.namedChild(0);
        if (inner) return scalarText(inner);
    }
    // Fallback: source text — strip surrounding quotes if any.
    const text = node.text;
    return text.replace(/^['"]|['"]$/g, "");
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
