// SPEC §exec {§exec-env-scoped} — an EXEC subprocess must NOT inherit plurnk's own
// secrets (provider keys, PLURNK_* config). Deferred-red until plurnk-execs#8
// (ExecArgs.env) lands and the service passes a scoped env: today SubprocessExecutor
// spawns with no `env`, so the child inherits the daemon's full process.env — canary
// and all. The canary is a PLURNK_*-shaped var (what the scoping denylist drops).

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";
import { execStmt } from "./_dsl.ts";

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

test(
    "[§exec-env-scoped] an EXEC subprocess does not inherit plurnk's own env (provider keys / PLURNK_*)",
    { todo: "plurnk-execs spawns with no env (plurnk-execs#8) → the child inherits the daemon's full process.env" },
    async () => {
        const CANARY = "PLURNK_ENV_LEAK_CANARY";
        const prev = process.env[CANARY];
        process.env[CANARY] = "do-not-leak-to-subprocess";
        const db = await openMigrated();
        try {
            const schemes = new SchemeRegistry();
            const exec = schemes.get("exec") as Exec;
            const engine = new Engine({ db, schemes });
            engine.setExecutors(await testExecutors());
            const sessionId = await insertSession(db, `exec-env-${crypto.randomUUID()}`);
            const runId = await insertRun(db, sessionId);
            const loopId = await insertLoop(db, runId, 1, "exec env scoping");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const idDeferred = deferred<number>();
            const dispatchPromise = engine.dispatch({
                statement: execStmt("sh", `echo "$${CANARY}"`),  // host runtime → propose
                sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            engine.resolveProposal(logEntryId, { decision: "accept" });
            await dispatchPromise;
            await exec.idle();

            const log = await (db.test_get_log_entry_by_id as PrepMethod).get<{ attrs: string }>({ id: logEntryId });
            const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
            const entry = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({ scheme: "exec", pathname });
            const stdout = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entry!.id, name: "stdout" });
            assert.doesNotMatch(stdout?.content ?? "", /do-not-leak-to-subprocess/, "plurnk's own env must not reach the EXEC subprocess");
        } finally {
            await db.close();
            if (prev === undefined) delete process.env[CANARY]; else process.env[CANARY] = prev;
        }
    },
);
