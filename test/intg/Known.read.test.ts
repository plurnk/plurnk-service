import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, LocalPath, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const localPath = (raw: string): LocalPath => ({ kind: "local", raw });

const editStatement = (opts: { target: ParsedPath; tags?: string[] | null; body?: string | null }): EditStatement => ({
    op: "EDIT", suffix: "",
    signal: opts.tags ?? null,
    target: opts.target,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: {
    target?: ParsedPath | null; tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null;
}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const setupContext = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("Known.read: existing entry — returns body content and mimetype with status 200", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/france/capital"), body: "Paris" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ target: urlPath("known", "/france/capital") }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Known.read: nonexistent path returns 404 with null content/mimetype", async () => {
    const { db, sessionId } = await setupContext();
    try {
        const result = await new Known().read(readStatement({ target: urlPath("known", "/nope") }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Known.read: null path returns 400", async () => {
    const { db, sessionId } = await setupContext();
    try {
        const result = await new Known().read(readStatement({ target: null }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 400);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Known.read: lineMarker <N> on text source returns raw line + text/markdown mimetype", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/lined"), body: "first\nsecond\nthird" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ target: urlPath("known", "/lined"), lineMarker: { first: 2, last: null } }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "second");
        assert.equal((result as { startLine?: number }).startLine, 2);
        // <L> on line-navigable source → text/markdown (text primitive).
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Known.read: regex body matcher returns JSON array of match rows", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/match"), body: "alpha beta alpha gamma" }), makeSchemeCtx({ db, sessionId, runId }));
        const matcher: MatcherBody = { dialect: "regex", raw: "/alpha/g", pattern: "alpha", flags: "g" };
        const result = await k.read(readStatement({ target: urlPath("known", "/match"), body: matcher }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        const rows = JSON.parse(result.content ?? "") as { line: number; matched: string }[];
        assert.deepEqual(rows, [
            { line: 1, matched: "alpha" },
            { line: 1, matched: "alpha" },
        ]);
    } finally { db.close(); }
});

test("Known.read: glob body matcher returns matching lines (line-filter primitive)", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/g"), body: "TODO: one\nhello\nTODO: two\nworld" }), makeSchemeCtx({ db, sessionId, runId }));
        const matcher: MatcherBody = { dialect: "glob", raw: "TODO*" };
        const result = await k.read(readStatement({ target: urlPath("known", "/g"), body: matcher }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        const rows = JSON.parse(result.content ?? "") as { line: number; matched: string }[];
        assert.deepEqual(rows, [
            { line: 1, matched: "TODO: one" },
            { line: 3, matched: "TODO: two" },
        ]);
    } finally { db.close(); }
});

test("Known.read: tag filter — entry has all requested tags → 200", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/tagged"), tags: ["france", "geography"], body: "Paris" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ target: urlPath("known", "/tagged"), tags: ["france"] }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
    } finally { db.close(); }
});

test("Known.read: tag filter — entry missing requested tag → 404", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/u"), tags: ["france"], body: "Paris" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ target: urlPath("known", "/u"), tags: ["germany"] }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 404);
    } finally { db.close(); }
});

test("Known.read: <L> + body matcher composes — slice first, match within, source lines preserved", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/c"), body: "one\nfoo and bar\nthree" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({
            target: urlPath("known", "/c"),
            lineMarker: { first: 2, last: 2 },
            body: { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" },
        }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        const rows = JSON.parse(result.content ?? "") as { line: number; matched: string }[];
        // Match was on source line 2 (after slice); baseLine preserved.
        assert.deepEqual(rows, [{ line: 2, matched: "foo" }]);
    } finally { db.close(); }
});

test("Known.read: empty tag signal ([]) is treated as no filter — read proceeds", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/empty-tags"), body: "ok" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ target: urlPath("known", "/empty-tags"), tags: [] }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "ok");
    } finally { db.close(); }
});

test("Known.read: edited entry round-trips through read — content matches what edit wrote", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const bodies = ["first", "second", "third"];
        const target = urlPath("known", "/rt");
        for (const body of bodies) {
            await k.edit(editStatement({ target, body }), makeSchemeCtx({ db, sessionId, runId }));
            const result = await k.read(readStatement({ target }), makeSchemeCtx({ db, sessionId }));
            assert.equal(result.status, 200);
            assert.equal(result.content, body);
        }
    } finally { db.close(); }
});

