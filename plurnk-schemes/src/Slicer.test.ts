import assert from "node:assert/strict";
import test from "node:test";
import Slicer from "./Slicer.ts";

const TEXT = "alpha\nbeta\ngamma\ndelta\n";

const withoutRange = (result: ReturnType<typeof Slicer.lines>): Omit<ReturnType<typeof Slicer.lines>, "range"> => {
    const { range: _range, ...selection } = result;
    return selection;
};

test("lines selects line shorthand with stable source numbering", () => {
    assert.deepEqual(
        withoutRange(Slicer.lines(TEXT, { marks: [2] })),
        {
            status: 200,
            text: "beta",
            startLine: 2,
            region: {
                startLine: 2,
                startColumn: 1,
                endLine: 2,
                endColumn: 5,
            },
        },
    );
    assert.deepEqual(
        withoutRange(Slicer.lines(TEXT, { marks: [2, 3] })),
        {
            status: 200,
            text: "beta\ngamma",
            startLine: 2,
            region: {
                startLine: 2,
                startColumn: 1,
                endLine: 3,
                endColumn: 6,
            },
        },
    );
    assert.deepEqual(
        withoutRange(Slicer.lines(TEXT, { marks: [1, -1] })),
        {
            status: 200,
            text: "alpha\nbeta\ngamma\ndelta",
            startLine: 1,
            region: {
                startLine: 1,
                startColumn: 1,
                endLine: 4,
                endColumn: 6,
            },
        },
    );
    assert.deepEqual(
        Slicer.lines(TEXT, { marks: [1, 1_000] }).range,
        {
            unit: "line",
            total: 4,
            requested: [1, 1_000],
            returned: [1, 4],
        },
    );
    assert.deepEqual(
        withoutRange(Slicer.lines("", { marks: [1, -1] })),
        {
            status: 200,
            text: "",
            startLine: 1,
            region: {
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 1,
            },
        },
    );
});

test("lines treats insertion sentinels as empty selections", () => {
    assert.deepEqual(
        withoutRange(Slicer.lines(TEXT, { marks: [0] })),
        { status: 200, text: "", startLine: undefined },
    );
    assert.deepEqual(
        withoutRange(Slicer.lines(TEXT, { marks: [-1] })),
        { status: 200, text: "", startLine: undefined },
    );
});

test("lines reports the requested and available extent on failure", () => {
    const result = Slicer.lines(TEXT, { marks: [99] });
    assert.equal(result.status, 416);
    assert.deepEqual(result.range, {
        unit: "line",
        total: 4,
        requested: [99, 99],
    });
    assert.deepEqual(result.problem?.range, result.range);
    assert.equal(result.problem?.retryable, false);
});

test("a first-page line range selects an empty text resource completely", () => {
    const result = Slicer.lines("", { marks: [1, 16] });
    assert.equal(result.status, 200);
    assert.equal(result.text, "");
    assert.deepEqual(result.range, {
        unit: "line",
        total: 0,
        requested: [1, 16],
    });
    assert.equal(Slicer.lines("", { marks: [1] }).status, 416);
    assert.equal(Slicer.lines("", { marks: [2, 16] }).status, 416);
});

test("lines addresses exact regions in Unicode code points", () => {
    assert.deepEqual(
        Slicer.lines("a😀b\nnext", { marks: [1, 2, 1, 3] }),
        {
            status: 200,
            text: "😀",
            startLine: 1,
            region: {
                startLine: 1,
                startColumn: 2,
                endLine: 1,
                endColumn: 3,
            },
        },
    );
    assert.deepEqual(
        Slicer.lines("ab\r\ncd\r\n", { marks: [1, 2, 2, 2] }),
        {
            status: 200,
            text: "b\r\nc",
            startLine: 1,
            region: {
                startLine: 1,
                startColumn: 2,
                endLine: 2,
                endColumn: 2,
            },
        },
    );
});

