import type { MimeRef, MimeSymbol, RefKind } from "../types.ts";
import type { TreeSitterNode, TreeSitterTree } from "../TreeSitterExtractor.ts";

// References-channel engine (issue #19). Executes a language's refs query
// (S-expression patterns with `@ref.<kind>` captures) against a parsed tree
// and normalizes the captures to MimeRef rows. The engine is language-blind:
// everything language-specific lives in the query source.
//
// Container resolution: a ref's `container` is the FULL qualified path of
// the innermost enclosing emitted definition (SPEC §16 — the @> join key),
// derived from the symbols channel by line containment. No second walk, no
// duplicated container stack: the defs the symbols channel already emits ARE
// the scopes.

// The capture surface we need from web-tree-sitter's Query. Typed locally
// (like TreeSitterParser) so the framework type-checks without depending on
// web-tree-sitter's types.
export interface RefsQueryCapture {
    readonly name: string;
    readonly node: TreeSitterNode;
}

export interface RefsQuery {
    captures(node: TreeSitterNode): RefsQueryCapture[];
}

const REF_KINDS: ReadonlySet<string> = new Set<RefKind>([
    "import", "call", "instantiate", "inherit", "type", "use",
]);

export function collectReferences(
    query: RefsQuery,
    tree: TreeSitterTree,
    symbols: readonly MimeSymbol[],
): MimeRef[] {
    const defs = containerIndex(symbols);
    const seen = new Set<string>();
    const out: MimeRef[] = [];
    for (const capture of query.captures(tree.rootNode)) {
        if (!capture.name.startsWith("ref.")) continue;
        const kind = capture.name.slice(4);
        if (!REF_KINDS.has(kind)) continue;
        const name = capture.node.text;
        if (name.length === 0) continue;
        const line = capture.node.startPosition.row + 1;
        const column = capture.node.startPosition.column + 1;
        // Overlapping patterns can capture the same node under the same kind
        // (e.g. a call that is also matched by a more specific pattern) —
        // dedupe by position + kind.
        const key = `${line}:${column}:${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const container = enclosingDefPath(defs, line);
        out.push({
            name,
            kind: kind as RefKind,
            line,
            column,
            endLine: capture.node.endPosition.row + 1,
            endColumn: capture.node.endPosition.column + 1,
            ...(container !== null && { container }),
        });
    }
    // Deterministic document order (conformance invariant, issue #20).
    out.sort((a, b) => a.line - b.line || a.column - b.column);
    return out;
}

interface DefSpan {
    readonly path: string;
    readonly line: number;
    readonly endLine: number;
    readonly index: number;
}

function containerIndex(symbols: readonly MimeSymbol[]): DefSpan[] {
    return symbols.map((s, index) => ({
        path: s.container !== undefined ? `${s.container}.${s.name}` : s.name,
        line: s.line,
        endLine: s.endLine,
        index,
    }));
}

// Innermost emitted definition whose line range contains the ref's line:
// smallest span wins; equal spans (one-liners nest whole defs on a single
// line) go to the LATER emission — every walker pushes parents before their
// children, so the later def is the deeper scope.
function enclosingDefPath(defs: readonly DefSpan[], line: number): string | null {
    let best: DefSpan | null = null;
    for (const def of defs) {
        if (line < def.line || line > def.endLine) continue;
        if (best === null
            || (def.endLine - def.line) < (best.endLine - best.line)
            || ((def.endLine - def.line) === (best.endLine - best.line) && def.index > best.index)) {
            best = def;
        }
    }
    return best === null ? null : best.path;
}
