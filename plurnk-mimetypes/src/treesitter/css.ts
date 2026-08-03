import { treeSitterSpan } from "../ParserCoordinates.ts";
import type { TreeSitterSymbolProjection } from "../ParserCoordinates.ts";
import type { SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// CSS SPEC §3 mapping for tree-sitter-css.
//
//   rule_set with selectors → field, name = serialized selector text
//   keyframes_statement     → module, name = keyframe name
//   media_statement         → module, name = "@media <query>"
//   :root custom properties → constant per --name
export function extract(root: TreeSitterNode, _content: string): TreeSitterSymbolProjection[] {
    const out: TreeSitterSymbolProjection[] = [];
    walk(root, out, "");
    return out;
}

function walk(node: TreeSitterNode, out: TreeSitterSymbolProjection[], container: string): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, container);
    }
}

function dispatch(node: TreeSitterNode, out: TreeSitterSymbolProjection[], container: string): void {
    switch (node.type) {
        case "rule_set": {
            const selectors = findChildOfType(node, "selectors");
            if (!selectors) return;
            const name = selectors.text.trim();
            if (name.length > 0) push(out, "field", name, node, container);
            if (name === ":root") {
                const block = findChildOfType(node, "block");
                const inner = container.length > 0 ? `${container}.${name}` : name;
                if (block) emitCustomProperties(block, out, inner);
            }
            return;
        }
        case "keyframes_statement": {
            const nameNode = findChildOfType(node, "keyframes_name");
            const name = nameNode ? nameNode.text : "keyframes";
            push(out, "module", name, node, container);
            return;
        }
        case "media_statement": {
            const query = findChildOfType(node, "feature_query");
            const text = query ? query.text.trim() : "media";
            const name = `@media ${text}`;
            push(out, "module", name, node, container);
            const block = findChildOfType(node, "block");
            if (block) walk(block, out, container.length > 0 ? `${container}.${name}` : name);
            return;
        }
        default:
            return;
    }
}

function emitCustomProperties(block: TreeSitterNode, out: TreeSitterSymbolProjection[], container: string): void {
    for (let i = 0; i < block.namedChildCount; i += 1) {
        const child = block.namedChild(i);
        if (!child || child.type !== "declaration") continue;
        const prop = findChildOfType(child, "property_name");
        if (prop && prop.text.startsWith("--")) {
            push(out, "constant", prop.text, child, container);
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

function push(
    out: TreeSitterSymbolProjection[],
    kind: SymbolKind,
    name: string,
    node: TreeSitterNode,
    container: string,
): void {
    out.push({
        name,
        kind,
        span: treeSitterSpan(node),
        ...(container.length > 0 && { container }),
    });
}