test("lines tolerates three coordinates and reports the exact canonical region", () => {
    const oneLine = Slicer.lines("abc", { marks: [1, 2, 1] });
    assert.equal(oneLine.status, 200);
    assert.equal(oneLine.text, "bc");
    assert.deepEqual(oneLine.region, {
        startLine: 1,
        startColumn: 2,
        endLine: 1,
        endColumn: 4,
    });
    assert.deepEqual(oneLine.scopeNormalizations, [{
        requested: [1, 2, 1],
        canonical: [1, 2, 1, 4],
    }]);

    const multiLine = Slicer.lines("one\ntwo\nthree\nfour", { marks: [2, 2, 3] });
    assert.equal(multiLine.status, 200);
    assert.equal(multiLine.text, "wo\nthree");
    assert.deepEqual(multiLine.scopeNormalizations, [{
        requested: [2, 2, 3],
        canonical: [2, 2, 3, 6],
    }]);

    const clampedEnd = Slicer.lines("abc", { marks: [1, 2, 9] });
    assert.equal(clampedEnd.status, 200);
    assert.equal(clampedEnd.text, "bc");
    assert.deepEqual(clampedEnd.scopeNormalizations, [{
        requested: [1, 2, 9],
        canonical: [1, 2, 1, 4],
    }]);

    const badStart = Slicer.lines("abc", { marks: [1, 9, 1] });
    assert.equal(badStart.status, 416);
    assert.deepEqual(badStart.problem?.requestedCoordinates, [1, 9, 1]);
});

test("lines rejects unaddressable exact regions", () => {
    // Line out of range — no clamp applies.
    const noLine = Slicer.lines("a😀b", { marks: [99, 1, 99, 2] });
    assert.equal(noLine.status, 416);
    assert.deepEqual(noLine.problem?.requestedCoordinates, [99, 1, 99, 2]);

    // Start-column overshoot stays an error — the intent is ambiguous.
    const badStart = Slicer.lines("a😀b", { marks: [1, 5, 1, 6] });
    assert.equal(badStart.status, 416);
    assert.deepEqual(badStart.problem?.requestedCoordinates, [1, 5, 1, 6]);
});

test("harmless exact end-bound overshoots clamp to available content", () => {
    // {§slicer-text-algebra} — <4,1,4,50> on a 30-char line serves the whole line.
    const clamped = Slicer.lines("one\ntwo\nthree\nfour", { marks: [4, 1, 4, 50] });
    assert.equal(clamped.status, 200);
    assert.equal(clamped.text, "four");
    assert.deepEqual(clamped.region, { startLine: 4, startColumn: 1, endLine: 4, endColumn: 5 });

    const pastEof = Slicer.lines("one\ntwo", { marks: [1, 1, 1_000, 1_000] });
    assert.equal(pastEof.status, 200);
    assert.equal(pastEof.text, "one\ntwo");
    assert.deepEqual(pastEof.region, { startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 });

    // Start-column overshoot stays an error — the intent is ambiguous.
    const badStart = Slicer.lines("one\ntwo", { marks: [1, 50, 1, 60] });
    assert.equal(badStart.status, 416);
});

test("lineMarkerEdit applies and reports the tolerated three-coordinate region", () => {
    const applied = Slicer.lineMarkerEdit("one\ntwo\nthree", { marks: [2, 2, 2] }, "X");
    assert.equal(applied.status, 200);
    assert.equal(applied.result, "one\ntX\nthree");
    assert.deepEqual(applied.scopeNormalizations, [{
        requested: [2, 2, 2],
        canonical: [2, 2, 2, 4],
    }]);
});

test("linesRaw preserves selected source separators", () => {
    assert.deepEqual(
        Slicer.linesRaw("alpha\r\nbeta\r\n", { marks: [1] }),
        { status: 200, text: "alpha\r\n", startLine: 1 },
    );
    assert.deepEqual(
        Slicer.linesRaw("alpha\r\nbeta\r\n", { marks: [1, -1] }),
        { status: 200, text: "alpha\r\nbeta\r\n", startLine: 1 },
    );
});

test("lineMarkerEdit implements line replacement, deletion, prepend, and append", () => {
    assert.equal(
        Slicer.lineMarkerEdit(TEXT, { marks: [2] }, "BETA").result,
        "alpha\nBETA\ngamma\ndelta\n",
    );
    assert.equal(
        Slicer.lineMarkerEdit(TEXT, { marks: [2, 3] }, "").result,
        "alpha\ndelta\n",
    );
    assert.equal(
        Slicer.lineMarkerEdit(TEXT, { marks: [0] }, "ZERO").result,
        "ZERO\nalpha\nbeta\ngamma\ndelta\n",
    );
    assert.equal(
        Slicer.lineMarkerEdit(TEXT, { marks: [-1] }, "OMEGA").result,
        "alpha\nbeta\ngamma\ndelta\nOMEGA\n",
    );
});

