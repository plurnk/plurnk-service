import type { MimeSymbol } from "./types.ts";
import { buildTree, type TreeNode } from "./format.ts";

// The unified queryable shape exposed by jsonpath against any handler's
// extracted symbols. One shape across markdown, HTML, PDF outline, source
// code outlines — model learns it once and applies it everywhere.
//
// Nesting matches structural depth in the document. Leaves are bare line
// numbers. Parents are objects whose keys are child symbol names. There is
// no kind, no signature, no endLine — those live on the underlying MimeSymbol
// for callers that need them via extractRaw, but they're absent from the
// queryable shape on purpose: this is a navigation surface, not a content
// surface.
//
// Sibling-name collisions are resolved last-write-wins. Real documents rarely
// have identical sibling names; when they do, losing one to the other is
// acceptable for the simplicity gain.
//
// Example (markdown):
//   # Top
//     ## Section
//       ### Sub      [line 5]
//     ## Other       [line 7]
// →
//   { "Top": { "Section": { "Sub": 5 }, "Other": 7 } }
export type JsonOutline = { [key: string]: number | JsonOutline };

export function buildJsonOutline(symbols: readonly MimeSymbol[]): JsonOutline {
    if (symbols.length === 0) return {};
    const tree = buildTree([...symbols]);
    return treeToOutline(tree);
}

function treeToOutline(nodes: readonly TreeNode[]): JsonOutline {
    const out: JsonOutline = {};
    for (const node of nodes) {
        const name = node.symbol.name;
        if (node.children.length === 0) {
            // Leaf: bare line number.
            out[name] = node.symbol.line;
        } else {
            // Parent: nested object, recursively. The parent's own line is
            // intentionally absent — leaves carry positions; parents carry
            // structure.
            out[name] = treeToOutline(node.children);
        }
    }
    return out;
}
