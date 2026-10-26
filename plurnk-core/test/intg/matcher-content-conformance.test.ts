// Composed coverage for {§find-glob-filter-on-content},
// {§find-source-agnostic}, and {§find-fulltext-selection}. Fixtures put matching
// text in either the pathname or content, never both, so querying the wrong
// surface cannot pass accidentally.

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, LineMarker, MatcherBody, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Workspace from "../../src/schemes/Workspace.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx } from "./_scheme.ts";
import { resourcePaths } from "./_find.ts";
import type { Db } from "../../src/core/Db.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const editStmt = (target: UrlPath, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target, lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

const findStmt = (target: UrlPath, matcher: MatcherBody | null, lineMarker: LineMarker | null = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target, lineMarker, matcher, body: null,
     position: { line: 1, column: 1 },
});

const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
const regex = (pattern: string, flags = ""): MatcherBody =>
    ({ dialect: "regex", raw: flags ? `/${pattern}/${flags}` : `/${pattern}/`, pattern, flags });

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

const seed = async (
    db: Db,
    workspaceId: number,
    sessionId: number,
    entries: Array<[string, string]>,
) => {
    const k = new Workspace();
    for (const [pathname, content] of entries) {
        await k.edit(editStmt(url(pathname), content), makeSchemeCtx({ db, workspaceId, sessionId }));
    }
};

// --- READ: exact-target text projection ----------------------------------
// Anchors "correct." The matched token appears ONLY in the content; the
// pathname shares no character with it, so a pathname-matcher returns nothing.

test("{§find-glob-filter-on-content}: FIND glob body matches entry content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // pathname "doc" contains no "TODO"; only the content does.
        await seed(db, workspaceId, sessionId, [["doc", "alpha\nTODO: ship\nbeta"]]);
        const r = await new Workspace().find(findStmt(url("doc"), glob("TODO*")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
    } finally { db.close(); }
});

test("{§find-glob-filter-on-content}: FIND regex body matches entry content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // pathname "doc" contains no "timeout"; only the content does.
        await seed(db, workspaceId, sessionId, [["doc", "heading\nalpha timeout beta\ncontext"]]);
        const r = await new Workspace().find(findStmt(url("doc"), regex("timeout")), makeSchemeCtx({ db, workspaceId }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
    } finally { db.close(); }
});

test("{§scope-slot}: READ <L> slices by line via the marker slot, not the body", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [["lines", "alpha\nbeta\ngamma"]]);
        const stmt: ReadStatement = { metadata: null, op: "READ", aside: null, target: url("lines"), lineMarker: { marks: [2, 2] }, matcher: null, body: null, position: { line: 1, column: 1 } };
        const r = await readThroughScheme("workspace", null, stmt, makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.match(r.content ?? "", /beta/);
        assert.doesNotMatch(r.content ?? "", /alpha|gamma/);
    } finally { db.close(); }
});

// --- FIND: body matcher runs against content ------------------------------
// Each workspace swaps the token between fields: the entry that matches by CONTENT
// is NOT the entry that matches by PATHNAME. The impl selects the content-bearing
// entry — a pathname-matcher would return the other one.

test("{§find-glob-filter-on-content}: FIND regex selects entries by content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [
            ["alpha", "timeout occurred"], // content matches /timeout/; pathname does not
            ["timeout", "all clear"],      // pathname matches /timeout/; content does not
        ]);
        const r = await new Workspace().find(findStmt(url(""), regex("timeout")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///alpha"]);
    } finally { db.close(); }
});

// A glob body selects entries whose CONTENT matches.
test("{§find-glob-filter-on-content}: FIND glob selects entries by content, not pathname", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [
            ["france/capital", "Paris is the capital"], // content matches Paris*; pathname does not
            ["Paris/note", "see the capital"],          // pathname matches Paris*; content does not
        ]);
        const r = await new Workspace().find(findStmt(url(""), glob("Paris*")), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///france/capital"]);
    } finally { db.close(); }
});

