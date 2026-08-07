import test from "node:test";
import { strict as assert } from "node:assert";
import type { ReadStatement, MatcherBody } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import DefaultRead from "./DefaultRead.ts";

const mimetypes = new Mimetypes({ defaultMimetype: "text/markdown" });
await mimetypes.ready();

const stmt = (over: Partial<ReadStatement>): ReadStatement => ({
    op: "READ", suffix: "READ", signal: null, target: null,
    lineMarker: null, body: null, position: { line: 0, column: 0 }, ...over,
});

test("DefaultRead: no marker defaults to <1,16>", async () => {
    const r = await DefaultRead.read("hello\nworld", "text/plain", stmt({}), mimetypes);
    assert.equal(r.status, 200);
    assert.equal(r.body, "hello\nworld");
    assert.equal(r.startLine, 1);
});

test("DefaultRead: explicit <1,-1> reads the complete blob", async () => {
    const r = await DefaultRead.read("hello\nworld", "text/plain", stmt({ lineMarker: { marks: [1, -1] } }), mimetypes);
    assert.equal(r.status, 200);
    assert.equal(r.body, "hello\nworld");
    assert.equal(r.startLine, 1);
});

test("DefaultRead: <L> line marker slices via Slicer", async () => {
    const r = await DefaultRead.read("a\nb\nc", "text/plain", stmt({ lineMarker: { marks: [2] } }), mimetypes);
    assert.equal(r.status, 200);
    assert.equal(r.body, "b");
    assert.equal(r.startLine, 2);
    assert.deepEqual(r.region, {
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 2,
    });
});

test("DefaultRead: a fractional text scope is rejected", async () => {
    const r = await DefaultRead.read("a\nb\nc", "text/plain", stmt({ lineMarker: { marks: [2.5] } }), mimetypes);
    assert.equal(r.status, 416);
    assert.match(r.problem?.detail ?? "", /integer coordinates/);
});

test("DefaultRead: failed slices preserve the structured source extent", async () => {
    const r = await DefaultRead.read("a\nb", "text/plain", stmt({ lineMarker: { marks: [9] } }), mimetypes);
    assert.equal(r.status, 416);
    assert.deepEqual(r.range, {
        unit: "line",
        requested: { first: 9, last: null },
        available: { first: 1, last: 2, total: 2 },
    });
});
