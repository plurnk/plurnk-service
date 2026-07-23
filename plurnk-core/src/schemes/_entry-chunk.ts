// The chunker for the `~query` semantic dialect — lossless, structure-preferring,
// budget-driven. Service-owned: the embedder plugin only embeds text + reports
// its window/tokenizer; how an entry is sliced to fit that window is the dialect's
// job, and the dialect is ours.
//
// tile() partitions an entry's body into chunks each <= `budget` tokens, COVERING
// EVERY LINE (losslessness — no truncation, ever), preferring to break at a
// `boundaries` line (a @graph symbol edge) when one falls within budget. Pure: no
// I/O, no DB, no plugin — `countTokens` is injected (the embedder's real
// tokenizer in production; a conservative char-count upper bound until it reports
// one; a stub in tests). Every tunable is a parameter — no constants live here.

export interface ChunkSpec {
    seq: number;        // 0-based index within the entry
    lineStart: number;  // 1-based first line, inclusive — the <L> extent
    lineEnd: number;    // 1-based last line, inclusive
    text: string;       // the chunk body (verbatim lines; a sub-slice for a giant line)
}

export default class EntryChunk {
    static async tile(
        content: string,
        boundaries: ReadonlySet<number>,
        budget: number,
        overlap: number,
        countTokens: (text: string) => Promise<number>,
        onPlanningProgress?: (progress: { completed: number; total: number }) => void,
    ): Promise<ChunkSpec[]> {
        if (!(budget >= 1)) throw new Error(`EntryChunk.tile: budget must be >= 1, got ${budget}`);
        if (!(overlap >= 0 && overlap < 1)) throw new Error(`EntryChunk.tile: overlap must be in [0,1), got ${overlap}`);
        if (content.length === 0) return [];

        const lines = content.split("\n");
        const n = lines.length;
        // The budget is checked against the SUM of per-line counts. Cross-line BPE
        // merges only ever shrink the true token count, so the sum is a safe upper
        // bound: a chunk that passes the sum check is guaranteed <= budget in the
        // real tokenizer. Lossless, and only O(n) countTokens calls.
        let planned = 0;
        const lineTokens = await Promise.all(lines.map(async (line) => {
            const tokens = await countTokens(line);
            planned++;
            onPlanningProgress?.({ completed: planned, total: lines.length });
            return tokens;
        }));

        const chunks: ChunkSpec[] = [];
        let start = 0;
        while (start < n) {
            // A single line larger than the whole budget can never fit — sub-split
            // it (the one place we ever cut mid-line). This is what makes "no
            // truncation, ever" hold even for a minified blob or a giant literal.
            if (lineTokens[start] > budget) {
                for (const piece of await EntryChunk.#splitLine(lines[start], budget, countTokens)) {
                    chunks.push({ seq: chunks.length, lineStart: start + 1, lineEnd: start + 1, text: piece });
                }
                start += 1;
                continue;
            }

            // Greedily pack lines while the running sum stays within budget,
            // remembering the last boundary line crossed (the preferred cut point).
            let end = start;
            let sum = lineTokens[start];
            let lastBoundary = -1;
            while (end + 1 < n && sum + lineTokens[end + 1] <= budget) {
                end += 1;
                sum += lineTokens[end];
                if (boundaries.has(end + 1)) lastBoundary = end;
            }
            const closeAt = lastBoundary > start ? lastBoundary : end;
            chunks.push({
                seq: chunks.length,
                lineStart: start + 1,
                lineEnd: closeAt + 1,
                text: lines.slice(start, closeAt + 1).join("\n"),
            });
            start = EntryChunk.#nextStart(start, closeAt, n, overlap, budget, lineTokens);
        }
        return chunks;
    }

    // Start of the next chunk: just after the close, backed up by ~overlap*budget
    // tokens of trailing context. Always strictly after `start` so the tiling
    // advances (no infinite loop) and never leaves a gap (next <= closeAt+1).
    static #nextStart(start: number, closeAt: number, n: number, overlap: number, budget: number, lineTokens: number[]): number {
        const after = closeAt + 1;
        if (overlap === 0 || after >= n || closeAt === start) return after;
        const want = budget * overlap;
        let next = closeAt;
        let acc = lineTokens[closeAt];
        while (next - 1 > start && acc + lineTokens[next - 1] <= want) { next -= 1; acc += lineTokens[next]; }
        return next;
    }

    // Split one over-budget line into contiguous <= budget pieces. Binary-search
    // the longest prefix that fits, repeat. Pieces concatenate back to the line.
    static async #splitLine(line: string, budget: number, countTokens: (t: string) => Promise<number>): Promise<string[]> {
        const pieces: string[] = [];
        let i = 0;
        while (i < line.length) {
            let lo = i + 1, hi = line.length, best = i + 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (await countTokens(line.slice(i, mid)) <= budget) { best = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            pieces.push(line.slice(i, best));
            i = best;
        }
        return pieces;
    }
}
