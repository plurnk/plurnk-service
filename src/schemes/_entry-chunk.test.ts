import test from "node:test";
import assert from "node:assert/strict";
import EntryChunk from "./_entry-chunk.ts";

// Stub tokenizer: word count. Per-line word counts sum exactly across a "\n" join
// (newlines are not words), so the budget invariant is checked exactly here.
const words = (t: string): number => (t.match(/\S+/g) ?? []).length;

// Losslessness: every line 1..n is covered by some chunk, and no phantom lines.
const assertLossless = (content: string, chunks: { lineStart: number; lineEnd: number }[]): void => {
    const n = content.length === 0 ? 0 : content.split("\n").length;
    const covered = new Set<number>();
    for (const c of chunks) for (let l = c.lineStart; l <= c.lineEnd; l++) covered.add(l);
    for (let l = 1; l <= n; l++) assert.ok(covered.has(l), `line ${l}/${n} covered`);
    assert.equal(covered.size, n, `exactly ${n} distinct lines covered (no phantom/out-of-range lines)`);
};

const assertWithinBudget = (chunks: { seq: number; text: string }[], budget: number): void => {
    for (const c of chunks) assert.ok(words(c.text) <= budget, `chunk ${c.seq}: ${words(c.text)} words <= budget ${budget}`);
    chunks.forEach((c, i) => assert.equal(c.seq, i, "seq is contiguous from 0"));
};

test("EntryChunk: empty content yields no chunks", () => {
    assert.deepEqual(EntryChunk.tile("", new Set(), 10, 0, words), []);
});

test("EntryChunk: content that fits in budget is a single full-span chunk", () => {
    const content = "alpha\nbeta\ngamma";
    const chunks = EntryChunk.tile(content, new Set(), 10, 0, words);
    assert.equal(chunks.length, 1);
    assert.deepEqual({ s: chunks[0].lineStart, e: chunks[0].lineEnd, t: chunks[0].text }, { s: 1, e: 3, t: content });
    assertLossless(content, chunks);
});

test("EntryChunk: multi-chunk tiling with no overlap is contiguous, lossless, within budget", () => {
    const content = Array.from({ length: 9 }, (_, i) => `w${i + 1}`).join("\n"); // 9 lines, 1 word each
    const chunks = EntryChunk.tile(content, new Set(), 4, 0, words);
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 4);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(chunks[i].lineStart, chunks[i - 1].lineEnd + 1, "no overlap → contiguous");
    }
});

test("EntryChunk: overlap re-covers trailing context, still lossless", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = EntryChunk.tile(content, new Set(), 4, 0.5, words); // want ≈ 2 lines of overlap
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 4);
    let overlapped = false;
    for (let i = 1; i < chunks.length; i++) {
        assert.ok(chunks[i].lineStart <= chunks[i - 1].lineEnd, `chunk ${i} starts no later than prev end (no gap)`);
        if (chunks[i].lineStart <= chunks[i - 1].lineEnd) overlapped = true;
    }
    assert.ok(overlapped, "at least one boundary actually overlaps");
});

test("EntryChunk: a structural boundary within budget is the preferred cut", () => {
    const content = "a\nb\nc\nd\ne\nf"; // 6 lines, 1 word each; budget 4 could take 1-4
    const chunks = EntryChunk.tile(content, new Set([3]), 4, 0, words); // boundary after line 3
    assert.equal(chunks[0].lineEnd, 3, "closed at the boundary (line 3), not the budget edge (line 4)");
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 4);
});

test("EntryChunk: a single over-budget line is sub-split losslessly (no truncation)", () => {
    const line = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" "); // ONE line, 50 words
    const chunks = EntryChunk.tile(line, new Set(), 10, 0, words);
    assert.ok(chunks.length > 1, "giant line sub-split into multiple chunks");
    assert.ok(chunks.every((c) => c.lineStart === 1 && c.lineEnd === 1), "every sub-chunk tags the one line");
    assert.equal(chunks.map((c) => c.text).join(""), line, "sub-chunk texts reconstruct the line exactly");
    assertWithinBudget(chunks, 10);
});

test("EntryChunk: a normal line followed by a giant line — both covered, all within budget", () => {
    const content = "small\n" + Array.from({ length: 30 }, (_, i) => `b${i}`).join(" ");
    const chunks = EntryChunk.tile(content, new Set(), 5, 0, words);
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 5);
});

test("EntryChunk: no boundaries (prose) still tiles losslessly", () => {
    const content = Array.from({ length: 25 }, (_, i) => `sentence number ${i}`).join("\n"); // 3 words/line
    const chunks = EntryChunk.tile(content, new Set(), 7, 0.15, words);
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 7);
});

test("EntryChunk: invalid budget / overlap fail hard", () => {
    assert.throws(() => EntryChunk.tile("x", new Set(), 0, 0, words), /budget/);
    assert.throws(() => EntryChunk.tile("x", new Set(), -1, 0, words), /budget/);
    assert.throws(() => EntryChunk.tile("x", new Set(), 10, 1, words), /overlap/);
    assert.throws(() => EntryChunk.tile("x", new Set(), 10, -0.1, words), /overlap/);
});
