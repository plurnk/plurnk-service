// {§edit-pattern} {§kill-pattern} {§copy-move-pattern} — pure expansion of matcher evidence into edits.
import test from "node:test";
import assert from "node:assert/strict";
import PatternEdits from "./pattern-edits.ts";

const region = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ region: { startLine, startColumn, endLine, endColumn } });

test("lines: every line a match touches, once, in order, inside the bounds", () => {
    const evidence = [region(4, 1, 5, 3), region(2, 2, 2, 4), region(4, 5, 4, 6)];
    assert.deepEqual(PatternEdits.lines(evidence, null), [2, 4, 5]);
    assert.deepEqual(PatternEdits.lines(evidence, { from: 3, to: 4 }), [4]);
    assert.deepEqual(PatternEdits.lines([{}], null), []);
});

test("spans: a regex keeps its evidence span and refuses one across a line break", () => {
    const regex = { dialect: "regex" as const, raw: "/a/", pattern: "a", flags: "" };
    assert.deepEqual(PatternEdits.spans(regex, "xa\nab", [region(2, 1, 2, 2), region(1, 2, 1, 3)], null), [
        { line: 1, startColumn: 2, endLine: 1, endColumn: 3 },
        { line: 2, startColumn: 1, endLine: 2, endColumn: 2 },
    ]);
    assert.deepEqual(PatternEdits.spans(regex, "a\na", [region(1, 1, 2, 2)], null), { error: "EDIT spans are line-limited; the pattern matched across a line break." });
});

test("spans: a literal glob is each occurrence on a matched line; a metacharacter glob is the whole line", () => {
    const content = "foo bar foo\nnone\n\u{1F600}foo";
    const evidence = [region(1, 1, 1, 12), region(3, 1, 3, 5)];
    assert.deepEqual(PatternEdits.spans({ dialect: "glob", raw: "foo" }, content, evidence, null), [
        { line: 1, startColumn: 1, endLine: 1, endColumn: 4 },
        { line: 1, startColumn: 9, endLine: 1, endColumn: 12 },
        { line: 3, startColumn: 2, endLine: 3, endColumn: 5 },
    ]);
    assert.deepEqual(PatternEdits.spans({ dialect: "glob", raw: "fo*" }, content, evidence, { from: 3, to: 3 }), [
        { line: 3, startColumn: 1, endLine: 3, endColumn: 5 },
    ]);
});

test("spans: a node dialect keeps the node's whole region; a resource dialect names no spans", () => {
    assert.deepEqual(PatternEdits.spans({ dialect: "xpath", raw: "//book" }, "", [region(2, 1, 5, 10)], null), [
        { line: 2, startColumn: 1, endLine: 5, endColumn: 10 },
    ]);
    assert.deepEqual(PatternEdits.spans({ dialect: "fts", raw: "~x" }, "", [], null), { error: "EDIT replaces text spans; a fts pattern selects resources, not spans." });
});

test("replacements and deletions become coordinate edits; touchedLines covers regions", () => {
    const edits = PatternEdits.replacements([{ line: 2, startColumn: 1, endLine: 4, endColumn: 3 }], "x");
    assert.deepEqual(edits, [{ marker: { marks: [2, 1, 4, 3] }, body: "x" }]);
    assert.deepEqual(PatternEdits.deletions([3, 7]), [{ marker: { marks: [3] }, body: "" }, { marker: { marks: [7] }, body: "" }]);
    assert.deepEqual(PatternEdits.touchedLines([...edits, ...PatternEdits.deletions([7])]), [2, 3, 4, 7]);
});

test("bounds: one line, an inclusive range with -1 as the last line, a region; sentinels are refused", () => {
    assert.equal(PatternEdits.bounds(undefined, 9), null);
    assert.deepEqual(PatternEdits.bounds([3], 9), { from: 3, to: 3 });
    assert.deepEqual(PatternEdits.bounds([2, -1], 9), { from: 2, to: 9 });
    assert.deepEqual(PatternEdits.bounds([2, 1, 4, 5], 9), { from: 2, to: 4 });
    assert.deepEqual(PatternEdits.bounds([-1], 9), { error: "A pattern needs a line to match; <0> and <-1> name a position, not a line." });
    assert.deepEqual(PatternEdits.bounds([0, 3], 9), { error: "A pattern needs an inclusive line range; <0> and <-1> name a position, not a line." });
});

test("lineLimited: a regex gains the m flag once; other dialects pass through", () => {
    assert.deepEqual(PatternEdits.lineLimited({ dialect: "regex", raw: "/a/i", pattern: "a", flags: "i" }), { dialect: "regex", raw: "/a/i", pattern: "a", flags: "im" });
    const anchored = { dialect: "regex" as const, raw: "/a/m", pattern: "a", flags: "m" };
    assert.equal(PatternEdits.lineLimited(anchored), anchored);
    const glob = { dialect: "glob" as const, raw: "a" };
    assert.equal(PatternEdits.lineLimited(glob), glob);
});