test("lineMarkerEdit preserves the source newline convention", () => {
    assert.equal(
        Slicer.lineMarkerEdit("one\r\ntwo\r\n", { marks: [1] }, "ONE").result,
        "ONE\r\ntwo\r\n",
    );
    assert.equal(
        Slicer.lineMarkerEdit("one\rtwo\r", { marks: [-1] }, "three").result,
        "one\rtwo\rthree\r",
    );
});

test("lineMarkerEdit handles empty content and rejects fractional line scopes", () => {
    assert.equal(
        Slicer.lineMarkerEdit("", { marks: [0] }, "first").result,
        "first",
    );
    const fractional = Slicer.lineMarkerEdit("one\ntwo\n", { marks: [1.5] }, "middle");
    assert.equal(fractional.status, 416);
    assert.match(fractional.problem?.detail ?? "", /integer coordinates/);
});

test("lineMarkerEdit inserts and replaces exact regions without line coercion", () => {
    assert.equal(
        Slicer.lineMarkerEdit("alpha", { marks: [1, 3, 1, 3] }, "X").result,
        "alXpha",
    );
    assert.equal(
        Slicer.lineMarkerEdit("a😀b", { marks: [1, 2, 1, 3] }, "X").result,
        "aXb",
    );
    assert.equal(
        Slicer.lineMarkerEdit("ab\r\ncd\r\n", { marks: [1, 2, 2, 2] }, "X").result,
        "aXd\r\n",
    );
    assert.equal(
        Slicer.lineMarkerEdit("one\n", { marks: [2, 1, 2, 1] }, "two").result,
        "one\ntwo",
    );
    assert.equal(Slicer.lines("one\n", { marks: [2] }).status, 416);
});

test("page keeps ordered-result pagination distinct from text coordinates", () => {
    const bounded = Slicer.page(["a", "b", "c", "d"], { marks: [1, 2] });
    assert.deepEqual(bounded.items, ["a", "b"]);
    assert.deepEqual(bounded.range, {
        unit: "result",
        total: 4,
        requested: [1, 2],
        returned: [1, 2],
    });
    const allEmpty = Slicer.page([], { marks: [1, -1] });
    assert.deepEqual(allEmpty.items, []);
    assert.deepEqual(allEmpty.range, {
        unit: "result",
        total: 0,
        requested: [1, -1],
    });
    const allowedEmpty = Slicer.page([], { marks: [30, 100] }, {});
    assert.deepEqual(allowedEmpty.items, []);
    assert.deepEqual(allowedEmpty.range, {
        unit: "result",
        total: 0,
        requested: [30, 100],
    });

    const failure = Slicer.page(["a", "b", "c"], { marks: [4, -1] });
    assert.equal(failure.status, 416);
    assert.deepEqual(failure.range, {
        unit: "result",
        total: 3,
        requested: [4, -1],
    });
});

test("page rejects fractional result positions instead of rounding", () => {
    const result = Slicer.page(["a", "b"], { marks: [0.5] });
    assert.equal(result.status, 416);
    assert.equal(result.range?.requested[0], 0.5);
});

test("page rejects text-shaped and threshold-prefixed coordinate lists", () => {
    for (const marks of [[1, 1, 1, 1], [0.7, 1, 1, 1, 1]]) {
        const result = Slicer.page(["a", "b"], { marks: marks as [number, ...number[]] });
        assert.equal(result.status, 416);
        assert.match(result.problem?.detail ?? "", /requires one position or an inclusive two-position range/);
        assert.deepEqual(result.problem?.requestedPositions, marks);
    }
});

test("lineMarkerEditBatch applies disjoint edits against one snapshot", () => {
    const edits = [
        { marker: { marks: [2] as [number] }, body: "TWO\n2.5" },
        { marker: { marks: [4] as [number] }, body: "FOUR" },
    ];
    const forward = Slicer.lineMarkerEditBatch(TEXT, edits);
    const reverse = Slicer.lineMarkerEditBatch(TEXT, edits.toReversed());
    assert.equal(forward.status, 200);
    assert.equal(forward.result, "alpha\nTWO\n2.5\ngamma\nFOUR\n");
    assert.equal(reverse.result, forward.result);
});

test("lineMarkerEditBatch preserves every tolerated normalization in authored order", () => {
    const result = Slicer.lineMarkerEditBatch("alpha\nbeta\ngamma\ndelta", [
        { marker: { marks: [1, 2, 1] }, body: "A" },
        { marker: { marks: [3, 2, 3] }, body: "G" },
    ]);
    assert.equal(result.status, 200);
    assert.equal(result.result, "aA\nbeta\ngG\ndelta");
    assert.deepEqual(result.scopeNormalizations, [
        { requested: [1, 2, 1], canonical: [1, 2, 1, 6] },
        { requested: [3, 2, 3], canonical: [3, 2, 3, 6] },
    ]);
});

