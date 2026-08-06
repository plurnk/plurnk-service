import assert from "node:assert/strict";
import test from "node:test";
import Slicer from "./Slicer.ts";

const TEXT = "alpha\nbeta\ngamma\ndelta\n";

test("lines selects line shorthand with stable source numbering", () => {
    assert.deepEqual(
        Slicer.lines(TEXT, { marks: [2] }),
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
        Slicer.lines(TEXT, { marks: [2, 3] }),
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
        Slicer.lines(TEXT, { marks: [1, -1] }),
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
        Slicer.lines("", { marks: [1, -1] }),
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
        Slicer.lines(TEXT, { marks: [0] }),
        { status: 200, text: "", startLine: undefined },
    );
    assert.deepEqual(
        Slicer.lines(TEXT, { marks: [-1] }),
        { status: 200, text: "", startLine: undefined },
    );
});

test("lines reports the requested and available extent on failure", () => {
    const result = Slicer.lines(TEXT, { marks: [99] });
    assert.equal(result.status, 416);
    assert.deepEqual(result.range, {
        unit: "line",
        requested: { first: 99, last: null },
        available: { first: 1, last: 4, total: 4 },
    });
    assert.deepEqual(result.problem?.range, result.range);
    assert.equal(result.problem?.retryable, false);
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

    const outOfRange = Slicer.lines("abc", { marks: [1, 2, 9] });
    assert.equal(outOfRange.status, 416);
    assert.deepEqual(outOfRange.problem?.requestedCoordinates, [1, 2, 9]);

    const badStart = Slicer.lines("abc", { marks: [1, 9, 1] });
    assert.equal(badStart.status, 416);
    assert.deepEqual(badStart.problem?.requestedCoordinates, [1, 9, 1]);
});

test("lines rejects unaddressable exact regions", () => {

    const unaddressable = Slicer.lines("a😀b", { marks: [1, 4, 1, 5] });
    assert.equal(unaddressable.status, 416);
    assert.deepEqual(unaddressable.problem?.requestedCoordinates, [1, 4, 1, 5]);
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
    assert.deepEqual(
        Slicer.page(["a", "b", "c"], { marks: [2, 3] }),
        { status: 200, items: ["b", "c"] },
    );
    assert.deepEqual(
        Slicer.page([], { marks: [1, -1] }),
        { status: 200, items: [] },
    );

    const failure = Slicer.page(["a", "b", "c"], { marks: [4, -1] });
    assert.equal(failure.status, 416);
    assert.deepEqual(failure.range, {
        unit: "result",
        requested: { first: 4, last: -1 },
        available: { first: 1, last: 3, total: 3 },
    });
});

test("page rejects fractional result positions instead of rounding", () => {
    const result = Slicer.page(["a", "b"], { marks: [0.5] });
    assert.equal(result.status, 416);
    assert.equal(result.range?.requested.first, 0.5);
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
    assert.deepEqual(rangeOverlap.problem?.conflictingRanges, [
        { first: 2, last: 3 },
        { first: 3, last: 4 },
    ]);

    const insertionOverlap = Slicer.lineMarkerEditBatch("abc", [
        { marker: { marks: [1, 2, 1, 2] }, body: "X" },
        { marker: { marks: [1, 2, 1, 2] }, body: "Y" },
    ]);
    assert.equal(insertionOverlap.status, 409);
    assert.equal(insertionOverlap.result, undefined);
});

test("lineMarkerEditBatch rejects a whole-resource replacement mixed with another edit", () => {
    const result = Slicer.lineMarkerEditBatch("one\ntwo\n", [
        { marker: { marks: [1, -1] }, body: "all" },
        { marker: { marks: [-1] }, body: "tail" },
    ]);
    assert.equal(result.status, 409);
    assert.equal(result.problem?.editCount, 2);
});
