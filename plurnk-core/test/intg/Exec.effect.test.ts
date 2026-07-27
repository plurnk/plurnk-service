// Effect-gating (plurnk-service#182): the executor declares its effect, the
// service owns the policy. `host` runtimes (sh/node/python, file-backed
// sqlite) propose — a human gate. `read`/`pure` runtimes (search, :memory:
// sqlite) auto-run ungated: no proposal, no notification — but, like every
// exec, they background and stream their output (§exec-stream), not in-band.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, rootWorkspace } from "./_helpers.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExecutorRegistry, { type Executor } from "../../src/core/ExecutorRegistry.ts";
import type { SchemeManifest } from "../../src/core/types.ts";
import type { Effect } from "@plurnk/plurnk-execs";

const execStmt = (runtime: string, target: string | null, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime,
    target: target === null ? null : { kind: "local", raw: target },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

const wire = async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    const executors = await testExecutors();
    engine.setExecutors(executors);
    schemes.registerRuntimeSchemes(executors); // #240 — register per-tag faces so READ <tag>:// resolves (mirrors Daemon boot)
    const workspaceId = await insertWorkspace(db, `effect-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "effect test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, engine, exec, workspaceId, workerId, loopId, turnId };
};

test("effect-gating: sqlite :memory: (pure) auto-runs ungated — no proposal, no in-band body", async () => {
    const { db, engine, exec, workspaceId, workerId, loopId, turnId } = await wire();
    try {
        // No target → :memory: → pure → auto. dispatch resolves WITHOUT any
        // external resolveProposal call (the host path would hang here).
        const result = await engine.dispatch({
            statement: execStmt("sqlite", null, "SELECT 1 AS n;"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 202, "a pure runtime must not leave a pending proposal — it skips the gate");
        assert.ok(result.status < 400, `auto-run resolved cleanly; got ${result.status}`);
        // No in-band receipt: like every exec it backgrounds + streams (§exec-stream); the output
        // reaches the model via the env-observation injector next turn, not here.
        assert.equal(result.body, undefined, "pure auto-run returns no in-band body — it streams");
        await exec.idle();
    } finally { await db.close(); }
});

// Regression for #216 (execs-sqlite 0.1.4). In a WORKSPACE workspace the service
// defaults the exec cwd to project_root, and sqlite uses cwd as its db path — a
// DIRECTORY there used to 500 the open. The test above runs headless (cwd=null →
// :memory:) and missed it; this exercises the project_root path that actually breaks.
test("sqlite EXEC in a workspace workspace: a project_root cwd no longer 500s the db open (#216)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-sqlite-ws-"));
    const { db, engine, exec, workspaceId, workerId, loopId, turnId } = await wire();
    try {
        await rootWorkspace(db, workspaceId, root);  // cwd now defaults to this dir
        const result = await engine.dispatch({
            statement: execStmt("sqlite", null, "SELECT 'Paris' AS capital;"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 202, "pure runtime auto-runs ungated, no proposal");
        assert.ok(result.status < 400, `resolved cleanly with a project_root cwd; got ${result.status}`);
        // A clean resolve (not 202, < 400) is the #216 signal: the db opened + the query ran with
        // a DIRECTORY cwd. The output then streams like any exec (§exec-stream), no in-band body.
        await exec.idle();
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("effect-gating: sh (host) proposes — entry sits at 'proposed' awaiting a gate", async () => {
    const { db, engine, exec, workspaceId, workerId, loopId, turnId } = await wire();
    try {
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", null, "echo hi"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed", "host runtime proposes — waits for a human");
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();
    } finally { await db.close(); }
});

test("effect is command-aware (#289): the EXEC command body is passed to effect(), not just the target", async () => {
    // execs-mcp resolves a per-tool readOnlyHint OFF THE COMMAND, so the service must hand the command
    // to effect(), not only the target. A custom executor captures what it receives; it returns `host`
    // (propose) so run() is never reached — we reject after asserting.
    let seen: string | undefined = "UNSET";
    const exe: Executor = {
        runtime: "tool", glyph: "🔧",
        get manifest(): SchemeManifest { return { name: "tool" } as unknown as SchemeManifest; },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "application/json" } }; },
        run: async () => { throw new Error("run must not be reached — effect proposes (host), then the test rejects"); },
        probe: async () => ({ available: true }),
        effect: (_target: string | null, command?: string): Effect => { seen = command; return "host"; },
    };
    const registry = new ExecutorRegistry(new Map([["tool", { executor: exe, glyph: "🔧", example: "", documentation: "", available: true, detail: undefined }]]));
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    engine.setExecutors(registry);
    const workspaceId = await insertWorkspace(db, `cmd-effect-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "cmd-effect");
    const turnId = await insertTurn(db, loopId, 1, 102);
    try {
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("tool", null, "tools/call name=list_files readOnly=true"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.equal(seen, "tools/call name=list_files readOnly=true", "the EXEC command body reaches effect() — command-aware (#289)");
        engine.resolveProposal(logEntryId, { decision: "reject" });
        await dispatchPromise;
    } finally { await db.close(); }
});

test("bare EXEC resolves to sh and respects the workspace's sh policy gate", async () => {
    const { db, engine, exec, workspaceId, workerId, loopId, turnId } = await wire();
    try {
        await db.test_set_session_settings.run({ id: workspaceId, settings: JSON.stringify({ execs: { PLURNK_EXECS_SH: "0" } }) });
        const result = await engine.dispatch({
            statement: execStmt("", null, "echo hi"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501, "sh disabled → bare EXEC is refused, not proposed or spawned");
        assert.match(String(result.error), /`sh` is disabled/);
        await exec.idle();
    } finally { await db.close(); }
});
