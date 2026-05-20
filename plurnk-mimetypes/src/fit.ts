import type { MimeSymbol, TokenizeFn } from "./types.ts";
import { buildTree, maxDepth, pruneToMaxDepth, renderTree } from "./format.ts";

// Maximum iterations when shrinking raw content to fit a token budget. Bounded
// to defend against pathological tokenize functions that don't converge.
const MAX_FIT_CONTENT_ITERATIONS = 20;

// Safety margin: aim slightly under the ratio so non-linear tokenizers don't
// overshoot on the next measurement.
const FIT_CONTENT_RATIO_MARGIN = 0.9;

export async function fit(
    symbols: MimeSymbol[],
    budget: number,
    tokenize: TokenizeFn,
): Promise<string> {
    if (symbols.length === 0) return "";

    let tree = buildTree(symbols);
    let rendered = renderTree(tree);
    let tokens = await tokenize(rendered);
    if (tokens <= budget) return rendered;

    // Drop deepest level repeatedly until fits or only roots remain.
    let limit = maxDepth(tree);
    while (limit > 0 && tokens > budget) {
        limit -= 1;
        tree = pruneToMaxDepth(tree, limit);
        rendered = renderTree(tree);
        tokens = await tokenize(rendered);
    }
    if (tokens <= budget) return rendered;

    // Still over — drop trailing root-level symbols until fits.
    while (tree.length > 1 && tokens > budget) {
        tree = tree.slice(0, -1);
        rendered = renderTree(tree);
        tokens = await tokenize(rendered);
    }
    if (tokens <= budget) return rendered;

    // Single root still overflows — surrender.
    return "";
}

// Fit raw content to a token budget by iteratively shrinking. Used as a
// fallback when symbol extraction yields nothing (parse failure, unknown
// handler, empty extract) but the consumer still wants *something* to preview.
export async function fitContent(
    content: string,
    budget: number,
    tokenize: TokenizeFn,
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
        working = working.slice(0, newLen);
        tokens = await tokenize(working);
        iterations += 1;
    }
    return tokens <= budget ? working : "";
}
