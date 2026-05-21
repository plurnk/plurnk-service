// File scheme as the canonical proposal consumer (task #42, AGENTS.md
// §Phase E.4). EDIT against file:// returns status=202 with a udiff body
// and {path, canonical, patch, patched} attrs; on accept the engine calls
// File.applyResolution which writes patched content to disk.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";

const fileEditStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    path: { kind: "url", raw: `file://${pathname}`, scheme: "file",
        username: null, password: null, hostname: null, port: null,
        pathname, params: {}, fragment: null },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const fileReadStmt = (pathname: string): ReadStatement => ({
    op: "READ", suffix: "", signal: null,
    path: { kind: "url", raw: `file://${pathname}`, scheme: "file",
        username: null, password: null, hostname: null, port: null,
        pathname, params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

// Bare-path edit — the form the sysprompt actually trains the model to
// emit. plurnk.md: "Bare paths (no scheme) default to local relative
// project file paths." Engine.#schemeNameOf routes LocalPath → 'file'.
const bareEditStmt = (relPath: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    path: { kind: "local", raw: relPath },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

const withWorkspaceRoot = async <T>(fn: (root: string) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-test-"));
    const original = process.env.PLURNK_WORKSPACE_ROOT;
    process.env.PLURNK_WORKSPACE_ROOT = root;
    try {
        return await fn(root);
    } finally {
        if (original === undefined) delete process.env.PLURNK_WORKSPACE_ROOT;
        else process.env.PLURNK_WORKSPACE_ROOT = original;
        await rm(root, { recursive: true, force: true });
    }
};

const setupEngine = async (db: Db): Promise<{
    engine: Engine; sessionId: number; runId: number; loopId: number; turnId: number;
}> => {
    const schemes = new SchemeRegistry();
    // Re-register file scheme as a fresh instance — caches workspace_root
    // at first use, so a fresh process.env doesn't apply to the singleton
    // SchemeRegistry already created. The default registry's File is
    // shadowed by reading from this new schemes instance.
    schemes.register("file-test", new File());
    const engine = new Engine({ db, schemes });
    const sessionId = await insertSession(db, `file-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "file edit test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { engine, sessionId, runId, loopId, turnId };
};

test("file.edit: writes file on accept via applyResolution", async () => {
    await withWorkspaceRoot(async (root) => {
        const db = await openMigrated();
        try {
            const ctx = await setupEngine(db);
            // Pre-seed an existing file so the EDIT computes a real diff.
            const target = "src/hello.txt";
            await mkdir(join(root, "src"), { recursive: true });
            await writeFile(join(root, target), "hello\n", "utf8");

            const stmt = fileEditStmt(target, "hello world\n");
            // Need to route through "file" scheme name (Engine uses
            // statement.path.scheme to look up the handler). Adjust by
            // re-registering under "file" — we'll just register a fresh
            // engine with the proper scheme name binding.
            const schemes2 = new SchemeRegistry();
            // SchemeRegistry already registers "file" → File in its
            // constructor; just use the engine's default.
            const engine2 = new Engine({ db, schemes: schemes2 });

            const idDeferred = deferred<number>();
            const dispatchPromise = engine2.dispatch({
                statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
                loopId: ctx.loopId, turnId: ctx.turnId, actionIndex: 0, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            // Verify the proposed entry has the right shape.
            const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
            assert.equal(row?.state, "proposed");
            assert.equal(row?.status_rx, 202);
            const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string; canonical: string; patch: string; patched: string };
            assert.equal(attrs.path, target);
            assert.equal(attrs.patched, "hello world\n");
            assert.match(attrs.patch, /^Index: src\/hello\.txt/);
            assert.match(attrs.patch, /-hello/);
            assert.match(attrs.patch, /\+hello world/);

            // Accept the proposal → applyResolution writes to disk.
            engine2.resolveProposal(logEntryId, { decision: "accept" });
            const result = await dispatchPromise;
            assert.equal(result.status, 200);
            const onDisk = await readFile(join(root, target), "utf8");
            assert.equal(onDisk, "hello world\n");
        } finally { await db.close(); }
    });
});

test("file.edit: rejection leaves file untouched", async () => {
    await withWorkspaceRoot(async (root) => {
        const db = await openMigrated();
        try {
            const ctx = await setupEngine(db);
            const target = "untouched.txt";
            await writeFile(join(root, target), "original\n", "utf8");

            const stmt = fileEditStmt(target, "should-not-land\n");
            const engine2 = new Engine({ db, schemes: new SchemeRegistry() });

            const idDeferred = deferred<number>();
            const dispatchPromise = engine2.dispatch({
                statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
                loopId: ctx.loopId, turnId: ctx.turnId, actionIndex: 0, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            engine2.resolveProposal(logEntryId, { decision: "reject", outcome: "reviewer_said_no" });
            const result = await dispatchPromise;
            assert.equal(result.status, 400);
            const onDisk = await readFile(join(root, target), "utf8");
            assert.equal(onDisk, "original\n", "rejected EDIT must not touch disk");
        } finally { await db.close(); }
    });
});

test("file.edit: creates a new file on accept (target doesn't exist)", async () => {
    await withWorkspaceRoot(async (root) => {
        const db = await openMigrated();
        try {
            const ctx = await setupEngine(db);
            await mkdir(join(root, "new-dir"), { recursive: true });
            const target = "new-dir/new-file.md";
            const stmt = fileEditStmt(target, "# Created via proposal\n");
            const engine2 = new Engine({ db, schemes: new SchemeRegistry() });

            const idDeferred = deferred<number>();
            const dispatchPromise = engine2.dispatch({
                statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
                loopId: ctx.loopId, turnId: ctx.turnId, actionIndex: 0, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            engine2.resolveProposal(logEntryId, { decision: "accept" });
            const result = await dispatchPromise;
            assert.equal(result.status, 200);
            const onDisk = await readFile(join(root, target), "utf8");
            assert.equal(onDisk, "# Created via proposal\n");
        } finally { await db.close(); }
    });
});

test("file.edit: refuses traversal escape", async () => {
    await withWorkspaceRoot(async (root) => {
        const db = await openMigrated();
        try {
            const ctx = await setupEngine(db);
            const stmt = fileEditStmt("../escape.txt", "nope\n");
            const engine2 = new Engine({ db, schemes: new SchemeRegistry() });

            const result = await engine2.dispatch({
                statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
                loopId: ctx.loopId, turnId: ctx.turnId, actionIndex: 0, origin: "model",
            });
            assert.equal(result.status, 403);
        } finally { await db.close(); }
    });
});

test("bare path: EDIT(relative/path) routes to file scheme (no scheme prefix)", async () => {
    await withWorkspaceRoot(async (root) => {
        const db = await openMigrated();
        try {
            const ctx = await setupEngine(db);
            const target = "from-bare.txt";
            await writeFile(join(root, target), "original\n", "utf8");

            // No file:// prefix — the form the sysprompt teaches.
            const stmt = bareEditStmt(target, "bare-path edit\n");
            const engine2 = new Engine({ db, schemes: new SchemeRegistry() });

            const idDeferred = deferred<number>();
            const dispatchPromise = engine2.dispatch({
                statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
                loopId: ctx.loopId, turnId: ctx.turnId, actionIndex: 0, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;

            // Confirm log entry reports file scheme (proves routing).
            const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
            assert.equal(row?.status_rx, 202, "bare path EDIT must route to file scheme + propose");
            assert.equal(row?.state, "proposed");
            const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string };
            assert.equal(attrs.path, target);

            engine2.resolveProposal(logEntryId, { decision: "accept" });
            const result = await dispatchPromise;
            assert.equal(result.status, 200);
            const onDisk = await readFile(join(root, target), "utf8");
            assert.equal(onDisk, "bare-path edit\n");
        } finally { await db.close(); }
    });
});

test("file.read: still works alongside the new edit path", async () => {
    await withWorkspaceRoot(async (root) => {
        const db = await openMigrated();
        try {
            const ctx = await setupEngine(db);
            const target = "read-me.txt";
            await writeFile(join(root, target), "content\n", "utf8");

            const stmt = fileReadStmt(target);
            const engine2 = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine2.dispatch({
                statement: stmt, sessionId: ctx.sessionId, runId: ctx.runId,
                loopId: ctx.loopId, turnId: ctx.turnId, actionIndex: 0, origin: "model",
            });
            assert.equal(result.status, 200);
        } finally { await db.close(); }
    });
});