test("{§find-glob-filter-on-content}: FIND admits extglob groups and literal at-sign text end to end", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seed(db, workspaceId, sessionId, [
            ["first", "alpha"],
            ["second", "beta"],
            ["third", "gamma"],
            ["coordinates", "prefix @data/users.json suffix"],
        ]);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 });
        const grouped = await new Workspace().find(findStmt(url(""), glob("@(alpha|beta)")), ctx);
        assert.equal(grouped.status, 200);
        assert.deepEqual([...new Set(resourcePaths(grouped))], ["workspace:///first", "workspace:///second"]);

        const literal = await new Workspace().find(findStmt(url(""), glob("@data/users.json")), ctx);
        assert.equal(literal.status, 200);
        assert.deepEqual([...new Set(resourcePaths(literal))], ["workspace:///coordinates"]);
    } finally { db.close(); }
});

// --- FIND with structural dialects (jsonpath/xpath) over native content -------
// The dialects route through the mimetype handlers' deep-json / deep-xml channels; these
// prove they are wired through FIND end-to-end on their native mimetypes (NOT 501).

test("{§find-source-agnostic}: FIND JSONPath selects JSON entries by content structure", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // `.json` delimiter → application/json mimetype → the handler's deep-json channel.
        await seed(db, workspaceId, sessionId, [
            ["alice.json", '{"admin":true}'],
            ["bob.json", '{"guest":true}'],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "jsonpath", raw: "$.admin" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///alice.json"]);
    } finally { db.close(); }
});

test("{§find-source-agnostic}: FIND XPath selects XML entries by content structure", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // `.xml` delimiter → application/xml mimetype → the handler's deep-xml channel.
        await seed(db, workspaceId, sessionId, [
            ["a.xml", "<root><user>admin</user></root>"],
            ["b.xml", "<root><group>x</group></root>"],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "xpath", raw: "//user" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///a.xml"]);
    } finally { db.close(); }
});

// --- Cross-dialect: the payoff of filtering the deep channels ourselves --------
// process() builds BOTH deepJson and deepXml for every type, and we run the
// dialect against the matching projection — so xpath works on a JSON doc and
// jsonpath on an XML doc. Source mimetype is irrelevant to the dialect.

test("{§find-source-agnostic}: FIND XPath selects JSON entries through deepXml", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // JSON content → process() also yields deepXml (`<root><role>…</role></root>`); xpath runs over it.
        await seed(db, workspaceId, sessionId, [
            ["a.json", '{"role":"admin"}'],
            ["b.json", '{"name":"guest"}'],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "xpath", raw: "//role" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///a.json"]);
    } finally { db.close(); }
});

test("{§find-source-agnostic}: FIND JSONPath selects XML entries through deepJson", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // XML content → process() also yields deepJson (`…attrs.role`); jsonpath runs over it.
        await seed(db, workspaceId, sessionId, [
            ["a.xml", '<root><user role="admin">x</user></root>'],
            ["b.xml", '<root><user name="guest">x</user></root>'],
        ]);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "jsonpath", raw: "$..role" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0 }));
        assert.equal(r.status, 200);
        assert.deepEqual([...new Set(resourcePaths(r))], ["workspace:///a.xml"]);
    } finally { db.close(); }
});

test("{§find-fulltext-selection}: FIND ~query selects entries by native text matching", async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const { db, workspaceId, sessionId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });
        await new Workspace().edit(editStmt(url("a"), "the french revolution and the storming of the bastille"), ctx);
        await new Workspace().edit(editStmt(url("b"), "a recipe for chocolate cake"), ctx);
        await SearchIndex.maintain(ctx);
        const r = await new Workspace().find(findStmt(url(""), { dialect: "fts", raw: "~french AND revolution" }), makeSchemeCtx({ db, workspaceId, sessionId, loopId: 0, turnId: 0, mimetypes }));
        assert.equal(r.status, 200);
        assert.equal(resourcePaths(r)[0], "workspace:///a", "markerless full-text FIND returns the matching document");
    } finally { db.close(); }
});
