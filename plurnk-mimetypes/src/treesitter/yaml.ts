import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// YAML SPEC §3 mapping via @tree-sitter-grammars/tree-sitter-yaml.
//
// YAML has no functions/classes/etc — symbols are mapping keys at any
// nesting depth. We emit each `block_mapping_pair` key as a field-like
// outline entry. Nested values may be sub-mappings; we recurse.
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
    if (node.type === "plain_scalar") {
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
