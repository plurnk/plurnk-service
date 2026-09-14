// SPEC {§exec} {§exec-env-scoped} — an EXEC subprocess must NOT inherit plurnk's own
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
    "{§exec-env-scoped} an EXEC subprocess does not inherit plurnk's own env (provider keys / PLURNK_*)",
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
                statement: execStmt(null, `echo "$${CANARY}"`),  // host runtime → propose
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

// {§exec-env-scoped} the ceiling. The witness above uses a PLURNK_-prefixed canary, so it
// proves only the invariant and passes under any policy. This one proves the allowlist: an
// ordinary host name the policy does not admit never reaches the spawn, while one it does
// admit arrives intact — the distinction a denylist could not make.
test(
    "{§exec-env-scoped} an EXEC subprocess inherits only the ambient names the policy admits",
    async () => {
        const ADMITTED = "PLURNK_TEST_ADMITTED_NAME";
        const WITHHELD = "AGENT_SOCKET_CANARY";
        const previous = {
            inherit: process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT,
            admitted: process.env[ADMITTED],
            withheld: process.env[WITHHELD],
        };
        // The admitted name is deliberately NOT PLURNK_-prefixed in the spawn's view: the
        // policy names it, and the invariant would strip a PLURNK_ name regardless.
        const ADMITTED_IN_ENV = "PROJECT_TOOL_HOME";
        process.env[ADMITTED_IN_ENV] = "/opt/tool";
        process.env[WITHHELD] = "/run/user/1000/keyring/ssh";
        process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = `PATH,HOME,${ADMITTED_IN_ENV}`;
        const db = await openMigrated();
        try {
            const schemes = new SchemeRegistry();
            const exec = schemes.get("exec") as Exec;
            const engine = new Engine({ db, schemes });
            engine.setExecutors(await testExecutors());
            const workspaceId = await insertWorkspace(db, `exec-env-ceiling-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "exec env ceiling");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const idDeferred = deferred<number>();
            const dispatchPromise = engine.dispatch({
                statement: execStmt(null, `echo "admitted=$${ADMITTED_IN_ENV} withheld=$${WITHHELD}"`),
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
            const stdout = (await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" }))?.content ?? "";
            assert.match(stdout, /admitted=\/opt\/tool/, "a policy-admitted ambient name reaches the subprocess");
            assert.match(stdout, /withheld=$/mu, "an ambient name the policy does not admit is absent, not empty-stringed by the shell alone");
            assert.doesNotMatch(stdout, /keyring/, "the agent socket never reaches a model-written command");
        } finally {
            await db.close();
            delete process.env[ADMITTED_IN_ENV];
            if (previous.inherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
            else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previous.inherit;
            if (previous.withheld === undefined) delete process.env[WITHHELD]; else process.env[WITHHELD] = previous.withheld;
            if (previous.admitted === undefined) delete process.env[ADMITTED]; else process.env[ADMITTED] = previous.admitted;
        }
    },
);

// {§exec-env-scoped} layer four — the Worker's own state over the ambient ceiling, read at the spawn.
// The row is what the env verbs persist ({§functionality-scope}); here it is written directly so the
// spawn is witnessed alone: an enabled worker entry sets its value, a disabled entry masks an ambient
// name for this Worker only, a sibling with no row sees the ceiling untouched, and the invariant strips
// a reserved name even when the state names it.
test(
    "{§exec-env-scoped} a Worker's own environment reaches its next spawn; its sibling's ceiling is untouched",
    async () => {
        const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        const previousCi = process.env.CI;
        process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME,CI";
        process.env.CI = "1";
        const db = await openMigrated();
        try {
            const schemes = new SchemeRegistry();
            const exec = schemes.get("exec") as Exec;
            const engine = new Engine({ db, schemes });
            engine.setExecutors(await testExecutors());
            const workspaceId = await insertWorkspace(db, `exec-env-worker-${crypto.randomUUID()}`);
            const shaped = await insertWorker(db, workspaceId);
            const plain = await insertWorker(db, workspaceId);
            await db.worker_module_state_put.run({
                worker_id: shaped, namespace_owner: "@plurnk/plurnk-service",
                state: JSON.stringify({ version: 1, definitions: {
                    CARGO_TARGET_DIR: { origin: "worker", enabled: true, definition: { value: "/tmp/shared" } },
                    CI: { origin: "service", enabled: false },
                    PLURNK_SERVICE_LEAK: { origin: "worker", enabled: true, definition: { value: "never" } },
                } }),
            });
            const stdoutOf = async (workerId: number): Promise<string> => {
                const loopId = await insertLoop(db, workerId, 1, "exec env worker state");
                const turnId = await insertTurn(db, loopId, 1, 102);
                const idDeferred = deferred<number>();
                const dispatchPromise = engine.dispatch({
                    statement: execStmt(null, 'echo "target=[$CARGO_TARGET_DIR] ci=[$CI] leak=[$PLURNK_SERVICE_LEAK]"'),
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
                return (await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" }))?.content ?? "";
            };
            assert.match(await stdoutOf(shaped), /target=\[\/tmp\/shared\] ci=\[\] leak=\[\]/,
                "the Worker's value is set, its masked ambient name is withheld, and a reserved name never reaches the command");
            assert.match(await stdoutOf(plain), /target=\[\] ci=\[1\] leak=\[\]/, "a sibling with no state sees the ceiling untouched");
        } finally {
            await db.close();
            if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
            if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
            else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
        }
    },
);
