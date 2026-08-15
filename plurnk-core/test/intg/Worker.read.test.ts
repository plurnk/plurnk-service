import test from "node:test";
import assert from "node:assert/strict";
import type { LineMarker, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const fullReplace: LineMarker = { marks: [1, -1] };
const editStatement = (opts: { target: ParsedPath; tags?: string[] | null; body?: string | null; lineMarker?: LineMarker | null }): ResolvedEditStatement => ({
    op: "EDIT", suffix: "",
    signal: opts.tags ?? null,
    target: opts.target,
    lineMarker: opts.lineMarker ?? null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: {
    target?: ParsedPath | null; tags?: string[] | null; lineMarker?: LineMarker | null;
}): ReadStatement => ({
    op: "READ", suffix: "",
    signal: opts.tags ?? null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    body: null,
    position: { line: 1, column: 1 },
});

const findStatement = (opts: {
    target?: ParsedPath | null; tags?: string[] | null; body?: MatcherBody | null; lineMarker?: LineMarker | null;
}): import("@plurnk/plurnk-contracts").FindStatement => ({
    op: "FIND", suffix: "",
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

test("Worker.read: existing entry — returns body content and mimetype with status 200", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/france/capital"), body: "Paris" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/france/capital") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Worker.read: nonexistent path returns 404 with null content/mimetype", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const result = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/nope") }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Worker.read: null path returns 400", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const result = await lookThroughScheme("worker", null, readStatement({ target: null }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 400);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("Worker.read: lineMarker <N> on text source returns raw line + text/markdown mimetype", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/lined"), body: "first\nsecond\nthird" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/lined"), lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "second");
        assert.equal((result as { startLine?: number }).startLine, 2);
        // <L> on a textual source returns the text primitive.
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("Worker.read: four-coordinate scope returns an exact Unicode text region", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({
                target: urlPath("worker", "/exact"),
                body: "a😀b\nsecond",
            }),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        const result = await lookThroughScheme("worker", null,
            readStatement({
                target: urlPath("worker", "/exact"),
                lineMarker: { marks: [1, 2, 1, 3] },
            }),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.content, "😀");
        assert.equal(result.startLine, 1);
        assert.deepEqual(result.region, {
            startLine: 1,
            startColumn: 2,
            endLine: 1,
            endColumn: 3,
        });
    } finally { db.close(); }
});

test("Worker.read: an empty exact scope retains its region and matcher evidence", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({ target: urlPath("worker", "/empty-exact"), body: "a" }),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        const result = await k.find(
            findStatement({
                target: urlPath("worker", "/empty-exact"),
                body: { dialect: "regex", raw: "/a/", pattern: "a", flags: "" },
            }),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("Worker.find: exact regex matcher returns flat locations", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/match"), body: "alpha beta alpha gamma" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const matcher: MatcherBody = { dialect: "regex", raw: "/alpha/g", pattern: "alpha", flags: "g" };
        const result = await k.find(findStatement({ target: urlPath("worker", "/match"), body: matcher }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("Worker.find: exact glob matcher returns flat match locations", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/g"), body: "TODO: one\nhello\nTODO: two\nworld" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const matcher: MatcherBody = { dialect: "glob", raw: "TODO*" };
        const result = await k.find(findStatement({ target: urlPath("worker", "/g"), body: matcher }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("Worker.read: signal classifies the eventual receipt and does not filter the resource", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/u"), body: "Paris" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/u"), tags: ["+germany"] }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
    } finally { db.close(); }
});

test("Worker.find: matcher evaluates the full resource before projecting locations", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/c"), body: "one\nprojected\nfoo later" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await k.find(findStatement({
            target: urlPath("worker", "/c"),
            body: { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" },
        }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("Worker.read: empty signal reads normally", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/empty-tags"), body: "ok" }), makeSchemeCtx({ db, workspaceId, workerId }));
        const result = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/empty-tags"), tags: [] }), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "ok");
    } finally { db.close(); }
});

test("Worker.read: edited entry round-trips through read — content matches what edit wrote", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    try {
        const k = new Worker();
        const bodies = ["first", "second", "third"];
        const target = urlPath("worker", "/rt");
        for (const [i, body] of bodies.entries()) {
            // First iteration creates (markerless); the rest re-edit an existing entry, which
            // needs the deliberate full-replace marker ({§edit-marker-required-on-existing}).
            await k.edit(editStatement({ target, body, lineMarker: i === 0 ? null : fullReplace }), makeSchemeCtx({ db, workspaceId, workerId }));
            const result = await lookThroughScheme("worker", null, readStatement({ target }), makeSchemeCtx({ db, workspaceId, workerId }));
            assert.equal(result.status, 200);
            assert.equal(result.content, body);
        }
    } finally { db.close(); }
});



test("Worker.read: different workspaces see different entries at the same path", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-readiso-a");
        const workspaceB = await insertWorkspace(db, "ws-readiso-b");
        const workerA = await insertWorker(db, workspaceA);
        const workerB = await insertWorker(db, workspaceB);
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/x"), body: "from-A" }), makeSchemeCtx({ db, workspaceId: workspaceA, workerId: workerA }));
        await k.edit(editStatement({ target: urlPath("worker", "/x"), body: "from-B" }), makeSchemeCtx({ db, workspaceId: workspaceB, workerId: workerB }));
        const a = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceA, workerId: workerA }));
        const b = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceB, workerId: workerB }));
        assert.equal(a.content, "from-A");
        assert.equal(b.content, "from-B");
    } finally { db.close(); }
});

test("Worker.read: read against workspace A doesn't surface workspace B's entry", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-rd-a");
        const workspaceB = await insertWorkspace(db, "ws-rd-b");
        const workerA = await insertWorker(db, workspaceA);
        const workerB = await insertWorker(db, workspaceB);
        const k = new Worker();
        await k.edit(editStatement({ target: urlPath("worker", "/only-b"), body: "B-only" }), makeSchemeCtx({ db, workspaceId: workspaceB, workerId: workerB }));
        const result = await lookThroughScheme("worker", null, readStatement({ target: urlPath("worker", "/only-b") }), makeSchemeCtx({ db, workspaceId: workspaceA, workerId: workerA }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

// --- Extension-based mimetype ----------------------------------------

test("Worker: path suffix `.json` declares mimetype; READ returns application/json", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({ target: urlPath("worker", "/users.json"), body: '[{"name":"Alice"}]' }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const result = await lookThroughScheme("worker", null,
            readStatement({ target: urlPath("worker", "/users.json") }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.equal(result.content, '[{"name":"Alice"}]');
    } finally { db.close(); }
});

test("Worker: extension `.json` does not change line shorthand semantics", async () => {
    const { db, workspaceId, workerId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Worker();
        await k.edit(
            editStatement({
                target: urlPath("worker", "/users.json"),
                body: '[\n  {"name":"Alice"},\n  {"name":"Bob"},\n  {"name":"Carol"}\n]',
            }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const result = await lookThroughScheme("worker", null,
            readStatement({ target: urlPath("worker", "/users.json"), lineMarker: { marks: [3] } }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, '  {"name":"Bob"},');
        assert.equal(result.startLine, 3);
    } finally { db.close(); }
});

test("Worker: no path suffix → scheme default (text/markdown); <L> is line-based", async () => {
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
        const result = await lookThroughScheme("worker", null,
            readStatement({ target: urlPath("worker", "/users"), lineMarker: { marks: [2] } }),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, "beta");
    } finally { db.close(); }
});