test("Known.read: bare local path reads by raw pathname", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ target: localPath("config/foo.json"), body: "{}" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ target: localPath("config/foo.json") }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "{}");
    } finally { db.close(); }
});

test("Known.read: different sessions see different entries at the same path", async () => {
    const db = await openMigrated();
    try {
        const sessionA = await insertSession(db, "ws-readiso-a");
        const sessionB = await insertSession(db, "ws-readiso-b");
        const runA = await insertRun(db, sessionA);
        const runB = await insertRun(db, sessionB);
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/x"), body: "from-A" }), makeSchemeCtx({ db, sessionId: sessionA, runId: runA }));
        await k.edit(editStatement({ target: urlPath("known", "/x"), body: "from-B" }), makeSchemeCtx({ db, sessionId: sessionB, runId: runB }));
        const a = await k.read(readStatement({ target: urlPath("known", "/x") }), makeSchemeCtx({ db, sessionId: sessionA }));
        const b = await k.read(readStatement({ target: urlPath("known", "/x") }), makeSchemeCtx({ db, sessionId: sessionB }));
        assert.equal(a.content, "from-A");
        assert.equal(b.content, "from-B");
    } finally { db.close(); }
});

test("Known.read: read against session A doesn't surface session B's entry", async () => {
    const db = await openMigrated();
    try {
        const sessionA = await insertSession(db, "ws-rd-a");
        const sessionB = await insertSession(db, "ws-rd-b");
        const runB = await insertRun(db, sessionB);
        const k = new Known();
        await k.edit(editStatement({ target: urlPath("known", "/only-b"), body: "B-only" }), makeSchemeCtx({ db, sessionId: sessionB, runId: runB }));
        const result = await k.read(readStatement({ target: urlPath("known", "/only-b") }), makeSchemeCtx({ db, sessionId: sessionA }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

// --- Extension-based mimetype (plurnk-grammar 0.14.0) ---------------

test("Known: path suffix `.json` declares mimetype; READ returns application/json", async () => {
    const { db, sessionId, runId } = await setupContext();
    const mimetypes = new Mimetypes({ tokenize: async (t: string) => t.length });
    await mimetypes.ready();
    try {
        const k = new Known();
        await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: '[{"name":"Alice"}]' }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        const result = await k.read(
            readStatement({ target: urlPath("known", "/users.json") }),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.equal(result.content, '[{"name":"Alice"}]');
    } finally { db.close(); }
});

test("Known: extension `.json` enables structural <L> dispatch on READ", async () => {
    const { db, sessionId, runId } = await setupContext();
    const mimetypes = new Mimetypes({ tokenize: async (t: string) => t.length });
    await mimetypes.ready();
    try {
        const k = new Known();
        await k.edit(
            editStatement({ target: urlPath("known", "/users.json"), body: '[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]' }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        // <L><2> on JSON source picks the 2nd item (Bob), wrapped in array.
        const result = await k.read(
            readStatement({ target: urlPath("known", "/users.json"), lineMarker: { first: 2, last: null } }),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        const items = JSON.parse(result.content ?? "") as object[];
        assert.deepEqual(items, [{ name: "Bob" }]);
    } finally { db.close(); }
});

test("Known: no path suffix → scheme default (text/markdown); <L> is line-based", async () => {
    const { db, sessionId, runId } = await setupContext();
    const mimetypes = new Mimetypes({ tokenize: async (t: string) => t.length });
    await mimetypes.ready();
    try {
        const k = new Known();
        await k.edit(
            editStatement({ target: urlPath("known", "/users"), body: "alpha\nbeta\ngamma" }),
            makeSchemeCtx({ db, sessionId, runId, mimetypes }),
        );
        // Without `.json` suffix, mimetype falls back to manifest default
        // (text/markdown). <L><2> is line-based.
        const result = await k.read(
            readStatement({ target: urlPath("known", "/users"), lineMarker: { first: 2, last: null } }),
            makeSchemeCtx({ db, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, "beta");
    } finally { db.close(); }
});
