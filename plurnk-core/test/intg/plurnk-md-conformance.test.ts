// Conformance tests for the canonical examples in plurnk.md.
//
// Each test reconstructs the world a plurnk.md example presupposes and asserts
// the behavior the example demonstrates. The worlds are built DISCRIMINATING:
// every matchable token lives in exactly one field (pathname XOR content), and
// the two fields are swapped between entries — so "match the pathname" and
// "match the content" return DISJOINT results. An implementation that matches
// the wrong field cannot pass by accident.
//
// Contract (plurnk.md "Pattern Filtering"): the
// (target) selects WHICH entries are candidates; the body matcher runs against
// the entry CONTENT. The canonical examples are unambiguous about this:
//   <|FIND(config/**/*.xml)>//user[@role='admin']<FIND|>   — xpath over XML content
//   <|FIND(log:///**/error)>/timeout|deadline exceeded/i<FIND|> — regex over log content
// The path-globs live in the (target); the body is the content matcher.
//
// READ resolves via read-resolve; FIND runs its body matcher through
// _entry-find (#matchPathnames -> matchAgainstContent) against the candidate's
// CONTENT, returning the matched entries' catalog rows.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, FindStatement, LineMarker, MatcherBody, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";

// One plurnk.md example (FIND ~query RAG) asserts REAL vector ranking — re-enable the embedder the
// Mock bootstrap turns off; --test-isolation scopes this to this file.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, body: MatcherBody | null, lineMarker: LineMarker | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal: null, target, lineMarker, body,
    position: { line: 1, column: 1 },
});

const readStmt = (target: UrlPath): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
const regex = (pattern: string, flags = ""): MatcherBody =>
    ({ dialect: "regex", raw: flags ? `/${pattern}/${flags}` : `/${pattern}/`, pattern, flags });

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

const seed = async (
    db: import("../../src/core/Db.ts").Db,
    workspaceId: number,
    workerId: number,
    entries: Array<[string, string]>,
) => {
    const k = new Worker();
    for (const [pathname, content] of entries) {
        await k.edit(editStmt(url(pathname), content), makeSchemeCtx({ db, workspaceId, workerId }));
    }
};

// --- READ: exact-target text projection ----------------------------------
// Anchors "correct." The matched token appears ONLY in the content; the
// pathname shares no character with it, so a pathname-matcher returns nothing.

test("[plurnk.md-FIND-glob-on-content] FIND glob body matches entry CONTENT, not pathname", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // pathname "doc" contains no "TODO"; only the content does.
        await seed(db, workspaceId, workerId, [["doc", "alpha\nTODO: ship\nbeta"]]);
        const r = await new Worker().find(findStmt(url("doc"), glob("TODO*")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
    } finally { db.close(); }
});

test("[plurnk.md-FIND-regex-on-content] FIND regex body matches entry CONTENT, not pathname", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // pathname "doc" contains no "timeout"; only the content does.
        await seed(db, workspaceId, workerId, [["doc", "heading\nalpha timeout beta\ncontext"]]);
        const r = await new Worker().find(findStmt(url("doc"), regex("timeout")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
    } finally { db.close(); }
});

// plurnk.md: <|READ(/etc/hosts)<2>|> — the line-slice rides the <L> marker
// slot (NOT the body matcher). Read line 2 of a 3-line entry → just that line.
// Pins the <L>?:body? slot order — the seam the live READ-<2> mis-slot exposed.
test("[plurnk.md-ex-READ-line-slice] READ <L> slices by line via the marker slot, not the body", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seed(db, workspaceId, workerId, [["lines", "alpha\nbeta\ngamma"]]);
        const stmt: ReadStatement = { op: "READ", suffix: "", signal: null, target: url("lines"), lineMarker: { marks: [2, 2] }, body: null, position: { line: 1, column: 1 } };
        const r = await lookThroughScheme("worker", null, stmt, makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /beta/);
        assert.doesNotMatch(r.content ?? "", /alpha|gamma/);
    } finally { db.close(); }
});

// --- FIND: body matcher runs against CONTENT (plurnk.md ex. above) --------
// Each world swaps the token between fields: the entry that matches by CONTENT
// is NOT the entry that matches by PATHNAME. The impl selects the content-bearing
// entry — a pathname-matcher (the old divergence) would return the other one.

// plurnk.md: <|FIND(log:///**/error)>/timeout|deadline exceeded/i<FIND|>
//   → select entries whose CONTENT matches the regex.
test("[plurnk.md-ex-FIND-regex-on-content] FIND regex body selects entries by CONTENT, not pathname", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seed(db, workspaceId, workerId, [
            ["alpha", "timeout occurred"], // content matches /timeout/; pathname does not
            ["timeout", "all clear"],      // pathname matches /timeout/; content does not
        ]);
        const r = await new Worker().find(findStmt(url(""), regex("timeout")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///alpha"]);
    } finally { db.close(); }
});

