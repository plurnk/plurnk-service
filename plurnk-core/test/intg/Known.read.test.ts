import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, LocalPath, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const localPath = (raw: string): LocalPath => ({ kind: "local", raw });

const fullReplace: LineMarker = { marks: [1, -1] };
const editStatement = (opts: { target: ParsedPath; tags?: string[] | null; body?: string | null; lineMarker?: LineMarker | null }): EditStatement => ({
    op: "EDIT", suffix: "",
    signal: opts.tags ?? null,
    target: opts.target,
    lineMarker: opts.lineMarker ?? null,
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
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

test("Known.read: existing entry — returns body content and mimetype with status 200", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/france/capital"), body: "Paris" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await k.read(readStatement({ target: urlPath("worker", "/france/capital") }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Known.read: nonexistent path returns 404 with null content/mimetype", async () => {
    const { db, workspaceId } = await setupContext();
    try {
        const result = await new Worker().read(readStatement({ target: urlPath("worker", "/nope") }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Known.read: null path returns 400", async () => {
    const { db, workspaceId } = await setupContext();
    try {
        const result = await new Worker().read(readStatement({ target: null }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 400);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Known.read: lineMarker <N> on text source returns raw line + text/markdown mimetype", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/lined"), body: "first\nsecond\nthird" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await k.read(readStatement({ target: urlPath("worker", "/lined"), lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "second");
        assert.equal((result as { startLine?: number }).startLine, 2);
        // <L> on line-navigable source → text/markdown (text primitive).
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Known.read: regex matcher selects the resource and reports coordinates", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/match"), body: "alpha beta alpha gamma" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const matcher: MatcherBody = { dialect: "regex", raw: "/alpha/g", pattern: "alpha", flags: "g" };
        const result = await k.read(readStatement({ target: urlPath("worker", "/match"), body: matcher }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, "alpha beta alpha gamma");
        assert.deepEqual(result.matches, [{
            lineStart: 1,
            lineEnd: 1,
            rowStart: 1,
            rowEnd: 1,
        }]);
    } finally { db.close(); }
});

test("Known.read: glob matcher selects the resource and reports match coordinates", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/g"), body: "TODO: one\nhello\nTODO: two\nworld" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const matcher: MatcherBody = { dialect: "glob", raw: "TODO*" };
        const result = await k.read(readStatement({ target: urlPath("worker", "/g"), body: matcher }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, "TODO: one\nhello\nTODO: two\nworld");
        assert.deepEqual(result.matches, [
            { lineStart: 1, lineEnd: 1, rowStart: 1, rowEnd: 1 },
            { lineStart: 3, lineEnd: 3, rowStart: 3, rowEnd: 3 },
        ]);
    } finally { db.close(); }
});

test("Known.read: tag filter — entry has all requested tags → 200", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/tagged"), tags: ["france", "geography"], body: "Paris" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await k.read(readStatement({ target: urlPath("worker", "/tagged"), tags: ["france"] }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
    } finally { db.close(); }
});

test("Known.read: tag filter — entry missing requested tag → 404", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/u"), tags: ["france"], body: "Paris" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await k.read(readStatement({ target: urlPath("worker", "/u"), tags: ["germany"] }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 404);
    } finally { db.close(); }
});

test("Known.read: matcher selects the full resource before <L> projects readable rows", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/c"), body: "one\nprojected\nfoo later" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await k.read(readStatement({
            target: urlPath("worker", "/c"),
            lineMarker: { marks: [1, 2] },
            body: { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" },
        }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "one\nprojected", "the later match selects the entry but is not substituted for the requested rows");
        assert.equal(result.startLine, 1);
        assert.deepEqual(result.matches, [{
            lineStart: 3,
            lineEnd: 3,
            rowStart: 3,
            rowEnd: 3,
        }]);
    } finally { db.close(); }
});

test("Known.read: empty tag signal ([]) is treated as no filter — read proceeds", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/empty-tags"), body: "ok" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await k.read(readStatement({ target: urlPath("worker", "/empty-tags"), tags: [] }), makeSchemeCtx({ db, workspaceId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "ok");
    } finally { db.close(); }
});

test("Known.read: edited entry round-trips through read — content matches what edit wrote", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const bodies = ["first", "second", "third"];
        const target = urlPath("worker", "/rt");
        for (const [i, body] of bodies.entries()) {
            // First iteration creates (markerless); the rest re-edit an existing entry, which
            // needs the deliberate full-replace marker (§edit-marker-required-on-existing).
            await k.edit(editStatement({ target, body, lineMarker: i === 0 ? null : fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
            const result = await k.read(readStatement({ target }), makeSchemeCtx({ db, workspaceId }));
            assert.equal(result.status, 200);
            assert.equal(result.content, body);
        }
    } finally { db.close(); }
});



test("Known.read: different workspaces see different entries at the same path", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-readiso-a");
        const workspaceB = await insertWorkspace(db, "ws-readiso-b");
        const workerA = await insertWorker(db, workspaceA);
        const workerB = await insertWorker(db, workspaceB);
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/x"), body: "from-A" }), makeSchemeCtx({ db, workspaceId: workspaceA, workerId: workerA }));
        await k.edit(editStatement({ target: urlPath("worker", "/x"), body: "from-B" }), makeSchemeCtx({ db, workspaceId: workspaceB, workerId: workerB }));
        const a = await k.read(readStatement({ target: urlPath("worker", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceA }));
        const b = await k.read(readStatement({ target: urlPath("worker", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceB }));
        assert.equal(a.content, "from-A");
        assert.equal(b.content, "from-B");
    } finally { db.close(); }
});

test("Known.read: read against workspace A doesn't surface workspace B's entry", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-rd-a");
        const workspaceB = await insertWorkspace(db, "ws-rd-b");
        const workerB = await insertWorker(db, workspaceB);
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/only-b"), body: "B-only" }), makeSchemeCtx({ db, workspaceId: workspaceB, workerId: workerB }));
        const result = await k.read(readStatement({ target: urlPath("worker", "/only-b") }), makeSchemeCtx({ db, workspaceId: workspaceA }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

// --- Extension-based mimetype (plurnk-grammar 0.14.0) ---------------

test("Known: path suffix `.json` declares mimetype; READ returns application/json", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({ target: urlPath("worker", "/users.json"), body: '[{"name":"Alice"}]' }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const result = await k.read(
            readStatement({ target: urlPath("worker", "/users.json") }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.equal(result.content, '[{"name":"Alice"}]');
    } finally { db.close(); }
});

test("Known: extension `.json` enables structural <L> dispatch on READ", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({ target: urlPath("worker", "/users.json"), body: '[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"}]' }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        // <L><2> on JSON source picks the 2nd item (Bob), wrapped in array.
        const result = await k.read(
            readStatement({ target: urlPath("worker", "/users.json"), lineMarker: { marks: [2] } }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        const items = JSON.parse(result.content ?? "") as object[];
        assert.deepEqual(items, [{ name: "Bob" }]);
    } finally { db.close(); }
});

test("Known: no path suffix → scheme default (text/markdown); <L> is line-based", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({ target: urlPath("worker", "/users"), body: "alpha\nbeta\ngamma" }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        // Without `.json` suffix, mimetype falls back to manifest default
        // (text/markdown). <L><2> is line-based.
        const result = await k.read(
            readStatement({ target: urlPath("worker", "/users"), lineMarker: { marks: [2] } }),
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, "beta");
    } finally { db.close(); }
});
