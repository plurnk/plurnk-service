// SPEC §exec {§exec-env-scoped} — an EXEC subprocess must NOT inherit plurnk's own
// secrets (provider keys, PLURNK_* config). The service scopes the env (ExecEnv.scoped:
// drop PLURNK_* + the provider key-vars) and hands it to the executor, which spawns with
// it (plurnk-execs 0.4.5+ ExecArgs.env). The canary is a PLURNK_*-shaped var, so the
// denylist drops it before the spawn.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";
import { execStmt } from "./_dsl.ts";

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

test(
    "[§exec-env-scoped] an EXEC subprocess does not inherit plurnk's own env (provider keys / PLURNK_*)",
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
            const workspaceId = await insertWorkspace(db, `exec-env-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "exec env scoping");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const idDeferred = deferred<number>();
            const dispatchPromise = engine.dispatch({
                statement: execStmt("sh", `echo "$${CANARY}"`),  // host runtime → propose
                workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            engine.resolveProposal(logEntryId, { decision: "accept" });
            await dispatchPromise;
            await exec.idle();

            const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
            const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
            const stdout = await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" });
            assert.doesNotMatch(stdout?.content ?? "", /do-not-leak-to-subprocess/, "plurnk's own env must not reach the EXEC subprocess");
        } finally {
            await db.close();
            if (prev === undefined) delete process.env[CANARY]; else process.env[CANARY] = prev;
        }
    },
);