// A glob body selects entries whose CONTENT matches.
test("[plurnk.md-ex-FIND-glob-on-content] FIND glob body selects entries by CONTENT, not pathname", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seed(db, workspaceId, workerId, [
            ["france/capital", "Paris is the capital"], // content matches Paris*; pathname does not
            ["Paris/note", "see the capital"],          // pathname matches Paris*; content does not
        ]);
        const r = await new Worker().find(findStmt(url(""), glob("Paris*")), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///france/capital"]);
    } finally { db.close(); }
});

// --- FIND with structural dialects (jsonpath/xpath) over native content -------
// plurnk.md: <|FIND(config/**/*.xml)>//user[@role='admin']<FIND|> — xpath over XML.
// The dialects route through the plugin's deep-json / deep-xml channels; these
// prove they are wired through FIND end-to-end on their native mimetypes (NOT 501).

test("[plurnk.md-ex-FIND-jsonpath-on-json] FIND jsonpath selects JSON entries by content structure", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // `.json` suffix → application/json mimetype → plugin's deep-json channel.
        await seed(db, workspaceId, workerId, [
            ["alice.json", '{"admin":true}'],
            ["bob.json", '{"guest":true}'],
        ]);
        const r = await new Worker().find(findStmt(url(""), { dialect: "jsonpath", raw: "$.admin" }), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///alice.json"]);
    } finally { db.close(); }
});

test("[plurnk.md-ex-FIND-xpath-on-xml] FIND xpath selects XML entries by content structure", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // `.xml` suffix → application/xml mimetype → plugin's deep-xml channel.
        await seed(db, workspaceId, workerId, [
            ["a.xml", "<root><user>admin</user></root>"],
            ["b.xml", "<root><group>x</group></root>"],
        ]);
        const r = await new Worker().find(findStmt(url(""), { dialect: "xpath", raw: "//user" }), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///a.xml"]);
    } finally { db.close(); }
});

// --- Cross-dialect: the payoff of filtering the deep channels ourselves --------
// process() builds BOTH deepJson and deepXml for every type, and we run the
// dialect against the matching projection — so xpath works on a JSON doc and
// jsonpath on an XML doc. Source mimetype is irrelevant to the dialect.

test("[plurnk.md-ex-FIND-xpath-on-json] FIND xpath selects JSON entries by structure (over deepXml)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // JSON content → process() also yields deepXml (`<root><role>…</role></root>`); xpath runs over it.
        await seed(db, workspaceId, workerId, [
            ["a.json", '{"role":"admin"}'],
            ["b.json", '{"name":"guest"}'],
        ]);
        const r = await new Worker().find(findStmt(url(""), { dialect: "xpath", raw: "//role" }), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///a.json"]);
    } finally { db.close(); }
});

test("[plurnk.md-ex-FIND-jsonpath-on-xml] FIND jsonpath selects XML entries by structure (over deepJson)", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // XML content → process() also yields deepJson (`…attrs.role`); jsonpath runs over it.
        await seed(db, workspaceId, workerId, [
            ["a.xml", '<root><user role="admin">x</user></root>'],
            ["b.xml", '<root><user name="guest">x</user></root>'],
        ]);
        const r = await new Worker().find(findStmt(url(""), { dialect: "jsonpath", raw: "$..role" }), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(r.results.map((f) => f.path))], ["worker:///a.xml"]);
    } finally { db.close(); }
});

// plurnk.md: `<|FIND(worker:///**)>~constitutional history<FIND|>`
// — markerless RAG semantic similarity, using the universal first-16 page. Runs against the REAL embedder
// (all-MiniLM-L6-v2 via @plurnk/plurnk-mimetypes-embeddings) — the production tile+embed
// path, not a model-free stub. Semantics is normal intg coverage; the model load is an
// accepted cost (AGENTS: no fast-tier carve-out that hides a working feature). The body
// `raw` is the bare query the parser yields after consuming the ~ sigil (_entry-find.ts:82).
test("[plurnk.md-ex-FIND-rag] FIND ~query selects entries by semantic similarity", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const { db, workspaceId, workerId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        await new Worker().edit(editStmt(url("a"), "the french revolution and the storming of the bastille"), ctx);
        await new Worker().edit(editStmt(url("b"), "a recipe for chocolate cake"), ctx);
        await SearchIndex.maintain(ctx);  // store real embeddings via the plugin
        const r = await new Worker().find(findStmt(url(""), { dialect: "semantic", raw: "french revolutionary history" }), makeSchemeCtx({ db, workspaceId, workerId, loopId: 0, turnId: 0, mimetypes }));
        assert.equal(r.status, 200);
        assert.equal(r.results[0]?.path, "worker:///a", "markerless semantic FIND ranks the closest document first");
    } finally { db.close(); }
});