test("lineMarkerEditBatch composes disjoint line and exact regions", () => {
    const result = Slicer.lineMarkerEditBatch("abcde\nsecond\nthird\n", [
        { marker: { marks: [1, 2, 1, 3] }, body: "B" },
        { marker: { marks: [3] }, body: "THIRD" },
    ]);
    assert.equal(result.status, 200);
    assert.equal(result.result, "aBcde\nsecond\nTHIRD\n");
});

test("lineMarkerEditBatch rejects every kind of overlap atomically", () => {
    const rangeOverlap = Slicer.lineMarkerEditBatch(TEXT, [
        { marker: { marks: [2, 3] }, body: "middle" },
        { marker: { marks: [3, 4] }, body: "tail" },
    ]);
    assert.equal(rangeOverlap.status, 409);
    assert.equal(rangeOverlap.result, undefined);
    assert.equal(rangeOverlap.problem?.detail, "Two EDIT regions overlap.");
    assert.deepEqual(rangeOverlap.problem?.conflictingRegions, [[2, 3], [3, 4]]);
    assert.equal(rangeOverlap.problem?.conflictingRanges, undefined, "one coordinate representation owns the conflict");

    const insertionOverlap = Slicer.lineMarkerEditBatch("abc", [
        { marker: { marks: [1, 2, 1, 2] }, body: "X" },
        { marker: { marks: [1, 2, 1, 2] }, body: "Y" },
    ]);
    assert.equal(insertionOverlap.status, 409);
    assert.equal(insertionOverlap.result, undefined);
    assert.deepEqual(insertionOverlap.problem?.conflictingRegions, [
        [1, 2, 1, 2],
        [1, 2, 1, 2],
    ]);
});

test("lineMarkerEditBatch rejects a whole-resource replacement mixed with another edit", () => {
    const result = Slicer.lineMarkerEditBatch("one\ntwo\n", [
        { marker: { marks: [1, -1] }, body: "all" },
        { marker: { marks: [-1] }, body: "tail" },
    ]);
    assert.equal(result.status, 409);
    assert.equal(result.problem?.editCount, 2);
});

test("an empty result set satisfies any well-formed page — zero matches is a 200, not a 416 (#425 F9)", () => {
    for (const marks of [[1, 100], [1, 16], [1, -1], [17, 29], [5], [0, -1]] as const) {
        const page = Slicer.page([], { marks: [...marks] as [number, ...number[]] }, { unit: "resource" });
        assert.equal(page.status, 200, `<${marks.join(",")}>`);
        assert.deepEqual(page.items, []);
        assert.equal(page.range?.total, 0);
    }
    const inverted = Slicer.page([], { marks: [5, 3] }, { unit: "resource" });
    assert.equal(inverted.status, 416, "an inverted range is the one unsatisfiable page");
});

test("an overlap receipt carries the whole conflict graph, the clean regions, and the applied count (#428)", () => {
    const six = "a\nb\nc\nd\ne\nf\n";
    const result = Slicer.lineMarkerEditBatch(six, [
        { marker: { marks: [1, 4] }, body: "outer" },
        { marker: { marks: [2, 2] }, body: "inner-1" },
        { marker: { marks: [3, 3] }, body: "inner-2" },
        { marker: { marks: [6, 6] }, body: "clean" },
    ]);
    assert.equal(result.status, 409);
    assert.equal(result.problem?.detail, "Two EDIT regions overlap.");
    assert.deepEqual(result.problem?.conflictingRegions, [[1, 4], [2, 2]], "the first pair keeps its historical field");
    assert.deepEqual(result.problem?.conflicts, [
        { regions: [[1, 4], [2, 2]], relation: "one contains the other" },
        { regions: [[1, 4], [3, 3]], relation: "one contains the other" },
    ]);
    assert.deepEqual(result.problem?.cleanRegions, [[6, 6]]);
    assert.equal(result.problem?.editCount, 4);
    assert.equal(result.problem?.applied, 0);
    assert.match(String(result.problem?.recovery), /^2 conflicting pairs \(one contains the other\); 1 of 4 regions are clean; 0 of 4 were applied\./);
});
