// {§edit-pattern} — a pattern on an EDIT replaces each matching span, within its line, with the
// literal body; every touched line's anchor guards the batch. Zero matches change nothing.
import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, MatcherBody } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { urlPath, editStmt } from "./_dsl.ts";
import PacketWire from "../../src/core/packet-wire.ts";

const setup = async (content = "alpha foo\nfoo bar foo\nbeta\nfoo", pathname = "/notes.md") => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await new Worker().edit(editStmt(urlPath("worker", pathname), content), makeSchemeCtx({ db, workspaceId: env.workspaceId, workerId: env.workerId }));
    let sequence = 0;
    const dispatch = (statement: EditStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    const body = async () => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname, name: "body" }))?.content;
    return { db, dispatch, body };
};

const target = urlPath("worker", "/notes.md");
const regex = (pattern: string, flags = ""): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/${flags}`, pattern, flags });

test("a literal pattern replaces every occurrence on every line with the literal body", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "baz", null, { dialect: "glob", raw: "foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4, "every occurrence counts, two on one line included");
        assert.equal(await body(), "alpha baz\nbaz bar baz\nbeta\nbaz");
        const receipt = r.receipt as { effect: { requested: string } };
        assert.equal(receipt.effect.requested, "<1,7,1,10>", "the receipt is the first span's coordinate edit");
        assert.equal((r.last as { requested: string }).requested, "<4,1,4,4>", "and the last span rides beside it");
    } finally { await db.close(); }
});

test("a regex pattern replaces its spans; the body is literal, never a template", async () => {
    const { db, dispatch, body } = await setup("id: 12\nid: 345\nname: x");
    try {
        const r = await dispatch(editStmt(target, "$1-<0>", null, regex("\\d+")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 2);
        assert.equal(await body(), "id: $1-<0>\nid: $1-<0>\nname: x");
    } finally { await db.close(); }
});

test("a scope bounds the lines a pattern may touch; a glob with metacharacters replaces whole lines", async () => {
    const { db, dispatch, body } = await setup("keep\nold value\nold thing\nkeep");
    try {
        const r = await dispatch(editStmt(target, "new", { marks: [2] }, { dialect: "glob", raw: "old*" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "keep\nnew\nold thing\nkeep");
    } finally { await db.close(); }
});

test("zero matches change nothing and answer 204 with matched 0", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "baz", null, { dialect: "glob", raw: "absent" }));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(await body(), "alpha foo\nfoo bar foo\nbeta\nfoo");
    } finally { await db.close(); }
});

test("an empty body deletes the matched spans and leaves the lines", async () => {
    const { db, dispatch, body } = await setup("a foo b\nfoo");
    try {
        const r = await dispatch(editStmt(target, "", null, { dialect: "glob", raw: "foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(await body(), "a  b\n", "spans go, lines stay");
    } finally { await db.close(); }
});

test("a pattern that would span a line break is refused before any change", async () => {
    const { db, dispatch, body } = await setup("one\ntwo");
    try {
        const r = await dispatch(editStmt(target, "x", null, regex("one\\ntwo")));
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.match(String(r.problem?.type), /\/pattern-span-invalid$/);
        assert.equal(await body(), "one\ntwo");
    } finally { await db.close(); }
});

test("a node-selecting pattern replaces each node's whole region, across lines", async () => {
    const xml = "<books>\n  <book>\n    <title>A</title>\n    <price>40</price>\n  </book>\n  <book>\n    <title>B</title>\n    <price>10</price>\n  </book>\n</books>";
    const { db, dispatch, body } = await setup(xml, "/books.xml");
    try {
        const r = await dispatch(editStmt(urlPath("worker", "/books.xml"), "<book/>", null, { dialect: "xpath", raw: "//book[price > 35]" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        // The node's region is the handler's evidence, the same region a FIND reports: here it
        // starts at the line's first column, so the indentation goes with the element.
        assert.equal(await body(), "<books>\n<book/>\n  <book>\n    <title>B</title>\n    <price>10</price>\n  </book>\n</books>");
    } finally { await db.close(); }
});

test("a jsonpath pattern with an empty body removes the selected nodes' text", async () => {
    const { db, dispatch, body } = await setup('{"items": [\n  {"name": "a", "price": 10},\n  {"name": "b", "price": 50}\n]}', "/data.json");
    try {
        const r = await dispatch(editStmt(urlPath("worker", "/data.json"), "", null, { dialect: "jsonpath", raw: "$.items[?(@.price > 20)]" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), '{"items": [\n  {"name": "a", "price": 10},\n  \n]}');
    } finally { await db.close(); }
});

test("a resource-selecting dialect on an EDIT is refused: it names no spans", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(editStmt(target, "x", null, { dialect: "fts", raw: "~foo" }));
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.match(String(r.problem?.type), /\/pattern-dialect-unsupported$/);
    } finally { await db.close(); }
});

// {§edit-pattern} {§readable-channel} — a regex splices the source channel's own coordinates: on
// HTML the markup, never the readable projection beside it.
test("a regex pattern edits HTML source coordinates; the readable projection follows", async () => {
    const { db, dispatch, body } = await setup("<html>\n  <body>\n    <h1>Team Roster</h1>\n  </body>\n</html>", "/users.html");
    try {
        const r = await dispatch(editStmt(urlPath("worker", "/users.html"), "<h2>Roster</h2>", null, { dialect: "regex", raw: "/<h1>.*<\\/h1>/", pattern: "<h1>.*<\\/h1>", flags: "" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "<html>\n  <body>\n    <h2>Roster</h2>\n  </body>\n</html>");
        const projection = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/users.html", name: "readable" });
        assert.match(String(projection?.content), /Roster/, "the derived projection followed the source write");
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} a multi-span pattern receipt renders as a packet row: both boundaries, every line framed", async () => {
    const { db, dispatch, body } = await setup("alpha\nbeta\ngamma\ndelta");
    try {
        const r = await dispatch(editStmt(target, "A", null, regex("a$", "gm")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4);
        assert.equal(await body(), "alphA\nbetA\ngammA\ndeltA");
        assert.ok("last" in r, "several spans: the receipt carries the last boundary beside the first");
        const entry = { coordinate: "1/1/1", origin: "model", op: "EDIT", status: 200, folded: [], target: { scheme: "worker", pathname: "/notes.md" }, tx: { body: "A" }, rx: r };
        // The next packet renders this row; a body with an unframed line is a 500 on the whole loop.
        const rendered = PacketWire.renderLog([entry], (s: string) => Math.ceil(s.length / 4));
        assert.match(rendered, /alphA/u);
        assert.match(rendered, /deltA/u);
        assert.doesNotMatch(rendered, /\n\n *[1-9]\d*<@/u, "no blank line inside the receipt body");
    } finally { await db.close(); }
});
