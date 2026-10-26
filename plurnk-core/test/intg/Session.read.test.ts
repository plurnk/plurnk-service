import test from "node:test";
import assert from "node:assert/strict";
import type { LineMarker, MatcherBody, ParsedPath, ReadStatement, UrlPath, FindStatement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Workspace from "../../src/schemes/Workspace.ts";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx } from "./_scheme.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const fullReplace: LineMarker = { marks: [1, -1] };
const editStatement = (opts: { target: ParsedPath; body?: string | null; lineMarker?: LineMarker | null }): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: opts.target,
    lineMarker: opts.lineMarker ?? null,
    matcher: null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStatement = (opts: {
    target?: ParsedPath | null; lineMarker?: LineMarker | null;
}): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const findStatement = (opts: {
    target?: ParsedPath | null; matcher?: MatcherBody | null; lineMarker?: LineMarker | null;
}): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
    target: opts.target ?? null,
    lineMarker: opts.lineMarker ?? null,
    matcher: opts.matcher ?? null, body: null,
    position: { line: 1, column: 1 },
});

const setupContext = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

test("{§read-read-content} Session.read: existing entry — returns body content and mimetype with status 200", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/france/capital"), body: "Paris" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/france/capital") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris");
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("{§read-read-404} Session.read: nonexistent path returns 404 with null content/mimetype", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/nope") }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("{§problems-dispatch} Session.read: null path returns 400", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const result = await readThroughScheme("workspace", null, readStatement({ target: null }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 400);
        assert.equal(result.content, null);
        assert.equal(result.mimetype, null);
    } finally { db.close(); }
});

test("{§read-selection-projection} Session.read: lineMarker <N> on text source returns raw line + text/markdown mimetype", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/lined"), body: "first\nsecond\nthird" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/lined"), lineMarker: { marks: [2] } }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.content, "second");
        assert.equal((result as { startLine?: number }).startLine, 2);
        // <L> on a textual source returns the text primitive.
        assert.equal(result.mimetype, "text/markdown");
    } finally { db.close(); }
});

test("{§text-scope-runtime} Session.read: four-coordinate scope returns an exact Unicode text region", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({
                target: urlPath("workspace", "/exact"),
                body: "a😀b\nsecond",
            }),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        const result = await readThroughScheme("workspace", null,
            readStatement({
                target: urlPath("workspace", "/exact"),
                lineMarker: { marks: [1, 2, 1, 3] },
            }),
            makeSchemeCtx({ db, workspaceId, sessionId }),
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

test("{§find-result-projection} Session.find: exact regex matcher returns flat locations", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/match"), body: "alpha beta alpha gamma" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const matcher: MatcherBody = { dialect: "regex", raw: "/alpha/g", pattern: "alpha", flags: "g" };
        const result = await k.find(findStatement({ target: urlPath("workspace", "/match"), matcher }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("{§find-result-projection} Session.find: exact glob matcher returns flat match locations", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/g"), body: "TODO: one\nhello\nTODO: two\nworld" }), makeSchemeCtx({ db, workspaceId, sessionId }));
        const matcher: MatcherBody = { dialect: "glob", raw: "TODO*" };
        const result = await k.find(findStatement({ target: urlPath("workspace", "/g"), matcher }), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.ok(result.results.length > 0);
    } finally { db.close(); }
});

test("{§edit-marker-required-on-existing} Session.read: edited entry round-trips through read — content matches what edit wrote", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    try {
        const k = new Workspace();
        const bodies = ["first", "second", "third"];
        const target = urlPath("workspace", "/rt");
        for (const [i, body] of bodies.entries()) {
            // First iteration creates (markerless); the rest re-edit an existing entry, which
            // needs the deliberate full-replace marker ({§edit-marker-required-on-existing}).
            await k.edit(editStatement({ target, body, lineMarker: i === 0 ? null : fullReplace }), makeSchemeCtx({ db, workspaceId, sessionId }));
            const result = await readThroughScheme("workspace", null, readStatement({ target }), makeSchemeCtx({ db, workspaceId, sessionId }));
            assert.equal(result.status, 200);
            assert.equal(result.content, body);
        }
    } finally { db.close(); }
});



test("{§entry-owner} Session.read: different workspaces see different entries at the same path", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-readiso-a");
        const workspaceB = await insertWorkspace(db, "ws-readiso-b");
        const sessionA = await insertSession(db, workspaceA);
        const sessionB = await insertSession(db, workspaceB);
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/x"), body: "from-A" }), makeSchemeCtx({ db, workspaceId: workspaceA, sessionId: sessionA }));
        await k.edit(editStatement({ target: urlPath("workspace", "/x"), body: "from-B" }), makeSchemeCtx({ db, workspaceId: workspaceB, sessionId: sessionB }));
        const a = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceA, sessionId: sessionA }));
        const b = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/x") }), makeSchemeCtx({ db, workspaceId: workspaceB, sessionId: sessionB }));
        assert.equal(a.content, "from-A");
        assert.equal(b.content, "from-B");
    } finally { db.close(); }
});

test("{§entry-owner} Session.read: read against workspace A doesn't surface workspace B's entry", async () => {
    const db = await openMigrated();
    try {
        const workspaceA = await insertWorkspace(db, "ws-rd-a");
        const workspaceB = await insertWorkspace(db, "ws-rd-b");
        const sessionA = await insertSession(db, workspaceA);
        const sessionB = await insertSession(db, workspaceB);
        const k = new Workspace();
        await k.edit(editStatement({ target: urlPath("workspace", "/only-b"), body: "B-only" }), makeSchemeCtx({ db, workspaceId: workspaceB, sessionId: sessionB }));
        const result = await readThroughScheme("workspace", null, readStatement({ target: urlPath("workspace", "/only-b") }), makeSchemeCtx({ db, workspaceId: workspaceA, sessionId: sessionA }));
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    } finally { db.close(); }
});

// --- Extension-based mimetype ----------------------------------------

test("{§ext-mimetype} Session: path suffix `.json` declares mimetype; READ returns application/json", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({ target: urlPath("workspace", "/users.json"), body: '[{"name":"Alice"}]' }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        const result = await readThroughScheme("workspace", null,
            readStatement({ target: urlPath("workspace", "/users.json") }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "application/json");
        assert.equal(result.content, '[{"name":"Alice"}]');
    } finally { db.close(); }
});

test("{§ext-mimetype-extension-mimetype} Session: extension `.json` does not change line shorthand semantics", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({
                target: urlPath("workspace", "/users.json"),
                body: '[\n  {"name":"Alice"},\n  {"name":"Bob"},\n  {"name":"Carol"}\n]',
            }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        const result = await readThroughScheme("workspace", null,
            readStatement({ target: urlPath("workspace", "/users.json"), lineMarker: { marks: [3] } }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, '  {"name":"Bob"},');
        assert.equal(result.startLine, 3);
    } finally { db.close(); }
});

test("{§ext-mimetype} Session: no path suffix → scheme default (text/markdown); <L> is line-based", async () => {
    const { db, workspaceId, sessionId } = await setupContext();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    try {
        const k = new Workspace();
        await k.edit(
            editStatement({ target: urlPath("workspace", "/users"), body: "alpha\nbeta\ngamma" }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        // Without `.json` delimiter, mimetype falls back to manifest default
        // (text/markdown). <L><2> is line-based.
        const result = await readThroughScheme("workspace", null,
            readStatement({ target: urlPath("workspace", "/users"), lineMarker: { marks: [2] } }),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.mimetype, "text/markdown");
        assert.equal(result.content, "beta");
    } finally { db.close(); }
});
