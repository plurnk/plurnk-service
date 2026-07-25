import test from "node:test";
import { strict as assert } from "node:assert";
import Slicer from "./Slicer.ts";

const TEXT = "alpha\nbeta\ngamma\ndelta\n";

test("sliceLines: single line", () => {
    const r = Slicer.lines(TEXT, { marks: [2] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta");
    assert.equal(r.startLine, 2);
});

test("sliceLines: range", () => {
    const r = Slicer.lines(TEXT, { marks: [2, 3] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\ngamma");
    assert.equal(r.startLine, 2);
});

test("sliceLines: range <1,-1> = whole content", () => {
    const r = Slicer.lines(TEXT, { marks: [1, -1] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "alpha\nbeta\ngamma\ndelta");
    assert.equal(r.startLine, 1);
});

test("sliceLines: <0> sentinel is insertion point, returns empty", () => {
    const r = Slicer.lines(TEXT, { marks: [0] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("sliceLines: <-1> sentinel is insertion point, returns empty", () => {
    const r = Slicer.lines(TEXT, { marks: [-1] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

// Bug guard: <1,-1> ("whole content") is valid on EMPTY content — empty is
// valid whole content. Previously 416'd at all four sites because normalized
// m=0 tripped the lower-bound check. Replace-everything on a fresh empty
// entry is a real model action.
test("whole-content <1,-1> on empty succeeds across line + json paths", () => {
    assert.equal(Slicer.lines("", { marks: [1, -1] }).status, 200);
    assert.equal(Slicer.lines("", { marks: [1, -1] }).text, "");
    assert.equal(Slicer.lines("", { marks: [0, -1] }).status, 200); // <0,-1> alias

    const lineEdit = Slicer.lineMarkerEdit("", { marks: [1, -1] }, "new");
    assert.equal(lineEdit.status, 200);
    assert.equal(lineEdit.result, "new");

    assert.equal(Slicer.jsonItems("[]", { marks: [1, -1] }).status, 200);
    assert.equal(Slicer.jsonItems("[]", { marks: [1, -1] }).body, "[]");

    const arrEdit = Slicer.jsonItemEdit("[]", { marks: [1, -1] }, '"x"');
    assert.equal(arrEdit.status, 200);
    assert.deepEqual(JSON.parse(arrEdit.result ?? ""), ["x"]);

    const objEdit = Slicer.jsonItemEdit("{}", { marks: [1, -1] }, '{"k":1}');
    assert.equal(objEdit.status, 200);
    assert.deepEqual(JSON.parse(objEdit.result ?? ""), { k: 1 });
});

test("non-whole-content ranges on empty are still 416", () => {
    assert.equal(Slicer.lines("", { marks: [1] }).status, 416);  // single pos
    assert.equal(Slicer.lines("", { marks: [2, 5] }).status, 416);
    assert.equal(Slicer.lines("", { marks: [1, 3] }).status, 416);     // m not -1
    assert.equal(Slicer.jsonItemEdit("[]", { marks: [2, 3] }, '"x"').status, 416);
});

test("sliceLines: out-of-range returns 416", () => {
    const r = Slicer.lines(TEXT, { marks: [99] });
    assert.equal(r.status, 416);
});

test("sliceLines: range start > end returns 416", () => {
    const r = Slicer.lines(TEXT, { marks: [3, 2] });
    assert.equal(r.status, 416);
});

test("sliceLinesRaw: range without prefix", () => {
    const r = Slicer.linesRaw(TEXT, { marks: [2, 3] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\ngamma\n");
});

test("sliceLinesRaw: single line without prefix, trailing newline appended", () => {
    const r = Slicer.linesRaw(TEXT, { marks: [2] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "beta\n");
});

test("sliceLinesRaw: <1,-1> = whole content with original trailing newline", () => {
    const r = Slicer.linesRaw(TEXT, { marks: [1, -1] });
    assert.equal(r.status, 200);
    assert.equal(r.text, TEXT);
});

test("applyLineMarkerEdit: replace single line", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [2] }, "BETA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nBETA\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: replace range", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [2, 3] }, "MIDDLE");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nMIDDLE\ndelta\n");
});

test("applyLineMarkerEdit: <0> prepend", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [0] }, "ZERO");
    assert.equal(r.status, 200);
    assert.equal(r.result, "ZERO\nalpha\nbeta\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: <-1> append", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [-1] }, "OMEGA");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nbeta\ngamma\ndelta\nOMEGA\n");
});

test("applyLineMarkerEdit: <1,-1> empty body clears", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [1, -1] }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "");
});

test("applyLineMarkerEdit: empty body with <N> deletes line", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [2] }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\ngamma\ndelta\n");
});

// --- #18: fractional <N.frac> insert-between (no flooring/replacing) ---
test("applyLineMarkerEdit: <2.5> inserts between lines 2 and 3 (replaces nothing)", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [2.5] }, "INS");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nbeta\nINS\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: <0.5> floors to 0 = prepend", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [0.5] }, "INS");
    assert.equal(r.status, 200);
    assert.equal(r.result, "INS\nalpha\nbeta\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: <4.5> floors to last line = append", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [4.5] }, "INS");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nbeta\ngamma\ndelta\nINS\n");
});

