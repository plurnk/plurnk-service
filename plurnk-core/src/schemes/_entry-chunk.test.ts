import test from "node:test";
import assert from "node:assert/strict";
import EntryChunk from "./_entry-chunk.ts";

// Stub tokenizer: word count, async to mirror the real (framework) countTokens which
// returns a Promise. Per-line word counts sum exactly across a "\n" join (newlines
// are not words), so the budget invariant is checked exactly here.
const words = (t: string): number => (t.match(/\S+/g) ?? []).length;
const countTokens = (t: string): Promise<number> => Promise.resolve(words(t));

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

test("EntryChunk: empty content yields no chunks", async () => {
    assert.deepEqual(await EntryChunk.tile("", new Set(), 10, 0, countTokens), []);
});

test("EntryChunk: content that fits in budget is a single full-span chunk", async () => {
    const content = "alpha\nbeta\ngamma";
    const chunks = await EntryChunk.tile(content, new Set(), 10, 0, countTokens);
    assert.equal(chunks.length, 1);
    assert.deepEqual({ s: chunks[0].lineStart, e: chunks[0].lineEnd, t: chunks[0].text }, { s: 1, e: 3, t: content });
    assertLossless(content, chunks);
});

test("EntryChunk: multi-chunk tiling with no overlap is contiguous, lossless, within budget", async () => {
    const content = Array.from({ length: 9 }, (_, i) => `w${i + 1}`).join("\n");
    const chunks = await EntryChunk.tile(content, new Set(), 4, 0, countTokens);
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 4);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(chunks[i].lineStart, chunks[i - 1].lineEnd + 1, "no overlap → contiguous");
    }
});

test("EntryChunk: overlap re-covers trailing context, still lossless", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = await EntryChunk.tile(content, new Set(), 4, 0.5, countTokens);
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 4);
    let overlapped = false;
    for (let i = 1; i < chunks.length; i++) {
        assert.ok(chunks[i].lineStart <= chunks[i - 1].lineEnd, `chunk ${i} starts no later than prev end (no gap)`);
        if (chunks[i].lineStart <= chunks[i - 1].lineEnd) overlapped = true;
    }
    assert.ok(overlapped, "at least one boundary actually overlaps");
});

test("EntryChunk: a structural boundary within budget is the preferred cut", async () => {
    const content = "a\nb\nc\nd\ne\nf";
    const chunks = await EntryChunk.tile(content, new Set([3]), 4, 0, countTokens);
    assert.equal(chunks[0].lineEnd, 3, "closed at the boundary (line 3), not the budget edge (line 4)");
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 4);
});

test("EntryChunk: a single over-budget line is sub-split losslessly (no truncation)", async () => {
    const line = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const chunks = await EntryChunk.tile(line, new Set(), 10, 0, countTokens);
    assert.ok(chunks.length > 1, "giant line sub-split into multiple chunks");
    assert.ok(chunks.every((c) => c.lineStart === 1 && c.lineEnd === 1), "every sub-chunk tags the one line");
    assert.equal(chunks.map((c) => c.text).join(""), line, "sub-chunk texts reconstruct the line exactly");
    assertWithinBudget(chunks, 10);
});

test("EntryChunk: one giant line fans token validation across the host pool", async () => {
    let active = 0;
    let maxActive = 0;
    const parallelCounter = async (text: string): Promise<number> => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return text.length;
    };
    const line = "x".repeat(10_000);
    const chunks = await EntryChunk.tile(line, new Set(), 100, 0, parallelCounter);
    assert.equal(chunks.map((chunk) => chunk.text).join(""), line, "parallel pieces concatenate to the exact input");
    assert.ok(chunks.every((chunk) => chunk.text.length <= 100), "every validated piece respects the hard budget");
    assert.ok(maxActive > 1, "a single giant line occupies more than one tokenizer worker");
});

test("EntryChunk: a normal line followed by a giant line — both covered, all within budget", async () => {
    const content = "small\n" + Array.from({ length: 30 }, (_, i) => `b${i}`).join(" ");
    const chunks = await EntryChunk.tile(content, new Set(), 5, 0, countTokens);
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 5);
});

test("EntryChunk: no boundaries (prose) still tiles losslessly", async () => {
    const content = Array.from({ length: 25 }, (_, i) => `sentence number ${i}`).join("\n");
    const chunks = await EntryChunk.tile(content, new Set(), 7, 0.15, countTokens);
    assertLossless(content, chunks);
    assertWithinBudget(chunks, 7);
});

test("EntryChunk: invalid budget / overlap fail hard", async () => {
    await assert.rejects(EntryChunk.tile("x", new Set(), 0, 0, countTokens), /budget/);
    await assert.rejects(EntryChunk.tile("x", new Set(), -1, 0, countTokens), /budget/);
    await assert.rejects(EntryChunk.tile("x", new Set(), 10, 1, countTokens), /overlap/);
    await assert.rejects(EntryChunk.tile("x", new Set(), 10, -0.1, countTokens), /overlap/);
});
