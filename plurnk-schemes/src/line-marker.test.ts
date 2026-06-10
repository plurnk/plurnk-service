import test from "node:test";
import { strict as assert } from "node:assert";
import Slicer from "./line-marker.ts";

const TEXT = "alpha\nbeta\ngamma\ndelta\n";

test("sliceLines: single line", () => {
    const r = Slicer.lines(TEXT, { first: 2, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta");
    assert.equal(r.startLine, 2);
});

test("sliceLines: range", () => {
    const r = Slicer.lines(TEXT, { first: 2, last: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\ngamma");
    assert.equal(r.startLine, 2);
});

test("sliceLines: range <1,-1> = whole content", () => {
    const r = Slicer.lines(TEXT, { first: 1, last: -1 });
    assert.equal(r.status, 200);
    assert.equal(r.text, "alpha\nbeta\ngamma\ndelta");
    assert.equal(r.startLine, 1);
});

test("sliceLines: <0> sentinel is insertion point, returns empty", () => {
    const r = Slicer.lines(TEXT, { first: 0, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("sliceLines: <-1> sentinel is insertion point, returns empty", () => {
    const r = Slicer.lines(TEXT, { first: -1, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("sliceLines: out-of-range returns 416", () => {
    const r = Slicer.lines(TEXT, { first: 99, last: null });
    assert.equal(r.status, 416);
});

test("sliceLines: range start > end returns 416", () => {
    const r = Slicer.lines(TEXT, { first: 3, last: 2 });
    assert.equal(r.status, 416);
});

test("sliceLinesRaw: range without prefix", () => {
    const r = Slicer.linesRaw(TEXT, { first: 2, last: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\ngamma\n");
});

test("sliceLinesRaw: single line without prefix, trailing newline appended", () => {
    const r = Slicer.linesRaw(TEXT, { first: 2, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\n");
});

test("sliceLinesRaw: <1,-1> = whole content with original trailing newline", () => {
    const r = Slicer.linesRaw(TEXT, { first: 1, last: -1 });
    assert.equal(r.status, 200);
    assert.equal(r.text, TEXT);
});

test("applyLineMarkerEdit: replace single line", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { first: 2, last: null }, "BETA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nBETA\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: replace range", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { first: 2, last: 3 }, "MIDDLE");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nMIDDLE\ndelta\n");
});

test("applyLineMarkerEdit: <0> prepend", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { first: 0, last: null }, "ZERO");
    assert.equal(r.status, 200);
    assert.equal(r.result, "ZERO\nalpha\nbeta\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: <-1> append", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { first: -1, last: null }, "OMEGA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nbeta\ngamma\ndelta\nOMEGA\n");
});

test("applyLineMarkerEdit: <1,-1> empty body clears", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { first: 1, last: -1 }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "");
});

test("applyLineMarkerEdit: empty body with <N> deletes line", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { first: 2, last: null }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: multi-line body", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { first: 2, last: null }, "X\nY");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nX\nY\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: prepend to empty content", () => {
    const r = Slicer.lineMarkerEdit("", { first: 0, last: null }, "first line");
    assert.equal(r.status, 200);
    assert.equal(r.result, "first line");
});

test("applyLineMarkerEdit: append to content without trailing newline", () => {
    const r = Slicer.lineMarkerEdit("one\ntwo", { first: -1, last: null }, "three");
    assert.equal(r.status, 200);
    assert.equal(r.result, "one\ntwo\nthree");
});

// --- sliceJsonItems: structural <L> on JSON (grammar 0.13.0) ---

test("sliceJsonItems: array source, <N> returns single item wrapped in array", () => {
    const r = Slicer.jsonItems('["a","b","c"]', { first: 2, last: null });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["b"]);
});

test("sliceJsonItems: array source, <N,M> returns range as array", () => {
    const r = Slicer.jsonItems('["a","b","c","d"]', { first: 2, last: 3 });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["b", "c"]);
});

test("sliceJsonItems: array source, <1,-1> returns whole array", () => {
    const r = Slicer.jsonItems('["a","b","c"]', { first: 1, last: -1 });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["a", "b", "c"]);
});

test("sliceJsonItems: object source, <N> wraps key-value as single-key object", () => {
    const r = Slicer.jsonItems('{"k1":1,"k2":2,"k3":3}', { first: 2, last: null });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ k2: 2 }]);
});

test("sliceJsonItems: object source, <N,M> returns multiple single-key objects", () => {
    const r = Slicer.jsonItems('{"k1":1,"k2":2,"k3":3}', { first: 1, last: 2 });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ k1: 1 }, { k2: 2 }]);
});

test("sliceJsonItems: scalar string source, <1> returns scalar wrapped in array", () => {
    const r = Slicer.jsonItems('"hello"', { first: 1, last: null });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["hello"]);
});

