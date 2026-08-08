import assert from "node:assert/strict";
import test from "node:test";
import LineMarkerOps from "./line-marker.ts";

test("LineMarkerOps exposes universal line and exact text selection", () => {
    assert.deepEqual(
        LineMarkerOps.sliceLines("alpha\nbeta\n", { marks: [2] }),
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
            range: {
                unit: "line",
                requested: { first: 2, last: null },
                available: { first: 1, last: 2, total: 2 },
                returned: { first: 2, last: 2, total: 1 },
                complete: false,
                next: null,
                all: { first: 1, last: -1 },
            },
        },
    );
    assert.deepEqual(
        LineMarkerOps.sliceLines("a😀b", { marks: [1, 2, 1, 3] }),
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
});

test("LineMarkerOps applies exact text edits without structural JSON dispatch", () => {
    assert.deepEqual(
        LineMarkerOps.applyLineMarkerEdit("a😀b", { marks: [1, 2, 1, 3] }, "X"),
        { status: 200, result: "aXb" },
    );
});

test("LineMarkerOps pages ordered result catalogs independently of text scope", () => {
    assert.deepEqual(
        LineMarkerOps.page(["a", "b", "c"], { marks: [2, 3] }),
        {
            status: 200,
            items: ["b", "c"],
            range: {
                unit: "result",
                requested: { first: 2, last: 3 },
                available: { first: 1, last: 3, total: 3 },
                returned: { first: 2, last: 3, total: 2 },
                complete: false,
                next: null,
                all: { first: 1, last: -1 },
            },
        },
    );
});
