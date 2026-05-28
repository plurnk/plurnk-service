import test from "node:test";
import { strict as assert } from "node:assert";
import { sliceLines, applyLineMarkerEdit } from "./line-marker.ts";

const TEXT = "alpha\nbeta\ngamma\ndelta\n";

test("sliceLines: single line", () => {
    const r = sliceLines(TEXT, { first: 2, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, "2:\tbeta");
});

test("sliceLines: range", () => {
    const r = sliceLines(TEXT, { first: 2, last: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.text, "2:\tbeta\n3:\tgamma");
});

test("sliceLines: range <1,-1> = whole content", () => {
    const r = sliceLines(TEXT, { first: 1, last: -1 });
    assert.equal(r.status, 200);
    assert.equal(r.text, "1:\talpha\n2:\tbeta\n3:\tgamma\n4:\tdelta");
});

test("sliceLines: <0> sentinel is insertion point, returns empty", () => {
    const r = sliceLines(TEXT, { first: 0, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("sliceLines: <-1> sentinel is insertion point, returns empty", () => {
    const r = sliceLines(TEXT, { first: -1, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("sliceLines: out-of-range returns 416", () => {
    const r = sliceLines(TEXT, { first: 99, last: null });
    assert.equal(r.status, 416);
});

test("sliceLines: range start > end returns 416", () => {
    const r = sliceLines(TEXT, { first: 3, last: 2 });
    assert.equal(r.status, 416);
});

test("applyLineMarkerEdit: replace single line", () => {
    const r = applyLineMarkerEdit(TEXT, { first: 2, last: null }, "BETA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nBETA\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: replace range", () => {
    const r = applyLineMarkerEdit(TEXT, { first: 2, last: 3 }, "MIDDLE");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nMIDDLE\ndelta\n");
});

test("applyLineMarkerEdit: <0> prepend", () => {
    const r = applyLineMarkerEdit(TEXT, { first: 0, last: null }, "ZERO");
    assert.equal(r.status, 200);
    assert.equal(r.result, "ZERO\nalpha\nbeta\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: <-1> append", () => {
    const r = applyLineMarkerEdit(TEXT, { first: -1, last: null }, "OMEGA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nbeta\ngamma\ndelta\nOMEGA\n");
});

test("applyLineMarkerEdit: <1,-1> empty body clears", () => {
    const r = applyLineMarkerEdit(TEXT, { first: 1, last: -1 }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "");
});

test("applyLineMarkerEdit: empty body with <N> deletes line", () => {
    const r = applyLineMarkerEdit(TEXT, { first: 2, last: null }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: multi-line body", () => {
    const r = applyLineMarkerEdit(TEXT, { first: 2, last: null }, "X\nY");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nX\nY\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: prepend to empty content", () => {
    const r = applyLineMarkerEdit("", { first: 0, last: null }, "first line");
    assert.equal(r.status, 200);
    assert.equal(r.result, "first line");
});

test("applyLineMarkerEdit: append to content without trailing newline", () => {
    const r = applyLineMarkerEdit("one\ntwo", { first: -1, last: null }, "three");
    assert.equal(r.status, 200);
    assert.equal(r.result, "one\ntwo\nthree");
});
