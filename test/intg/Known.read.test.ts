import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, LocalPath, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const localPath = (raw: string): LocalPath => ({ kind: "local", raw });

const editStatement = (opts: { path: ParsedPath; tags?: string[] | null; body?: string | null }): EditStatement => ({
    op: "EDIT", suffix: "",
    signal: opts.tags ?? null,
    path: opts.path,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: {
    path?: ParsedPath | null; tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null;
}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null,
    path: opts.path ?? null,
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
        await k.edit(editStatement({ path: urlPath("known", "/france/capital"), body: "Paris" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ path: urlPath("known", "/france/capital") }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Known.read: nonexistent path returns 404 with null content/mimetype", async () => {
    const { db, sessionId } = await setupContext();
    try {
        const result = await new Known().read(readStatement({ path: urlPath("known", "/nope") }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Known.read: null path returns 400", async () => {
    const { db, sessionId } = await setupContext();
    try {
        const result = await new Known().read(readStatement({ path: null }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 400);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Known.read: lineMarker present returns 501 without DB read", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ path: urlPath("known", "/lined"), body: "multi\nline\ncontent" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ path: urlPath("known", "/lined"), lineMarker: { first: 1, last: null } }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 501);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("Known.read: body matcher present returns 501 without DB read", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ path: urlPath("known", "/match"), body: "matchable content" }), makeSchemeCtx({ db, sessionId, runId }));
        const matcher: MatcherBody = { dialect: "glob", raw: "match*" };
        const result = await k.read(readStatement({ path: urlPath("known", "/match"), body: matcher }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 501);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("Known.read: tag filter (non-empty signal) returns 501 without DB read", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ path: urlPath("known", "/tagged"), tags: ["france"], body: "Paris" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ path: urlPath("known", "/tagged"), tags: ["france"] }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 501);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

test("Known.read: empty tag signal ([]) is treated as no filter — read proceeds", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ path: urlPath("known", "/empty-tags"), body: "ok" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ path: urlPath("known", "/empty-tags"), tags: [] }), makeSchemeCtx({ db, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "ok");
    } finally { db.close(); }
});

test("Known.read: edited entry round-trips through read — content matches what edit wrote", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        const bodies = ["first", "second", "third"];
        const path = urlPath("known", "/rt");
        for (const body of bodies) {
            await k.edit(editStatement({ path, body }), makeSchemeCtx({ db, sessionId, runId }));
            const result = await k.read(readStatement({ path }), makeSchemeCtx({ db, sessionId }));
            assert.equal(result.status, 200);
            assert.equal(result.content, body);
        }
    } finally { db.close(); }
});

test("Known.read: bare local path reads by raw pathname", async () => {
    const { db, sessionId, runId } = await setupContext();
    try {
        const k = new Known();
        await k.edit(editStatement({ path: localPath("config/foo.json"), body: "{}" }), makeSchemeCtx({ db, sessionId, runId }));
        const result = await k.read(readStatement({ path: localPath("config/foo.json") }), makeSchemeCtx({ db, sessionId }));
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
        await k.edit(editStatement({ path: urlPath("known", "/x"), body: "from-A" }), makeSchemeCtx({ db, sessionId: sessionA, runId: runA }));
        await k.edit(editStatement({ path: urlPath("known", "/x"), body: "from-B" }), makeSchemeCtx({ db, sessionId: sessionB, runId: runB }));
        const a = await k.read(readStatement({ path: urlPath("known", "/x") }), makeSchemeCtx({ db, sessionId: sessionA }));
        const b = await k.read(readStatement({ path: urlPath("known", "/x") }), makeSchemeCtx({ db, sessionId: sessionB }));
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
        await k.edit(editStatement({ path: urlPath("known", "/only-b"), body: "B-only" }), makeSchemeCtx({ db, sessionId: sessionB, runId: runB }));
        const result = await k.read(readStatement({ path: urlPath("known", "/only-b") }), makeSchemeCtx({ db, sessionId: sessionA }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});
