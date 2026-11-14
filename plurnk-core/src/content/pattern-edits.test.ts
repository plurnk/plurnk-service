// {§edit-pattern} {§op-invariants} {§copy} — pure expansion of matcher evidence into edits.
import test from "node:test";
import assert from "node:assert/strict";
import PatternEdits from "./pattern-edits.ts";
import { editReceipt } from "./edit-receipt.ts";

const region = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ region: { startLine, startColumn, endLine, endColumn } });

test("{§edit-pattern} lines: every line a match touches, once, in order, inside the bounds", () => {
    const evidence = [region(4, 1, 5, 3), region(2, 2, 2, 4), region(4, 5, 4, 6)];
    assert.deepEqual(PatternEdits.lines(evidence, null), [2, 4, 5]);
    assert.deepEqual(PatternEdits.lines(evidence, { from: 3, to: 4 }), [4]);
    assert.deepEqual(PatternEdits.lines([{}], null), []);
});

test("{§edit-pattern} spans: evidence retains exact coordinates across lines and sorts into source order", () => {
    assert.deepEqual(PatternEdits.spans([region(2, 1, 2, 2), region(1, 2, 1, 3), region(3, 1, 5, 4)], null), [
        { startLine: 1, startColumn: 2, endLine: 1, endColumn: 3 },
        { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 },
        { startLine: 3, startColumn: 1, endLine: 5, endColumn: 4 },
    ]);
});

test("{§edit-pattern} spans: a coordinate scope admits whole matches and never clips them", () => {
    const evidence = [region(1, 1, 1, 4), region(1, 9, 1, 12), region(3, 2, 3, 5)];
    assert.deepEqual(PatternEdits.spans(evidence, region(1, 8, 3, 4).region), [
        { startLine: 1, startColumn: 9, endLine: 1, endColumn: 12 },
    ]);
});

test("{§edit-pattern} text: exact disjoint spans preserve spelling, Unicode, and line endings without invented separators", () => {
    const content = "😀foo\r\nbar\rbaz\nlast";
    const spans = [region(1, 2, 2, 4).region, region(4, 2, 4, 5).region];
    assert.equal(PatternEdits.text(content, spans), "foo\r\nbarast");
});

test("{§edit-pattern} replacements and deletions share exact coordinate edits; touchedLines covers regions", () => {
    const spans = [region(2, 1, 4, 3).region];
    const edits = PatternEdits.replacements(spans, "x");
    assert.deepEqual(edits, [{ marker: { marks: [2, 1, 4, 3] }, body: "x" }]);
    assert.deepEqual(PatternEdits.replacements(spans, ""), [{ marker: { marks: [2, 1, 4, 3] }, body: "" }]);
    assert.deepEqual(PatternEdits.touchedLines(edits), [2, 3, 4]);
    assert.deepEqual(PatternEdits.touchedLines(PatternEdits.replacements([region(2, 1, 4, 1).region], "")), [2, 3]);
});

test("{§edit-pattern} bounds: scopes use ordinary text coordinates, including columns and the last logical line", () => {
    const content = "aaaa\nbbbb\ncccc\ndddd";
    assert.equal(PatternEdits.bounds(undefined, content), null);
    assert.deepEqual(PatternEdits.bounds([3], content), region(3, 1, 4, 1).region);
    assert.deepEqual(PatternEdits.bounds([2, -1], content), region(2, 1, 4, 5).region);
    assert.deepEqual(PatternEdits.bounds([2, 2, 4, 3], content), region(2, 2, 4, 3).region);
    assert.deepEqual(PatternEdits.bounds([-1], content), { error: "A pattern scope selects source text, not a prepend or append position." });
});

test("{§edit-pattern} lineAnchored: a regex gains the m flag once; other dialects pass through", () => {
    assert.deepEqual(PatternEdits.lineAnchored({ dialect: "regex", raw: "/a/i", pattern: "a", flags: "i" }), { dialect: "regex", raw: "/a/i", pattern: "a", flags: "im" });
    const anchored = { dialect: "regex" as const, raw: "/a/m", pattern: "a", flags: "m" };
    assert.equal(PatternEdits.lineAnchored(anchored), anchored);
    const glob = { dialect: "glob" as const, raw: "a" };
    assert.equal(PatternEdits.lineAnchored(glob), glob);
});

test("{§edit-pattern} hasUnanchoredEmptyRegexMatch: refuses interior empty matches while admitting boundary and lookaround assertions", () => {
    const regex = (pattern: string, flags = "") => ({ dialect: "regex" as const, raw: `/${pattern}/${flags}`, pattern, flags });
    for (const bad of [
        regex("foo||bar"),
        regex("|foo"),
        regex("foo|"),
        regex("(?:)"),
        regex("x*"),
        regex("a?"),
        regex("(?!foo)"),
        regex("\\B"),
    ]) {
        assert.equal(PatternEdits.hasUnanchoredEmptyRegexMatch(bad), true, `expected unanchored empty match: ${bad.raw}`);
    }
    for (const ok of [
        regex("^"),
        regex("$"),
        regex("^$"),
        regex("^|$"),
        regex("^\\s*"),
        regex("\\s*$"),
        regex("(?=foo)"),
        regex("(?<=foo)"),
        regex("\\b"),
        regex("\\[\\$\\{id \\|\\| 'x'\\}\\]"),
        regex("foo|bar"),
        { dialect: "glob" as const, raw: "*" },
    ]) {
        assert.equal(PatternEdits.hasUnanchoredEmptyRegexMatch(ok), false, `expected valid pattern: ${ok.raw}`);
    }
});

test("{§edit-pattern} compactReceipt: compacts attrs.editReceipt to boundary effects and records patternMatched", () => {
    const batch = editReceipt(
        "a\nb\nc\nd\n",
        "A\nB\nC\nD\n",
        [
            { marker: { marks: [1] }, body: "A" },
            { marker: { marks: [2] }, body: "B" },
            { marker: { marks: [3] }, body: "C" },
            { marker: { marks: [4] }, body: "D" },
        ],
    );
    const compacted = PatternEdits.compactReceipt({
        status: 202,
        editReceipt: batch,
        attrs: { path: "/tmp/demo.txt", editReceipt: batch },
    }, 4);
    assert.equal(compacted.matched, 4);
    assert.equal((compacted.receipt as { effect?: { requested?: string } })?.effect?.requested, "<1>");
    assert.equal((compacted.last as { requested?: string })?.requested, "<4>");
    const attrs = compacted.attrs as { patternMatched?: number; editReceipt?: { effects: Array<{ requested: string }> } };
    assert.equal(attrs.patternMatched, 4);
    assert.deepEqual(attrs.editReceipt?.effects.map((e) => e.requested), ["<1>", "<4>"]);
});
