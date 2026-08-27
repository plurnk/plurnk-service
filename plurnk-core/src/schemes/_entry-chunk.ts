// The chunker for the `~query` semantic dialect — lossless, structure-preferring,
// budget-driven. Service-owned: the embedder plugin only embeds text + reports
// its window/tokenizer; how an entry is sliced to fit that window is the dialect's
// job, and the dialect is ours.
//
// tile() partitions an entry's body into chunks each <= `budget` tokens, COVERING
// EVERY LINE (losslessness — no truncation, ever), preferring to break at a
// `boundaries` line (an &graph symbol edge) when one falls within budget. Pure: no
// I/O, no DB, no plugin — `countTokens` is injected (the embedder's real
// tokenizer selected by the pass-wide semantic plan in production; a stub in
// tests). Every tunable is a parameter — no constants live here.

import { availableParallelism } from "node:os";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";

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

        const lines = TextCoordinates.logicalLines(content).map(
            ({ start, end }) => content.slice(start, end),
        );
        const n = lines.length;
        // The budget is checked against the SUM of per-line counts. Cross-line BPE
        // merges only ever shrink the true token count, so the sum is a safe upper
        // bound: a chunk that passes the sum check is guaranteed <= budget in the
        // real tokenizer. Lossless, and only O(n) countTokens calls.
        let planned = 0;
        let nextLine = 0;
        const lineTokens = new Array<number>(lines.length);
        const counter = async (): Promise<void> => {
            while (nextLine < lines.length) {
                const index = nextLine++;
                lineTokens[index] = await countTokens(lines[index]);
                planned++;
                onPlanningProgress?.({ completed: planned, total: lines.length });
            }
        };
        // Keep only a host-relative window of token-count promises alive. Mapping a
        // 400k-line tokenizer JSON through Promise.all retained hundreds of thousands
        // of promises per concurrent entry and could exhaust V8 before embedding began.
        await Promise.all(Array.from(
            { length: Math.min(lines.length, availableParallelism() * 2) },
            () => counter(),
        ));

        const chunks: ChunkSpec[] = [];
        let start = 0;
        while (start < n) {
            // A single line larger than the whole budget can never fit — sub-split
            // it (the one place we ever cut mid-line). This is what makes "no
            // truncation, ever" hold even for a minified blob or a giant literal.
            if (lineTokens[start] > budget) {
                for (const piece of await EntryChunk.#splitLine(lines[start], lineTokens[start], budget, countTokens)) {
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
                text: lines.slice(start, closeAt + 1).join(""),
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

    // Split one over-budget line into contiguous <= budget pieces. The former
    // longest-prefix loop awaited every tokenizer probe serially, leaving one
    // core hot for hours on a giant one-line JSON document. Partition from the
    // already-known whole-line token count, validate every candidate through a
    // bounded parallel counter, and recursively repartition only candidates
    // whose local token density still exceeds the ceiling.
    static async #splitLine(
        line: string,
        totalTokens: number,
        budget: number,
        countTokens: (t: string) => Promise<number>,
    ): Promise<string[]> {
        const partition = (text: string, count: number): string[] => {
            const n = Math.min(text.length, Math.max(2, count));
            const out: string[] = [];
            let start = 0;
            for (let i = 1; i <= n; i++) {
                let end = i === n ? text.length : Math.floor((text.length * i) / n);
                // Never split a UTF-16 surrogate pair across independently
                // tokenized pieces; concatenation and embedding both stay exact.
                const prior = text.charCodeAt(end - 1);
                const next = text.charCodeAt(end);
                if (prior >= 0xD800 && prior <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end++;
                if (prior === 0x0D && next === 0x0A) end++;
                if (end > start) out.push(text.slice(start, end));
                start = end;
            }
            return out;
        };
        const countAll = async (items: string[]): Promise<number[]> => {
            const counts = new Array<number>(items.length);
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < items.length) {
                    const index = next++;
                    counts[index] = await countTokens(items[index]);
                }
            };
            await Promise.all(Array.from(
                { length: Math.min(items.length, availableParallelism() * 2) },
                () => worker(),
            ));
            return counts;
        };

        let pieces = partition(line, Math.ceil(totalTokens / budget));
        while (true) {
            const counts = await countAll(pieces);
            let changed = false;
            const next: string[] = [];
            for (let i = 0; i < pieces.length; i++) {
                const piece = pieces[i];
                const tokens = counts[i];
                if (tokens <= budget) {
                    next.push(piece);
                    continue;
                }
                if (piece.length <= 1) {
                    throw new RangeError(`one code unit tokenizes to ${tokens} tokens, exceeding chunk budget ${budget}`);
                }
                const repartitioned = partition(piece, Math.ceil(tokens / budget));
                if (repartitioned.length === 1 && repartitioned[0] === piece) {
                    throw new RangeError(`one indivisible text unit tokenizes to ${tokens} tokens, exceeding chunk budget ${budget}`);
                }
                next.push(...repartitioned);
                changed = true;
            }
            pieces = next;
            if (!changed) return pieces;
        }
    }
}