test("applyLineMarkerEdit: <5.5> past the end → 416", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [5.5] }, "INS");
    assert.equal(r.status, 416);
});

test("applyLineMarkerEdit: <2.5> empty body is a no-op (insert nothing)", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [2.5] }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, TEXT);
});

test("sliceLines: <2.5> insert point selects no content for READ", () => {
    const r = Slicer.lines(TEXT, { marks: [2.5] });
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
});

test("applyLineMarkerEdit: multi-line body", () => {
    const r = Slicer.lineMarkerEdit(TEXT, { marks: [2] }, "X\nY");
    assert.equal(r.status, 200);
    assert.equal(r.result, "alpha\nX\nY\ngamma\ndelta\n");
});

test("applyLineMarkerEdit: prepend to empty content", () => {
    const r = Slicer.lineMarkerEdit("", { marks: [0] }, "first line");
    assert.equal(r.status, 200);
    assert.equal(r.result, "first line");
});

test("applyLineMarkerEdit: append to content without trailing newline", () => {
    const r = Slicer.lineMarkerEdit("one\ntwo", { marks: [-1] }, "three");
    assert.equal(r.status, 200);
    assert.equal(r.result, "one\ntwo\nthree");
});

// --- sliceJsonItems: structural <L> on JSON (grammar 0.13.0) ---

test("sliceJsonItems: array source, <N> returns single item wrapped in array", () => {
    const r = Slicer.jsonItems('["a","b","c"]', { marks: [2] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["b"]);
});

test("sliceJsonItems: array source, <N,M> returns range as array", () => {
    const r = Slicer.jsonItems('["a","b","c","d"]', { marks: [2, 3] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["b", "c"]);
});

test("sliceJsonItems: array source, <1,-1> returns whole array", () => {
    const r = Slicer.jsonItems('["a","b","c"]', { marks: [1, -1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["a", "b", "c"]);
});

test("sliceJsonItems: object source, <N> wraps key-value as single-key object", () => {
    const r = Slicer.jsonItems('{"k1":1,"k2":2,"k3":3}', { marks: [2] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ k2: 2 }]);
});

test("sliceJsonItems: object source, <N,M> returns multiple single-key objects", () => {
    const r = Slicer.jsonItems('{"k1":1,"k2":2,"k3":3}', { marks: [1, 2] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ k1: 1 }, { k2: 2 }]);
});

test("sliceJsonItems: scalar string source, <1> returns scalar wrapped in array", () => {
    const r = Slicer.jsonItems('"hello"', { marks: [1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), ["hello"]);
});

test("sliceJsonItems: scalar number source, <1> returns number wrapped in array", () => {
    const r = Slicer.jsonItems("42", { marks: [1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [42]);
});

test("sliceJsonItems: scalar boolean/null source", () => {
    assert.deepEqual(JSON.parse(Slicer.jsonItems("true", { marks: [1] }).body ?? ""), [true]);
    assert.deepEqual(JSON.parse(Slicer.jsonItems("null", { marks: [1] }).body ?? ""), [null]);
});

test("sliceJsonItems: scalar source, <2> returns 416 (only one item exists)", () => {
    const r = Slicer.jsonItems('"hello"', { marks: [2] });
    assert.equal(r.status, 416);
});

test("sliceJsonItems: nested values stay intact (not flattened)", () => {
    const r = Slicer.jsonItems('{"a":{"b":"deep"}}', { marks: [1] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body ?? ""), [{ a: { b: "deep" } }]);
});

test("sliceJsonItems: <0> sentinel returns empty array", () => {
    const r = Slicer.jsonItems('["a","b"]', { marks: [0] });
    assert.equal(r.status, 200);
    assert.equal(r.body, "[]");
});

test("sliceJsonItems: <-1> sentinel returns empty array", () => {
    const r = Slicer.jsonItems('["a","b"]', { marks: [-1] });
    assert.equal(r.status, 200);
    assert.equal(r.body, "[]");
});

test("sliceJsonItems: out-of-range returns 416", () => {
    const r = Slicer.jsonItems('["a","b"]', { marks: [99] });
    assert.equal(r.status, 416);
});

test("sliceJsonItems: malformed JSON returns 400", () => {
    const r = Slicer.jsonItems("{not valid", { marks: [1] });
    assert.equal(r.status, 400);
});

test("sliceJsonItems: range start > end returns 416", () => {
    const r = Slicer.jsonItems('["a","b","c"]', { marks: [3, 2] });
    assert.equal(r.status, 416);
});

test("sliceJsonItems: object insertion order preserved", () => {
    const r = Slicer.jsonItems('{"first":1,"second":2,"third":3}', { marks: [1, -1] });
    assert.equal(r.status, 200);
    const items = JSON.parse(r.body ?? "") as object[];
    assert.deepEqual(items, [{ first: 1 }, { second: 2 }, { third: 3 }]);
});

// --- applyJsonItemEdit: structural <L> EDIT on JSON (M.8) ---

// Array source
test("applyJsonItemEdit: array <-1>:item:EDIT appends a single item", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { marks: [-1] }, '"d"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "c", "d"]);
});

test("applyJsonItemEdit: array <-1>:[items]:EDIT appends multiple items", () => {
    const r = Slicer.jsonItemEdit('["a","b"]', { marks: [-1] }, '["x","y"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "x", "y"]);
});

test("applyJsonItemEdit: array <-1>:[[1,2]]:EDIT appends inner array as single element", () => {
    // Wrap-workaround: outer array is the "items" list (length 1);
    // inner array becomes the single appended element.
    const r = Slicer.jsonItemEdit('["a","b"]', { marks: [-1] }, '[[1,2]]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", [1, 2]]);
});

test("applyJsonItemEdit: array <0>:item:EDIT prepends", () => {
    const r = Slicer.jsonItemEdit('["b","c"]', { marks: [0] }, '"a"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "b", "c"]);
});

test("applyJsonItemEdit: array <N>:item:EDIT replaces position N", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { marks: [2] }, '"B"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "B", "c"]);
});

test("applyJsonItemEdit: array <N>:[multi]:EDIT replaces position N with multiple items", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { marks: [2] }, '["X","Y"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "Y", "c"]);
});

test("applyJsonItemEdit: array <N,M>:item:EDIT range collapses to single item", () => {
    const r = Slicer.jsonItemEdit('["a","b","c","d"]', { marks: [2, 3] }, '"X"');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "d"]);
});

test("applyJsonItemEdit: array <N,M>:[multi]:EDIT range expands to multiple", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { marks: [2, 3] }, '["X","Y","Z"]');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "X", "Y", "Z"]);
});

