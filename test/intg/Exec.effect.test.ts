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
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Envelope from "../../src/server/envelope.ts";

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
    const sessionId = await insertSession(db, `effect-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "effect test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, engine, exec, sessionId, runId, loopId, turnId };
};

test("[§exec-readpure-ungated] effect-gating: sqlite :memory: (pure) auto-runs ungated — no proposal, no in-band body", async () => {
    const { db, engine, exec, sessionId, runId, loopId, turnId } = await wire();
    try {
        // No target → :memory: → pure → auto. dispatch resolves WITHOUT any
        // external resolveProposal call (the host path would hang here).
        const result = await engine.dispatch({
            statement: execStmt("sqlite", null, "SELECT 1 AS n;"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 202, "a pure runtime must not leave a pending proposal — it skips the gate");
        assert.ok(result.status < 400, `auto-run resolved cleanly; got ${result.status}`);
        // No in-band receipt: like every exec it backgrounds + streams (§exec-stream); the output
        // reaches the model via the env-observation injector next turn, not here.
        assert.equal(result.body, undefined, "pure auto-run returns no in-band body — it streams");
        await exec.idle();
    } finally { await db.close(); }
});

// Regression for #216 (execs-sqlite 0.1.4). In a WORKSPACE session the service
// defaults the exec cwd to project_root, and sqlite uses cwd as its db path — a
// DIRECTORY there used to 500 the open. The test above runs headless (cwd=null →
// :memory:) and missed it; this exercises the project_root path that actually breaks.
test("sqlite EXEC in a workspace session: a project_root cwd no longer 500s the db open (#216)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-sqlite-ws-"));
    const { db, engine, exec, sessionId, runId, loopId, turnId } = await wire();
    try {
        await Envelope.updateSessionProjectRoot(db, sessionId, root);  // cwd now defaults to this dir
        const result = await engine.dispatch({
            statement: execStmt("sqlite", null, "SELECT 'Paris' AS capital;"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 202, "pure runtime auto-runs ungated, no proposal");
        assert.ok(result.status < 400, `resolved cleanly with a project_root cwd; got ${result.status}`);
        // A clean resolve (not 202, < 400) is the #216 signal: the db opened + the query ran with
        // a DIRECTORY cwd. The output then streams like any exec (§exec-stream), no in-band body.
        await exec.idle();
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("[§exec-host-proposes] effect-gating: sh (host) proposes — entry sits at 'proposed' awaiting a gate", async () => {
    const { db, engine, exec, sessionId, runId, loopId, turnId } = await wire();
    try {
        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", null, "echo hi"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await (db.test_get_log_entry_by_id as PrepMethod).get<{ state: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed", "host runtime proposes — waits for a human");
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;
        await exec.idle();
    } finally { await db.close(); }
});

test("[§exec-registry-resolves] unknown runtime → 501 (registry resolves; no such executor)", async () => {
    const { db, engine, exec, sessionId, runId, loopId, turnId } = await wire();
    try {
        const result = await engine.dispatch({
            statement: execStmt("nonesuch", null, "echo hi"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501, "an unregistered runtime resolves to 501 — not a proposal, not a spawn");
        await exec.idle();
    } finally { await db.close(); }
});