test("sliceJsonItems: scalar number source, <1> returns number wrapped in array", () => {
    const r = Slicer.jsonItems("42", { first: 1, last: null });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [42]);
});

test("sliceJsonItems: scalar boolean/null source", () => {
    assert.deepEqual(JSON.parse(Slicer.jsonItems("true", { first: 1, last: null }).body ?? ""), [true]);
    assert.deepEqual(JSON.parse(Slicer.jsonItems("null", { first: 1, last: null }).body ?? ""), [null]);
});

test("sliceJsonItems: scalar source, <2> returns 416 (only one item exists)", () => {
    const r = Slicer.jsonItems('"hello"', { first: 2, last: null });
    assert.equal(r.status, 416);
});

test("sliceJsonItems: nested values stay intact (not flattened)", () => {
    const r = Slicer.jsonItems('{"a":{"b":"deep"}}', { first: 1, last: null });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ a: { b: "deep" } }]);
});

test("sliceJsonItems: <0> sentinel returns empty array", () => {
    const r = Slicer.jsonItems('["a","b"]', { first: 0, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.body, "[]");
});

test("sliceJsonItems: <-1> sentinel returns empty array", () => {
    const r = Slicer.jsonItems('["a","b"]', { first: -1, last: null });
    assert.equal(r.status, 200);
    assert.equal(r.body, "[]");
});

test("sliceJsonItems: out-of-range returns 416", () => {
    const r = Slicer.jsonItems('["a","b"]', { first: 99, last: null });
    assert.equal(r.status, 416);
});

test("sliceJsonItems: malformed JSON returns 400", () => {
    const r = Slicer.jsonItems("{not valid", { first: 1, last: null });
    assert.equal(r.status, 400);
});

test("sliceJsonItems: range start > end returns 416", () => {
    const r = Slicer.jsonItems('["a","b","c"]', { first: 3, last: 2 });
    assert.equal(r.status, 416);
});

test("sliceJsonItems: object insertion order preserved", () => {
    const r = Slicer.jsonItems('{"first":1,"second":2,"third":3}', { first: 1, last: -1 });
    assert.equal(r.status, 200);
    const items = JSON.parse(r.body ?? "") as object[];
    assert.deepEqual(items, [{ first: 1 }, { second: 2 }, { third: 3 }]);
});

// --- applyJsonItemEdit: structural <L> EDIT on JSON (M.8) ---

// Array source
test("applyJsonItemEdit: array <-1>:item:EDIT appends a single item", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { first: -1, last: null }, '"d"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "c", "d"]);
});

test("applyJsonItemEdit: array <-1>:[items]:EDIT appends multiple items", () => {
    const r = Slicer.jsonItemEdit('["a","b"]', { first: -1, last: null }, '["x","y"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "x", "y"]);
});

test("applyJsonItemEdit: array <-1>:[[1,2]]:EDIT appends inner array as single element", () => {
    // Wrap-workaround: outer array is the "items" list (length 1);
    // inner array becomes the single appended element.
    const r = Slicer.jsonItemEdit('["a","b"]', { first: -1, last: null }, '[[1,2]]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", [1, 2]]);
});

test("applyJsonItemEdit: array <0>:item:EDIT prepends", () => {
    const r = Slicer.jsonItemEdit('["b","c"]', { first: 0, last: null }, '"a"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "c"]);
});

test("applyJsonItemEdit: array <N>:item:EDIT replaces position N", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { first: 2, last: null }, '"B"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "B", "c"]);
});

test("applyJsonItemEdit: array <N>:[multi]:EDIT replaces position N with multiple items", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { first: 2, last: null }, '["X","Y"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "Y", "c"]);
});

test("applyJsonItemEdit: array <N,M>:item:EDIT range collapses to single item", () => {
    const r = Slicer.jsonItemEdit('["a","b","c","d"]', { first: 2, last: 3 }, '"X"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "d"]);
});

test("applyJsonItemEdit: array <N,M>:[multi]:EDIT range expands to multiple", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { first: 2, last: 3 }, '["X","Y","Z"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "Y", "Z"]);
});

test("applyJsonItemEdit: array <N>::EDIT (empty body) deletes position N", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { first: 2, last: null }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "c"]);
});