test("applyJsonItemEdit: array <N>::EDIT (empty body) deletes position N", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { marks: [2] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "c"]);
});

test("applyJsonItemEdit: array <1,-1>::EDIT (empty body) clears to []", () => {
    const r = Slicer.jsonItemEdit('["a","b","c"]', { marks: [1, -1] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), []);
});

test("applyJsonItemEdit: array <-1>::EDIT (empty body on sentinel) is no-op", () => {
    const r = Slicer.jsonItemEdit('["a","b"]', { marks: [-1] }, "");
    assert.equal(r.status, 200);
    assert.equal(r.result, '["a","b"]');
});

// Object source
test("applyJsonItemEdit: object <-1>:{kv}:EDIT appends kv-pair", () => {
    const r = Slicer.jsonItemEdit('{"k1":1,"k2":2}', { marks: [-1] }, '{"k3":3}');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k2: 2, k3: 3 });
});

test("applyJsonItemEdit: object <-1>:{multi-key}:EDIT appends multiple kv-pairs", () => {
    const r = Slicer.jsonItemEdit('{"k1":1}', { marks: [-1] }, '{"k2":2,"k3":3}');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k2: 2, k3: 3 });
});

test("applyJsonItemEdit: object <N>:{kv}:EDIT replaces position N kv", () => {
    const r = Slicer.jsonItemEdit('{"k1":1,"k2":2,"k3":3}', { marks: [1] }, '{"newK":"newV"}');
    assert.equal(r.status, 200);
    const result = JSON.parse(r.result ?? "");
    assert.deepEqual(Object.entries(result), [["newK", "newV"], ["k2", 2], ["k3", 3]]);
});

test("applyJsonItemEdit: object <N>::EDIT deletes kv at position N", () => {
    const r = Slicer.jsonItemEdit('{"k1":1,"k2":2,"k3":3}', { marks: [2] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), { k1: 1, k3: 3 });
});

test("applyJsonItemEdit: object <1,-1>::EDIT clears to {}", () => {
    const r = Slicer.jsonItemEdit('{"k1":1}', { marks: [1, -1] }, "");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), {});
});

test("applyJsonItemEdit: object source with array body item → 400", () => {
    const r = Slicer.jsonItemEdit('{"k1":1}', { marks: [-1] }, "[1,2,3]");
    assert.equal(r.status, 400);
});

