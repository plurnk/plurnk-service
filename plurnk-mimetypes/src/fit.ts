import type { MimeSymbol, Preview, TokenizeFn } from "./types.ts";
import { buildTree, maxDepth, pruneToMaxDepth, renderTree } from "./format.ts";

// Maximum iterations when shrinking raw content to fit a token budget. Bounded
// to defend against pathological tokenize functions that don't converge.
const MAX_FIT_CONTENT_ITERATIONS = 20;

// Safety margin: aim slightly under the ratio so non-linear tokenizers don't
// overshoot on the next measurement.
const FIT_CONTENT_RATIO_MARGIN = 0.9;

// Truncation sentinel. Appended (head orientation) or prepended (tail
// orientation) to a TextPreview that overflowed budget and had to be sliced.
// Distinctive enough to be unambiguous in agent output; reserved budget so
// the model knows the preview is incomplete and a fetch reveals more.
const TRUNCATION_MARKER_HEAD = "...[[TRUNCATED]]";
// Exported because Mimetypes.tailStartLine must strip this exact sentinel to
// recover the slice offset — a silent mismatch would shift every tail-preview
// line number without crashing.
export const TRUNCATION_MARKER_TAIL = "[[TRUNCATED]]...";

// Top-level dispatcher for Preview material. Handlers return a Preview; the
// framework calls this to produce the final budgeted string.
//
//   null     → "" (handler explicitly declines)
//   symbols  → fit-symbols (drop-deepest-first, then drop-trailing-roots)
//   text     → fit-content (oriented truncation with [[TRUNCATED]] marker)
export async function fitPreview(
    preview: Preview,
    budget: number,
    tokenize: TokenizeFn,
): Promise<string> {
    if (preview === null) return "";
    if (preview.kind === "symbols") {
        return fitSymbols([...preview.symbols], budget, tokenize);
    }
    return fitContent(preview.text, budget, tokenize, preview.orientation);
}

// Fit a flat MimeSymbol[] to a token budget. Builds a containment tree from
// the symbols, renders the full outline, then progressively drops deepest
// levels (then trailing roots) until the rendered text fits the budget.
// Surrenders to "" if even a single root overflows.
export async function fitSymbols(
    symbols: MimeSymbol[],
    budget: number,
    tokenize: TokenizeFn,
): Promise<string> {
    if (symbols.length === 0) return "";

    let tree = buildTree(symbols);
    let rendered = renderTree(tree);
    let tokens = await tokenize(rendered);
    if (tokens <= budget) return rendered;

    let limit = maxDepth(tree);
    while (limit > 0 && tokens > budget) {
        limit -= 1;
        tree = pruneToMaxDepth(tree, limit);
        rendered = renderTree(tree);
        tokens = await tokenize(rendered);
    }
    if (tokens <= budget) return rendered;

    while (tree.length > 1 && tokens > budget) {
        tree = tree.slice(0, -1);
        rendered = renderTree(tree);
        tokens = await tokenize(rendered);
    }
    if (tokens <= budget) return rendered;

    return "";
}

// Fit raw content to a token budget by iteratively shrinking. Orientation
// chooses which end of the content survives:
//   - "head" keeps the start (documents, articles, source files), trails with
//     `...[[TRUNCATED]]` when truncation occurred.
//   - "tail" keeps the end (streams, logs, append-only feeds), leads with
//     `[[TRUNCATED]]...`.
// When no truncation is needed (content fits the budget as-is), no marker is
// added. The marker's token cost is reserved up front so the final output
// (content slice + marker) stays within the budget.
export async function fitContent(
    content: string,
    budget: number,
    tokenize: TokenizeFn,
    orientation: "head" | "tail" = "head",
): Promise<string> {
    if (content === "" || budget <= 0) return "";

    let tokens = await tokenize(content);
    if (tokens <= budget) return content;

    // Truncation will happen. Reserve budget for the marker; if even the
    // marker can't fit, give up rather than return a misleading partial
    // slice without an "incomplete" signal.
    const marker = orientation === "head" ? TRUNCATION_MARKER_HEAD : TRUNCATION_MARKER_TAIL;
    const markerTokens = await tokenize(marker);
    if (markerTokens >= budget) return "";
    const effectiveBudget = budget - markerTokens;

    let working = content;
    let iterations = 0;
    while (tokens > effectiveBudget && working.length > 1 && iterations < MAX_FIT_CONTENT_ITERATIONS) {
        const ratio = (effectiveBudget / tokens) * FIT_CONTENT_RATIO_MARGIN;
        const newLen = Math.max(1, Math.floor(working.length * ratio));
        if (newLen >= working.length) break;
        working = orientation === "tail"
            ? working.slice(working.length - newLen)
            : working.slice(0, newLen);
        tokens = await tokenize(working);
        iterations += 1;
    }
    if (tokens > effectiveBudget) return "";

    return orientation === "head" ? working + marker : marker + working;
}