test("applyJsonItemEdit: array <1,-1>::EDIT (empty body) clears to []", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { first: 1, last: -1 }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), []);
});

test("applyJsonItemEdit: array <-1>::EDIT (empty body on sentinel) is no-op", () => {
    const r = Slicer.jsonItemEdit('["a","b"]', { first: -1, last: null }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, '["a","b"]');
});

// Object source
test("applyJsonItemEdit: object <-1>:{kv}:EDIT appends kv-pair", () => {
    const r = Slicer.jsonItemEdit('{"k1":1,"k2":2}', { first: -1, last: null }, '{"k3":3}');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k2: 2, k3: 3 });
});

test("applyJsonItemEdit: object <-1>:{multi-key}:EDIT appends multiple kv-pairs", () => {
    const r = Slicer.jsonItemEdit('{"k1":1}', { first: -1, last: null }, '{"k2":2,"k3":3}');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k2: 2, k3: 3 });
});

test("applyJsonItemEdit: object <N>:{kv}:EDIT replaces position N kv", () => {
    const r = Slicer.jsonItemEdit('{"k1":1,"k2":2,"k3":3}', { first: 1, last: null }, '{"newK":"newV"}');
    assert.equal(r.status, 200);
    const result = JSON.parse(r.result ?? "");
    assert.deepEqual(Object.entries(result), [["newK", "newV"], ["k2", 2], ["k3", 3]]);
});

test("applyJsonItemEdit: object <N>::EDIT deletes kv at position N", () => {
    const r = Slicer.jsonItemEdit('{"k1":1,"k2":2,"k3":3}', { first: 2, last: null }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k3: 3 });
});

test("applyJsonItemEdit: object <1,-1>::EDIT clears to {}", () => {
    const r = Slicer.jsonItemEdit('{"k1":1}', { first: 1, last: -1 }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), {});
});

test("applyJsonItemEdit: object source with array body item → 400", () => {
    const r = Slicer.jsonItemEdit('{"k1":1}', { first: -1, last: null }, "[1,2,3]");
    assert.equal(r.status, 400);
});

// Scalar source
test("applyJsonItemEdit: scalar <1>:newScalar:EDIT replaces", () => {
    const r = Slicer.jsonItemEdit('"hello"', { first: 1, last: null }, '"world"');
    assert.equal(r.status, 200);
    assert.equal(r.result, '"world"');
});

test("applyJsonItemEdit: scalar <1>:[ ]:EDIT (empty array body) deletes → null", () => {
    const r = Slicer.jsonItemEdit('"hello"', { first: 1, last: null }, "[]");
    assert.equal(r.status, 200);
    assert.equal(r.result, "null");
});

test("applyJsonItemEdit: scalar <-1> (grow) returns 400", () => {
    const r = Slicer.jsonItemEdit('"hello"', { first: -1, last: null }, '"world"');
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: scalar <0> (grow) returns 400", () => {
    const r = Slicer.jsonItemEdit('"hello"', { first: 0, last: null }, '"world"');
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: scalar <1>:[a,b]:EDIT (multi-item body) → 400 (no implicit promotion)", () => {
    const r = Slicer.jsonItemEdit('"hello"', { first: 1, last: null }, '["a","b"]');
    assert.equal(r.status, 400);
});

// Errors
test("applyJsonItemEdit: malformed JSON source → 400", () => {
    const r = Slicer.jsonItemEdit("{not json", { first: 1, last: null }, '"x"');
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: malformed JSON body → 400", () => {
    const r = Slicer.jsonItemEdit('["a"]', { first: 1, last: null }, "{not json");
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: out-of-range position → 416", () => {
    const r = Slicer.jsonItemEdit('["a","b"]', { first: 99, last: null }, '"x"');
    assert.equal(r.status, 416);
});
