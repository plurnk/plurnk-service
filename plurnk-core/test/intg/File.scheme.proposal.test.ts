// File scheme as the canonical proposal consumer (SPEC.md §engine-rails + §methods
// + §membership D3 — disk co-location). EDIT against file:/// returns status=202 with a udiff body
// and {path, canonical, patch, patched} attrs; on accept the engine calls
// File.applyResolution which writes patched content to disk.

import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { EditStatement, ReadStatement, LineMarker } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

// {§edit-marker-required-on-existing} (#571) — a marker is required on an EXISTING
// file; `fullReplace` (marks:[1,-1]) states a deliberate whole-content rewrite
// explicitly. Default null: callers targeting a genuinely NEW path (nothing to
// scope into) leave it off.
const fullReplace: LineMarker = { marks: [1, -1] };

const fileEditStmt = (pathname: string, body: string, marker: LineMarker | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "url", raw: `file:///${pathname}`, scheme: "file",
        username: null, password: null, hostname: null, port: null,
        pathname: `/${pathname}`, params: {}, fragment: null },
    lineMarker: marker, body, position: { line: 1, column: 1 },
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
const bareEditStmt = (relPath: string, body: string, marker: LineMarker | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "local", raw: relPath },
    lineMarker: marker, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Set up a temp workspace + a workspace whose project_root points at it.
