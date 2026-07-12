import test from "node:test";
import { strict as assert } from "node:assert";
import LineMarkerOps from "./line-marker.ts";

const TEXT = "alpha\nbeta\ngamma\ndelta\n";

test("LineMarkerOps.sliceLines: single line", () => {
    const r = LineMarkerOps.sliceLines(TEXT, { marks: [2] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta");
    assert.equal(r.startLine, 2);
});

test("LineMarkerOps.sliceLines: range", () => {
    const r = LineMarkerOps.sliceLines(TEXT, { marks: [2, 3] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\ngamma");
    assert.equal(r.startLine, 2);
});

test("LineMarkerOps.sliceLines: range <1,-1> = whole content", () => {
    const r = LineMarkerOps.sliceLines(TEXT, { marks: [1, -1] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "alpha\nbeta\ngamma\ndelta");
    assert.equal(r.startLine, 1);
});

test("LineMarkerOps.sliceLines: <0> sentinel is insertion point, returns empty", () => {
    const r = LineMarkerOps.sliceLines(TEXT, { marks: [0] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("LineMarkerOps.sliceLines: <-1> sentinel is insertion point, returns empty", () => {
    const r = LineMarkerOps.sliceLines(TEXT, { marks: [-1] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("LineMarkerOps.sliceLines: out-of-range returns 416", () => {
    const r = LineMarkerOps.sliceLines(TEXT, { marks: [99] });
    assert.equal(r.status, 416);
});

test("LineMarkerOps.sliceLines: range start > end returns 416", () => {
    const r = LineMarkerOps.sliceLines(TEXT, { marks: [3, 2] });
    assert.equal(r.status, 416);
});

test("LineMarkerOps.sliceLinesRaw: range without prefix", () => {
    const r = LineMarkerOps.sliceLinesRaw(TEXT, { marks: [2, 3] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\ngamma\n");
});

test("LineMarkerOps.sliceLinesRaw: single line without prefix, trailing newline appended", () => {
    const r = LineMarkerOps.sliceLinesRaw(TEXT, { marks: [2] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\n");
});

test("LineMarkerOps.sliceLinesRaw: <1,-1> = whole content with original trailing newline", () => {
    const r = LineMarkerOps.sliceLinesRaw(TEXT, { marks: [1, -1] });
    assert.equal(r.status, 200);
    assert.equal(r.text, TEXT);
});

test("LineMarkerOps.applyLineMarkerEdit: replace single line", () => {
    const r = LineMarkerOps.applyLineMarkerEdit(TEXT, { marks: [2] }, "BETA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nBETA\ngamma\ndelta\n");
});

test("LineMarkerOps.applyLineMarkerEdit: replace range", () => {
    const r = LineMarkerOps.applyLineMarkerEdit(TEXT, { marks: [2, 3] }, "MIDDLE");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nMIDDLE\ndelta\n");
});

test("LineMarkerOps.applyLineMarkerEdit: <0> prepend", () => {
    const r = LineMarkerOps.applyLineMarkerEdit(TEXT, { marks: [0] }, "ZERO");
    assert.equal(r.status, 200);
    assert.equal(r.result, "ZERO\nalpha\nbeta\ngamma\ndelta\n");
});

test("LineMarkerOps.applyLineMarkerEdit: <-1> append", () => {
    const r = LineMarkerOps.applyLineMarkerEdit(TEXT, { marks: [-1] }, "OMEGA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nbeta\ngamma\ndelta\nOMEGA\n");
});

test("LineMarkerOps.applyLineMarkerEdit: <1,-1> empty body clears", () => {
    const r = LineMarkerOps.applyLineMarkerEdit(TEXT, { marks: [1, -1] }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "");
});

test("LineMarkerOps.applyLineMarkerEdit: empty body with <N> deletes line", () => {
    const r = LineMarkerOps.applyLineMarkerEdit(TEXT, { marks: [2] }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\ngamma\ndelta\n");
});

test("LineMarkerOps.applyLineMarkerEdit: multi-line body", () => {
    const r = LineMarkerOps.applyLineMarkerEdit(TEXT, { marks: [2] }, "X\nY");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nX\nY\ngamma\ndelta\n");
});

test("LineMarkerOps.applyLineMarkerEdit: prepend to empty content", () => {
    const r = LineMarkerOps.applyLineMarkerEdit("", { marks: [0] }, "first line");
    assert.equal(r.status, 200);
    assert.equal(r.result, "first line");
});

test("LineMarkerOps.applyLineMarkerEdit: append to content without trailing newline", () => {
    const r = LineMarkerOps.applyLineMarkerEdit("one\ntwo", { marks: [-1] }, "three");
    assert.equal(r.status, 200);
    assert.equal(r.result, "one\ntwo\nthree");
});

// --- LineMarkerOps.sliceJsonItems: structural <L> on JSON (grammar 0.13.0) ---

test("LineMarkerOps.sliceJsonItems: array source, <N> returns single item wrapped in array", () => {
    const r = LineMarkerOps.sliceJsonItems('["a","b","c"]', { marks: [2] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["b"]);
});

test("LineMarkerOps.sliceJsonItems: array source, <N,M> returns range as array", () => {
    const r = LineMarkerOps.sliceJsonItems('["a","b","c","d"]', { marks: [2, 3] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["b", "c"]);
});

test("LineMarkerOps.sliceJsonItems: array source, <1,-1> returns whole array", () => {
    const r = LineMarkerOps.sliceJsonItems('["a","b","c"]', { marks: [1, -1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["a", "b", "c"]);
});

test("LineMarkerOps.sliceJsonItems: object source, <N> wraps key-value as single-key object", () => {
    const r = LineMarkerOps.sliceJsonItems('{"k1":1,"k2":2,"k3":3}', { marks: [2] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ k2: 2 }]);
});

test("LineMarkerOps.sliceJsonItems: object source, <N,M> returns multiple single-key objects", () => {
    const r = LineMarkerOps.sliceJsonItems('{"k1":1,"k2":2,"k3":3}', { marks: [1, 2] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ k1: 1 }, { k2: 2 }]);
});

test("LineMarkerOps.sliceJsonItems: scalar string source, <1> returns scalar wrapped in array", () => {
    const r = LineMarkerOps.sliceJsonItems('"hello"', { marks: [1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["hello"]);
});

test("LineMarkerOps.sliceJsonItems: scalar number source, <1> returns number wrapped in array", () => {
    const r = LineMarkerOps.sliceJsonItems("42", { marks: [1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [42]);
});

test("LineMarkerOps.sliceJsonItems: scalar boolean/null source", () => {
    assert.deepEqual(JSON.parse(LineMarkerOps.sliceJsonItems("true", { marks: [1] }).body ?? ""), [true]);
    assert.deepEqual(JSON.parse(LineMarkerOps.sliceJsonItems("null", { marks: [1] }).body ?? ""), [null]);
});

test("LineMarkerOps.sliceJsonItems: scalar source, <2> returns 416 (only one item exists)", () => {
    const r = LineMarkerOps.sliceJsonItems('"hello"', { marks: [2] });
    assert.equal(r.status, 416);
});

test("LineMarkerOps.sliceJsonItems: nested values stay intact (not flattened)", () => {
    const r = LineMarkerOps.sliceJsonItems('{"a":{"b":"deep"}}', { marks: [1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ a: { b: "deep" } }]);
});

test("LineMarkerOps.sliceJsonItems: <0> sentinel returns empty array", () => {
    const r = LineMarkerOps.sliceJsonItems('["a","b"]', { marks: [0] });
    assert.equal(r.status, 200);
    assert.equal(r.body, "[]");
});

test("LineMarkerOps.sliceJsonItems: <-1> sentinel returns empty array", () => {
    const r = LineMarkerOps.sliceJsonItems('["a","b"]', { marks: [-1] });
    assert.equal(r.status, 200);
    assert.equal(r.body, "[]");
});

test("LineMarkerOps.sliceJsonItems: out-of-range returns 416", () => {
    const r = LineMarkerOps.sliceJsonItems('["a","b"]', { marks: [99] });
    assert.equal(r.status, 416);
});

test("LineMarkerOps.sliceJsonItems: malformed JSON returns 400", () => {
    const r = LineMarkerOps.sliceJsonItems("{not valid", { marks: [1] });
    assert.equal(r.status, 400);
});

test("LineMarkerOps.sliceJsonItems: range start > end returns 416", () => {
    const r = LineMarkerOps.sliceJsonItems('["a","b","c"]', { marks: [3, 2] });
    assert.equal(r.status, 416);
});

test("LineMarkerOps.sliceJsonItems: object insertion order preserved", () => {
    const r = LineMarkerOps.sliceJsonItems('{"first":1,"second":2,"third":3}', { marks: [1, -1] });
    assert.equal(r.status, 200);
    const items = JSON.parse(r.body ?? "") as object[];
    assert.deepEqual(items, [{ first: 1 }, { second: 2 }, { third: 3 }]);
});

// --- LineMarkerOps.applyJsonItemEdit: structural <L> EDIT on JSON (M.8) ---

// Array source
test("LineMarkerOps.applyJsonItemEdit: array <-1>:item:EDIT appends a single item", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b","c"]', { marks: [-1] }, '"d"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "c", "d"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <-1>:[items]:EDIT appends multiple items", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b"]', { marks: [-1] }, '["x","y"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "x", "y"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <-1>:[[1,2]]:EDIT appends inner array as single element", () => {
    // Wrap-workaround: outer array is the "items" list (length 1);
    // inner array becomes the single appended element.
    const r = LineMarkerOps.applyJsonItemEdit('["a","b"]', { marks: [-1] }, '[[1,2]]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", [1, 2]]);
});

test("LineMarkerOps.applyJsonItemEdit: array <0>:item:EDIT prepends", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["b","c"]', { marks: [0] }, '"a"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "c"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <N>:item:EDIT replaces position N", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b","c"]', { marks: [2] }, '"B"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "B", "c"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <N>:[multi]:EDIT replaces position N with multiple items", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b","c"]', { marks: [2] }, '["X","Y"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "Y", "c"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <N,M>:item:EDIT range collapses to single item", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b","c","d"]', { marks: [2, 3] }, '"X"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "d"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <N,M>:[multi]:EDIT range expands to multiple", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b","c"]', { marks: [2, 3] }, '["X","Y","Z"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "Y", "Z"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <N>::EDIT (empty body) deletes position N", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b","c"]', { marks: [2] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "c"]);
});

test("LineMarkerOps.applyJsonItemEdit: array <1,-1>::EDIT (empty body) clears to []", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b","c"]', { marks: [1, -1] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), []);
});

test("LineMarkerOps.applyJsonItemEdit: array <-1>::EDIT (empty body on sentinel) is no-op", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b"]', { marks: [-1] }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, '["a","b"]');
});

// Object source
test("LineMarkerOps.applyJsonItemEdit: object <-1>:{kv}:EDIT appends kv-pair", () => {
    const r = LineMarkerOps.applyJsonItemEdit('{"k1":1,"k2":2}', { marks: [-1] }, '{"k3":3}');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k2: 2, k3: 3 });
});

test("LineMarkerOps.applyJsonItemEdit: object <-1>:{multi-key}:EDIT appends multiple kv-pairs", () => {
    const r = LineMarkerOps.applyJsonItemEdit('{"k1":1}', { marks: [-1] }, '{"k2":2,"k3":3}');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k2: 2, k3: 3 });
});

test("LineMarkerOps.applyJsonItemEdit: object <N>:{kv}:EDIT replaces position N kv", () => {
    const r = LineMarkerOps.applyJsonItemEdit('{"k1":1,"k2":2,"k3":3}', { marks: [1] }, '{"newK":"newV"}');
    assert.equal(r.status, 200);
    const result = JSON.parse(r.result ?? "");
    assert.deepEqual(Object.entries(result), [["newK", "newV"], ["k2", 2], ["k3", 3]]);
});

test("LineMarkerOps.applyJsonItemEdit: object <N>::EDIT deletes kv at position N", () => {
    const r = LineMarkerOps.applyJsonItemEdit('{"k1":1,"k2":2,"k3":3}', { marks: [2] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k3: 3 });
});

test("LineMarkerOps.applyJsonItemEdit: object <1,-1>::EDIT clears to {}", () => {
    const r = LineMarkerOps.applyJsonItemEdit('{"k1":1}', { marks: [1, -1] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), {});
});

test("LineMarkerOps.applyJsonItemEdit: object source with array body item → 400", () => {
    const r = LineMarkerOps.applyJsonItemEdit('{"k1":1}', { marks: [-1] }, "[1,2,3]");
    assert.equal(r.status, 400);
});

// Scalar source
test("LineMarkerOps.applyJsonItemEdit: scalar <1>:newScalar:EDIT replaces", () => {
    const r = LineMarkerOps.applyJsonItemEdit('"hello"', { marks: [1] }, '"world"');
    assert.equal(r.status, 200);
    assert.equal(r.result, '"world"');
});

test("LineMarkerOps.applyJsonItemEdit: scalar <1>:[ ]:EDIT (empty array body) deletes → null", () => {
    const r = LineMarkerOps.applyJsonItemEdit('"hello"', { marks: [1] }, "[]");
    assert.equal(r.status, 200);
    assert.equal(r.result, "null");
});

test("LineMarkerOps.applyJsonItemEdit: scalar <-1> (grow) returns 400", () => {
    const r = LineMarkerOps.applyJsonItemEdit('"hello"', { marks: [-1] }, '"world"');
    assert.equal(r.status, 400);
});

test("LineMarkerOps.applyJsonItemEdit: scalar <0> (grow) returns 400", () => {
    const r = LineMarkerOps.applyJsonItemEdit('"hello"', { marks: [0] }, '"world"');
    assert.equal(r.status, 400);
});

test("LineMarkerOps.applyJsonItemEdit: scalar <1>:[a,b]:EDIT (multi-item body) → 400 (no implicit promotion)", () => {
    const r = LineMarkerOps.applyJsonItemEdit('"hello"', { marks: [1] }, '["a","b"]');
    assert.equal(r.status, 400);
});

// Errors
test("LineMarkerOps.applyJsonItemEdit: malformed JSON source → 400", () => {
    const r = LineMarkerOps.applyJsonItemEdit("{not json", { marks: [1] }, '"x"');
    assert.equal(r.status, 400);
});

test("LineMarkerOps.applyJsonItemEdit: malformed JSON body → 400", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a"]', { marks: [1] }, "{not json");
    assert.equal(r.status, 400);
});

test("LineMarkerOps.applyJsonItemEdit: out-of-range position → 416", () => {
    const r = LineMarkerOps.applyJsonItemEdit('["a","b"]', { marks: [99] }, '"x"');
    assert.equal(r.status, 416);
});