// Scalar source
test("applyJsonItemEdit: scalar <1>:newScalar:EDIT replaces", () => {
    const r = Slicer.jsonItemEdit('"hello"', { marks: [1] }, '"world"');
    assert.equal(r.status, 200);
    assert.equal(r.result, '"world"');
});

test("applyJsonItemEdit: scalar <1>:[ ]:EDIT (empty array body) deletes → null", () => {
    const r = Slicer.jsonItemEdit('"hello"', { marks: [1] }, "[]");
    assert.equal(r.status, 200);
    assert.equal(r.result, "null");
});

test("applyJsonItemEdit: scalar <-1> (grow) returns 400", () => {
    const r = Slicer.jsonItemEdit('"hello"', { marks: [-1] }, '"world"');
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: scalar <0> (grow) returns 400", () => {
    const r = Slicer.jsonItemEdit('"hello"', { marks: [0] }, '"world"');
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: scalar <1>:[a,b]:EDIT (multi-item body) → 400 (no implicit promotion)", () => {
    const r = Slicer.jsonItemEdit('"hello"', { marks: [1] }, '["a","b"]');
    assert.equal(r.status, 400);
});

// Errors
test("applyJsonItemEdit: malformed JSON source → 400", () => {
    const r = Slicer.jsonItemEdit("{not json", { marks: [1] }, '"x"');
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: malformed JSON body → 400", () => {
    const r = Slicer.jsonItemEdit('["a"]', { marks: [1] }, "{not json");
    assert.equal(r.status, 400);
});

test("applyJsonItemEdit: out-of-range position → 416", () => {
    const r = Slicer.jsonItemEdit('["a","b"]', { marks: [99] }, '"x"');
    assert.equal(r.status, 416);
});

test("lineMarkerEditBatch applies disjoint ranges against one snapshot", () => {
    const r = Slicer.lineMarkerEditBatch("one\ntwo\nthree\nfour\n", [
        { marker: { marks: [2] }, body: "TWO\n2.5" },
        { marker: { marks: [4] }, body: "FOUR" },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.result, "one\nTWO\n2.5\nthree\nFOUR\n");
});

test("lineMarkerEditBatch is invariant to the authored order of disjoint edits", () => {
    const source = "one\ntwo\nthree\nfour\n";
    const edits = [
        { marker: { marks: [2] as [number] }, body: "TWO\n2.5" },
        { marker: { marks: [4] as [number] }, body: "FOUR" },
    ];
    const forward = Slicer.lineMarkerEditBatch(source, edits);
    const reverse = Slicer.lineMarkerEditBatch(source, edits.toReversed());
    assert.equal(forward.status, 200);
    assert.equal(reverse.status, 200);
    assert.equal(reverse.result, forward.result);
});

test("lineMarkerEditBatch preserves three distant snapshot ranges across different deltas", () => {
    const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const r = Slicer.lineMarkerEditBatch(source, [
        { marker: { marks: [5, 6] }, body: "middle A\nmiddle B\nmiddle C\nmiddle D" },
        { marker: { marks: [2] }, body: "upper A\nupper B" },
        { marker: { marks: [10, 11] }, body: "lower" },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.result, [
        "line 1", "upper A", "upper B", "line 3", "line 4",
        "middle A", "middle B", "middle C", "middle D",
        "line 7", "line 8", "line 9", "lower", "line 12",
    ].join("\n"));
});

test("lineMarkerEditBatch composes one prepend and one append at distinct snapshot boundaries", () => {
    const r = Slicer.lineMarkerEditBatch("middle\n", [
        { marker: { marks: [-1] }, body: "last" },
        { marker: { marks: [0] }, body: "first" },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.result, "first\nmiddle\nlast\n");
});

test("lineMarkerEditBatch rejects overlap without producing a partial result", () => {
    const r = Slicer.lineMarkerEditBatch("one\ntwo\nthree\nfour\n", [
        { marker: { marks: [2, 3] }, body: "middle" },
        { marker: { marks: [3, 4] }, body: "tail" },
    ]);
    assert.equal(r.status, 409);
    assert.match(r.error ?? "", /overlap/);
    assert.equal(r.result, undefined);
});

test("lineMarkerEditBatch rejects whole-resource replacement mixed with another edit", () => {
    const r = Slicer.lineMarkerEditBatch("one\ntwo\n", [
        { marker: { marks: [1, -1] }, body: "all" },
        { marker: { marks: [-1] }, body: "tail" },
    ]);
    assert.equal(r.status, 409);
    assert.match(r.error ?? "", /whole-resource/);
});

test("jsonItemEditBatch preserves original item coordinates", () => {
    const r = Slicer.jsonItemEditBatch('["a","b","c","d"]', [
        { marker: { marks: [2] }, body: '["B","B2"]' },
        { marker: { marks: [4] }, body: '"D"' },
    ]);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.result ?? ""), ["a", "B", "B2", "c", "D"]);
});
