import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// CSS SPEC §3 mapping for tree-sitter-css.
//
//   rule_set with selectors → field, name = serialized selector text
//   keyframes_statement     → module, name = keyframe name
//   media_statement         → module, name = "@media <query>"
//   :root custom properties → constant per --name
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[]): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[]): void {
    switch (node.type) {
        case "rule_set": {
            const selectors = findChildOfType(node, "selectors");
            if (!selectors) return;
            const name = selectors.text.trim();
            if (name.length > 0) push(out, "field", name, node);
            if (name === ":root") {
                const block = findChildOfType(node, "block");
                if (block) emitCustomProperties(block, out);
            }
            return;
        }
        case "keyframes_statement": {
            const nameNode = findChildOfType(node, "keyframes_name");
            const name = nameNode ? nameNode.text : "keyframes";
            push(out, "module", name, node);
            return;
        }
        case "media_statement": {
            const query = findChildOfType(node, "feature_query");
            const text = query ? query.text.trim() : "media";
            push(out, "module", `@media ${text}`, node);
            const block = findChildOfType(node, "block");
            if (block) walk(block, out);
            return;
        }
        default:
            return;
    }
}

function emitCustomProperties(block: TreeSitterNode, out: MimeSymbol[]): void {
    for (let i = 0; i < block.namedChildCount; i += 1) {
        const child = block.namedChild(i);
        if (!child || child.type !== "declaration") continue;
        const prop = findChildOfType(child, "property_name");
        if (prop && prop.text.startsWith("--")) {
            push(out, "constant", prop.text, child);
        }
    }
}

function findChildOfType(node: TreeSitterNode, type: string): TreeSitterNode | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === type) return child;
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
