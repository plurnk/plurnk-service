import test from "node:test";
import { strict as assert } from "node:assert";
import type { ReadStatement, MatcherBody } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import DefaultRead from "./DefaultRead.ts";

const mimetypes = new Mimetypes({ defaultMimetype: "text/markdown" });
await mimetypes.ready();

const stmt = (over: Partial<ReadStatement>): ReadStatement => ({
    op: "READ", suffix: "READ", signal: null, target: null,
    lineMarker: null, body: null, position: { line: 0, column: 0 }, ...over,
});

test("DefaultRead: no marker, no body → the whole blob", async () => {
    const r = await DefaultRead.read("hello\nworld", "text/plain", stmt({}), mimetypes);
    assert.deepEqual(r, { status: 200, body: "hello\nworld" });
});

test("DefaultRead: <L> line marker slices via Slicer", async () => {
    const r = await DefaultRead.read("a\nb\nc", "text/plain", stmt({ lineMarker: { marks: [2] } }), mimetypes);
    assert.equal(r.status, 200);
    assert.equal(r.body, "b");
});

test("DefaultRead: <2.5> insert-point selects no content for READ (sentinel)", async () => {
    const r = await DefaultRead.read("a\nb\nc", "text/plain", stmt({ lineMarker: { marks: [2.5] } }), mimetypes);
    assert.equal(r.status, 200);
    assert.equal(r.body, "");
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

test("DefaultRead: matcher body routes through Matcher (jsonpath dispatch)", async () => {
    const body: MatcherBody = { dialect: "jsonpath", raw: "$.name" };
    const whole = '{"name":"x","age":3}';
    const r = await DefaultRead.read(whole, "application/json", stmt({ body }), mimetypes);
    // Routed through Matcher, not the whole-blob passthrough: either a 200 match
    // or a 203 dialect-fallback — never the untouched {200, whole}.
    assert.equal(typeof r.status, "number");
    assert.ok(!(r.status === 200 && r.body === whole), `expected matcher routing, got passthrough: ${JSON.stringify(r)}`);
});
