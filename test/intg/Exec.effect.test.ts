// Effect-gating (plurnk-service#182): the executor declares its effect, the
// service owns the policy. `host` runtimes (sh/node/python, file-backed
// sqlite) propose — a human gate. `read`/`pure` runtimes (search, :memory:
// sqlite) auto-run in-process: no proposal, no notification, resolved inline.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";

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
    engine.setExecutors(await testExecutors());
    const sessionId = await insertSession(db, `effect-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "effect test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { db, engine, exec, sessionId, runId, loopId, turnId };
};

test("effect-gating: sqlite :memory: (pure) auto-runs — no proposal, resolves < 400", async () => {
    const { db, engine, exec, sessionId, runId, loopId, turnId } = await wire();
    try {
        // No target → :memory: → pure → auto. dispatch resolves WITHOUT any
        // external resolveProposal call (the host path would hang here).
        const result = await engine.dispatch({
            statement: execStmt("sqlite", null, "SELECT 1 AS n;"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 202, "a pure runtime must not leave a pending proposal");
        assert.ok(result.status < 400, `auto-run resolved cleanly; got ${result.status}`);
        assert.ok(typeof result.body === "string" && result.body.length > 0, "inline returns the run output in the EXEC result, this turn — not a turn later");
        assert.match(result.body as string, /1/, "the SELECT 1 result is in the body");
        await exec.idle();
    } finally { await db.close(); }
});

test("effect-gating: sh (host) still proposes — entry sits at 'proposed' awaiting a gate", async () => {
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
