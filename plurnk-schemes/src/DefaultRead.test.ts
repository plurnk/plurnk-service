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
    assert.equal(r.status, 200);
    assert.equal(r.body, whole);
    assert.deepEqual(r.matches, [{
        lineStart: 1,
        lineEnd: 1,
        rowStart: 1,
        rowEnd: 2,
        path: "$['name']",
    }]);
});

test("DefaultRead: matcher selects the full blob before <L> projects rows", async () => {
    const body: MatcherBody = { dialect: "regex", raw: "/needle/", pattern: "needle", flags: "" };
    const r = await DefaultRead.read(
        "heading\ncontext\nneedle later",
        "text/plain",
        stmt({ body, lineMarker: { marks: [1, 2] } }),
        mimetypes,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body, "heading\ncontext");
    assert.deepEqual(r.matches, [{
        lineStart: 3,
        lineEnd: 3,
        rowStart: 3,
        rowEnd: 3,
    }]);
});

test("DefaultRead: a scoped matcher miss is 204, not an empty-range 416", async () => {
    const body: MatcherBody = { dialect: "glob", raw: "absent" };
    const content = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const r = await DefaultRead.read(content, "text/plain", stmt({ body, lineMarker: { marks: [30, 80] } }), mimetypes);
    assert.equal(r.status, 204);
    assert.deepEqual(r.matches, []);
    assert.equal(r.problem, undefined);
});
