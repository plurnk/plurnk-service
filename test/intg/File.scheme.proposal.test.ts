// File scheme as the canonical proposal consumer (SPEC.md §engine-rails + §methods
// + §membership D3 — disk co-location). EDIT against file:/// returns status=202 with a udiff body
// and {path, canonical, patch, patched} attrs; on accept the engine calls
// File.applyResolution which writes patched content to disk.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";

const fileEditStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "url", raw: `file:///${pathname}`, scheme: "file",
        username: null, password: null, hostname: null, port: null,
        pathname: `/${pathname}`, params: {}, fragment: null },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const fileReadStmt = (pathname: string): ReadStatement => ({
    op: "READ", suffix: "", signal: null,
    target: { kind: "url", raw: `file:///${pathname}`, scheme: "file",
        username: null, password: null, hostname: null, port: null,
        pathname: `/${pathname}`, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// Bare-path edit — the form the sysprompt actually trains the model to
// emit. plurnk.md: "Bare paths (no scheme) default to local relative
// project file paths." Engine.#schemeNameOf routes LocalPath → 'file'.
const bareEditStmt = (relPath: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "local", raw: relPath },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Set up a temp workspace + a session whose project_root points at it.
// F.1 added the column; F.5 made File read it instead of an env var.
// Returns the temp root for body assertions + a cleanup fn.
const withWorkspaceRoot = async <T>(fn: (root: string, ctx: { db: Db; engine: Engine; sessionId: number; runId: number; loopId: number; turnId: number }) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-test-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const sessionId = await insertSession(db, `file-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: root });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "file edit test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn(root, { db, engine, sessionId, runId, loopId, turnId });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("[§proposal-accept-applies] file.edit: writes file on accept via applyResolution", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        // Pre-seed an existing file so the EDIT computes a real diff.
        const target = "src/hello.txt";
        // File.edit gates on membership (SPEC §membership): a pre-existing file must be a
        // member (git-tracked or client-added) to be editable — register it, the same
        // way READ's gate is satisfied below. A NEW path needs no prior member.
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, target), "hello\n", "utf8");
        // Materialize the member coherently — entry + body channel (= disk content) + synced_sig —
        // exactly as the production reconcile (#materializeMember) does. EDIT now bases its diff on
        // the body-channel snapshot (so the diff shows -hello), and the write-CAS has a sig to guard.
        const seeded = await (ctx.db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: `/${target}` });
        await (ctx.db.ops_upsert_channel as PrepMethod).run({ entry_id: seeded?.id, name: "body", content: "hello\n", mimetype: "text/plain", tokens: 0 });
        const seededStat = await stat(join(root, target));
        await (ctx.db.crud_set_synced_sig as PrepMethod).run({ entry_id: seeded?.id, synced_sig: `${seededStat.mtimeMs}:${seededStat.size}` });

        const stmt = fileEditStmt(target, "hello world\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string; canonical: string; patch: string; patched: string };
        assert.equal(attrs.path, `/${target}`);
        assert.equal(attrs.patched, "hello world\n");
        assert.match(attrs.patch, /^Index: \/src\/hello\.txt/);
        assert.match(attrs.patch, /-hello/);
        assert.match(attrs.patch, /\+hello world/);

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "hello world\n");
    });
});

test("file.edit: rejection leaves file untouched", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "untouched.txt";
        // pre-existing file must be a member to be editable (SPEC §membership edit gate)
        await (ctx.db.crud_insert_session_entry as PrepMethod).get({ session_id: ctx.sessionId, scheme: null, pathname: `/${target}` });
        await writeFile(join(root, target), "original\n", "utf8");

        const stmt = fileEditStmt(target, "should-not-land\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "reject", outcome: "reviewer_said_no" });
        const result = await dispatchPromise;
        assert.equal(result.status, 400);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "original\n", "rejected EDIT must not touch disk");
    });
});

test("file.edit: creates a new file on accept (target doesn't exist)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "new-dir"), { recursive: true });
        const target = "new-dir/new-file.md";
        const stmt = fileEditStmt(target, "# Created via proposal\n");

        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "# Created via proposal\n");
    });
});

test("file.edit: an accept into a NOT-YET-EXISTING subtree creates the parent dirs and lands", async () => {
    // The fan-out digest's write_failed: applyResolution wrote with no mkdir, so any accepted
    // proposal into a fresh subdir died on ENOENT — the model saw a bare 400 and parked on a
    // worker that never existed. The write-back edge owns its parents now.
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "tasks/nested/extract_config_values.md";
        const stmt = fileEditStmt(target, "# task\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "the accept applies — never write_failed on a missing parent");
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "# task\n");
    });
});

test("file.edit: refuses traversal escape", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const stmt = fileEditStmt("../escape.txt", "nope\n");
        const result = await ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    });
});

test("bare target: EDIT(relative/path) routes to file scheme (no scheme prefix)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "from-bare.txt";
        // pre-existing file must be a member to be editable (SPEC §membership edit gate)
        await (ctx.db.crud_insert_session_entry as PrepMethod).get({ session_id: ctx.sessionId, scheme: null, pathname: `/${target}` });
        await writeFile(join(root, target), "original\n", "utf8");

        // No file:/// prefix — the form the sysprompt teaches.
        const stmt = bareEditStmt(target, "bare-path edit\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;

        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.status_rx, 202, "bare path EDIT must route to file scheme + propose");
        assert.equal(row?.state, "proposed");
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string };
        assert.equal(attrs.path, `/${target}`);

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "bare-path edit\n");
    });
});

test("file.read: still works alongside the new edit path", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "read-me.txt";
        await writeFile(join(root, target), "content\n", "utf8");
        // File.read serves the materialized entry now — materialize the content
        // (production's git-membership pass does this), not just a membership marker.
        const writeCtx: PlurnkSchemeContext = {
            db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, turnId: ctx.turnId,
            writer: "model", signal: undefined, tokenize: (t: string) => t.length,
        };
        await EntryCrud.writeEntry(`/${target}`, { channels: { body: { content: "content\n", mimetype: "text/markdown" } }, tags: [] }, writeCtx, null);

        const stmt = fileReadStmt(target);
        const result = await ctx.engine.dispatch({
            statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    });
});

test("file.edit: headless session (no project_root) → 400", async () => {
    // Reproduce the live-blocker bug we just fixed: session with no
    // project_root set returns 400 with a clear error pointing at the
    // session.set_root RPC. Previously this would have been the env-var
    // case.
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `headless-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "headless");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = bareEditStmt("any.txt", "content\n");
        const result = await engine.dispatch({
            statement: stmt, sessionId, runId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    } finally { await db.close(); }
});
