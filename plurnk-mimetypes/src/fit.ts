import type { MimeSymbol, Preview, TokenizeFn } from "./types.ts";
import { buildTree, maxDepth, pruneToMaxDepth, renderTree } from "./format.ts";

// Maximum iterations when shrinking raw content to fit a token budget. Bounded
// to defend against pathological tokenize functions that don't converge.
const MAX_FIT_CONTENT_ITERATIONS = 20;

// Safety margin: aim slightly under the ratio so non-linear tokenizers don't
// overshoot on the next measurement.
const FIT_CONTENT_RATIO_MARGIN = 0.9;

// Top-level dispatcher for Preview material. Handlers return a Preview; the
// framework calls this to produce the final budgeted string.
//
//   null     → "" (no structural signal for this content)
//   symbols  → fit-symbols (drop-deepest-first, then drop-trailing-roots)
export async function fitPreview(
    preview: Preview,
    budget: number,
    tokenize: TokenizeFn,
): Promise<string> {
    if (preview === null) return "";
    return fitSymbols([...preview.symbols], budget, tokenize);
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
// chooses which end of the content survives: "head" keeps the start (default
// for documents, articles, source files); "tail" keeps the end (logs,
// append-only feeds, diffs).
export async function fitContent(
    content: string,
    budget: number,
    tokenize: TokenizeFn,
    orientation: "head" | "tail" = "head",
): Promise<string> {
    if (content === "" || budget <= 0) return "";

    let tokens = await tokenize(content);
    if (tokens <= budget) return content;

    let working = content;
    let iterations = 0;
    while (tokens > budget && working.length > 1 && iterations < MAX_FIT_CONTENT_ITERATIONS) {
        const ratio = (budget / tokens) * FIT_CONTENT_RATIO_MARGIN;
        const newLen = Math.max(1, Math.floor(working.length * ratio));
        if (newLen >= working.length) break;
        working = orientation === "tail"
            ? working.slice(working.length - newLen)
            : working.slice(0, newLen);
        tokens = await tokenize(working);
        iterations += 1;
    }
    return tokens <= budget ? working : "";
}