// F.1 added the column; F.5 made File read it instead of an env var.
// Returns the temp root for body assertions + a cleanup fn.
const withWorkspaceRoot = async <T>(fn: (root: string, ctx: { db: Db; engine: Engine; workspaceId: number; workerId: number; loopId: number; turnId: number }) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-test-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const workspaceId = await insertWorkspace(db, `file-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: workspaceId, project_root: root });
        // {§fs-write-surface} — a non-git root grants nothing; the fixture is the CLIENT granting creates.
        await (db.crud_insert_workspace_constraint as PrepMethod).run({ workspace_id: workspaceId, effect: "pick", glob: "**" });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "file edit test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn(root, { db, engine, workspaceId, workerId, loopId, turnId });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("file.edit: writes file on accept via applyResolution", async () => {
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
        const seeded = await (ctx.db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: `${target}` });
        await (ctx.db.ops_upsert_channel as PrepMethod).run({ entry_id: seeded?.id, name: "body", content: "hello\n", mimetype: "text/plain", tokens: 0 });
        const seededStat = await stat(join(root, target));
        await (ctx.db.crud_set_synced_sig as PrepMethod).run({ entry_id: seeded?.id, synced_sig: `${seededStat.mtimeMs}:${seededStat.size}` });

        // {§edit-marker-required-on-existing} — the file exists, so the deliberate
        // full-rewrite escape hatch (<1,-1>) is required; this also proves it works.
        const stmt = fileEditStmt(target, "hello world\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string; canonical: string; patch: string; patched: string };
        assert.equal(attrs.path, target); // bare canon ({§fs-canonical-name})
        assert.equal(attrs.patched, "hello world\n");
        assert.match(attrs.patch, /^Index: src\/hello\.txt/);
        assert.match(attrs.patch, /-hello/);
        assert.match(attrs.patch, /\+hello world/);

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "hello world\n");
        // The applied EDIT's rx carries the bounded structured receipt computed from what landed.
        const applied = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ status_rx: number; rx: string }>({ id: logEntryId });
        assert.equal(applied?.status_rx, 200);
        const appliedRx = JSON.parse(applied?.rx ?? "{}") as {
            receipt?: { revision?: string; effect?: { context?: string } };
        };
        assert.match(appliedRx.receipt?.revision ?? "", /^[a-f0-9]{64}$/);
        assert.match(appliedRx.receipt?.effect?.context ?? "", /1:hello world/, "applied EDIT rx shows bounded landed context");
    });
});

test("file.edit: rejection leaves file untouched; the rx carries the outcome as its terse error token", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "untouched.txt";
        // pre-existing file must be a member to be editable (SPEC §membership edit gate)
        await (ctx.db.crud_insert_workspace_entry as PrepMethod).get({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: `${target}` });
        await writeFile(join(root, target), "original\n", "utf8");

        const stmt = fileEditStmt(target, "should-not-land\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "reject", outcome: "reviewer_said_no" });
        const result = await dispatchPromise;
        assert.equal(result.status, 400);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "original\n", "rejected EDIT must not touch disk");
        // The model-facing rx carries the one-word why — a mute {"status":400} reads as a
        // phantom failure the model can't act on (the fan-out dead-park).
        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ rx: string }>({ id: logEntryId });
        assert.deepEqual(JSON.parse(row?.rx ?? "{}"), { status: 400, error: "reviewer_said_no" }, "rx = status + terse outcome token, nothing more");
    });
});

test("file.edit: creates a new file on accept (target doesn't exist)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "new-dir"), { recursive: true });
        const target = "new-dir/new-file.md";
        const stmt = fileEditStmt(target, "# Created via proposal\n");

        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
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

test("file.edit: reviewer-modified acceptance receipts the content that actually lands (#619)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "reviewed.md";
        const stmt = fileEditStmt(target, "model proposal\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const reviewed = "reviewer revision\n";
        ctx.engine.resolveProposal(logEntryId, { decision: "accept", body: reviewed });
        await dispatchPromise;
        assert.equal(await readFile(join(root, target), "utf8"), reviewed);
        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ rx: string }>({ id: logEntryId });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            receipt?: { revision?: string; effect?: { context?: string } };
        };
        assert.equal(rx.receipt?.revision, createHash("sha256").update(reviewed).digest("hex"));
        assert.match(rx.receipt?.effect?.context ?? "", /1:reviewer revision/);
        assert.doesNotMatch(rx.receipt?.effect?.context ?? "", /model proposal/);
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
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
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

test("a markerless EDIT of an EXISTING file is refused, never a silent full replace (#571)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "src/Engine.ts";
        await mkdir(join(root, "src"), { recursive: true });
        const original = "line one\nline two\nline three\n";
        await writeFile(join(root, target), original, "utf8");
        const seeded = await (ctx.db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: target });
        await (ctx.db.ops_upsert_channel as PrepMethod).run({ entry_id: seeded?.id, name: "body", content: original, mimetype: "text/plain", tokens: 0 });

        // The run126 shape: a marker meant for the target landed inside the body text
        // instead (a model syntax slip), so the dispatched statement carries no marker at all.
        const stmt = fileEditStmt(target, "<2>:// AUDIT-OK\nline two");
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "no marker on an existing file is refused outright — never a proposal, never a silent replace");
        assert.match(String(result.error), /requires a line marker.*<1,-1>/, "the refusal names the law and the escape hatch");
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, original, "disk is untouched — the refusal happens before any proposal, let alone any write");
    });
});

test("file.edit: refuses traversal escape", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const stmt = fileEditStmt("../escape.txt", "nope\n");
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    });
});

test("bare target: EDIT(relative/path) routes to file scheme (no scheme prefix)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "from-bare.txt";
        // pre-existing file must be a member to be editable (SPEC §membership edit gate);
        // materialize the body channel too — the marker math below reads `original`.
        await writeFile(join(root, target), "original\n", "utf8");
        const seeded = await (ctx.db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: target });
        await (ctx.db.ops_upsert_channel as PrepMethod).run({ entry_id: seeded?.id, name: "body", content: "original\n", mimetype: "text/plain", tokens: 0 });

        // No file:/// prefix — the form the sysprompt teaches. The file exists, so the
        // marker is required (§edit-marker-required-on-existing).
        const stmt = bareEditStmt(target, "bare-path edit\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;

        const row = await (ctx.db.test_get_log_entry_by_id as PrepMethod).get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.status_rx, 202, "bare path EDIT must route to file scheme + propose");
        assert.equal(row?.state, "proposed");
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string };
        assert.equal(attrs.path, target); // bare canon ({§fs-canonical-name})

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
            db: ctx.db, workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
            writer: "model", signal: undefined, tokenize: (t: string) => t.length,
        };
        await EntryCrud.writeEntry(`${target}`, { channels: { body: { content: "content\n", mimetype: "text/markdown" } }, tags: [] }, writeCtx, "file");

        const stmt = fileReadStmt(target);
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, workerId: ctx.workerId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    });
});

test("file.edit: headless workspace (no project_root) → 400", async () => {
    // A workspace with no project_root returns 400 with a clear error naming
    // the contract: file ops need a workspace created with projectRoot
    // (headless is forever).
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `headless-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "headless");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = bareEditStmt("any.txt", "content\n");
        const result = await engine.dispatch({
            statement: stmt, workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    } finally { await db.close(); }
});
