import test, { describe, before as beforeAll, after as afterAll } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import ExecutorRegistry, { type RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import Daemon from "../../src/server/Daemon.ts";
import { serverProposals } from "./_approval.ts";
import { type ExecStatement, type RuntimeTag, type KillStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { testExecutors } from "./_execs.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { type Executor, type ExecArgs, type ExecResult } from "@plurnk/plurnk-execs";
import { readStmt, urlPath, execStmt as dslExecStmt, completeStmt, dispositionStmt, noteStmt } from "./_dsl.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputScheme } from "@plurnk/plurnk-schemes";
import { Mock } from "@plurnk/plurnk-providers";
import { waitForDb, rpcCall, subscribeNotifications, connect, withDaemon, runLoopToTerminal, waitFor } from "./_rpc.ts";
import { setTimeout as delay } from "node:timers/promises";
import { viableWindow } from "./_provider.ts";
import { makeRawMockResponse, makeMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";


describe("exec-concurrency", () => {
const statement = (body: string): ExecStatement => ({
    metadata: null,
    runtime: "controlled",
    aside: null,
    target: null,
    lineMarker: null,
    body,
    position: { line: 1, column: 1 },
});

const killStatement = (scheme: string, pathname: string): KillStatement => ({
    metadata: null,
    op: "KILL",
    aside: null,
    target: {
        kind: "url",
        raw: `${scheme}://${pathname}`,
        scheme,
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    },
    lineMarker: null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

class ControlledExecutor implements Executor {
    readonly runtime = "controlled";
    readonly glyph = "?";
    readonly starts: string[] = [];
    readonly #gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    #releaseFuture = false;

    // A runtime executor authors no manifest of its own: the face derives the read-only-output
    // default from its runtime declaration ({§network-address}), exactly like `sh`.
    get manifest() {
        return OutputScheme.manifestFromRuntime({ name: "controlled", glyph: "?", channels: { results: "text/plain" }, defaultChannel: "results" });
    }

    get defaultChannel(): string { return "results"; }
    get channels() { return { results: { mimetype: "text/plain" } }; }
    probe() { return Promise.resolve({ available: true }); }
    effect() { return "pure" as const; }

    async run(args: ExecArgs): Promise<ExecResult> {
        this.starts.push(args.body);
        const gate = Promise.withResolvers<void>();
        this.#gates.set(args.body, gate);
        if (this.#releaseFuture) gate.resolve();
        await gate.promise;
        args.setState("results", "closed");
        return { status: 200 };
    }

    release(body: string): void {
        this.#gates.get(body)?.resolve();
    }

    releaseAll(): void {
        this.#releaseFuture = true;
        for (const gate of this.#gates.values()) gate.resolve();
    }
}

const registry = (executor: ControlledExecutor): ExecutorRegistry => {
    const entry: RegistryEntry = {
        executor,
        namespaceOwner: { kind: "module", name: "controlled concurrency fixture" },
        glyph: executor.glyph,
        summary: "Blocks until the fixture releases it.",
        invocation: { body: { role: "fixture id", required: true }, signature: "<fixture id>" },
        details: "",
        available: true,
        detail: undefined,
    };
    return new ExecutorRegistry(new Map([[executor.runtime, entry]]));
};

const eventually = async (predicate: () => boolean, message: string): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail(message);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
};

test("{§exec-lifetime}: execution admission is FIFO and workspace-scoped", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "2";
    const db = await openMigrated();
    const executor = new ControlledExecutor();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    const executors = registry(executor);
    engine.setExecutors(executors);
    schemes.registerRuntimeSchemes(executors);
    try {
        const workspaceA = await insertWorkspace(db, `exec-cap-a-${crypto.randomUUID()}`);
        const sessionA1 = await insertSession(db, workspaceA);
        const sessionA2 = await insertSession(db, workspaceA);
        const loopA1 = await insertLoop(db, sessionA1, 1);
        const loopA2 = await insertLoop(db, sessionA2, 1);
        const turnA1 = await insertTurn(db, loopA1, 1, 102);
        const turnA2 = await insertTurn(db, loopA2, 1, 102);

        const workspaceB = await insertWorkspace(db, `exec-cap-b-${crypto.randomUUID()}`);
        const sessionB = await insertSession(db, workspaceB);
        const loopB = await insertLoop(db, sessionB, 1);
        const turnB = await insertTurn(db, loopB, 1, 102);

        const dispatch = (
            body: string,
            workspaceId: number,
            sessionId: number,
            loopId: number,
            turnId: number,
            sequence: number,
        ) => engine.dispatch({
            statement: statement(body),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence,
            origin: "model",
        });

        assert.deepEqual(
            await dispatch("a1", workspaceA, sessionA1, loopA1, turnA1, 1),
            { status: 200, outcome: "started" },
        );
        assert.deepEqual(
            await dispatch("a2", workspaceA, sessionA2, loopA2, turnA2, 1),
            { status: 200, outcome: "started" },
        );
        assert.deepEqual(
            await dispatch("a3", workspaceA, sessionA1, loopA1, turnA1, 2),
            { status: 202, outcome: "queued", executionsAhead: 2, concurrency: 2 },
        );
        assert.deepEqual(
            await dispatch("a4", workspaceA, sessionA2, loopA2, turnA2, 2),
            { status: 202, outcome: "queued", executionsAhead: 3, concurrency: 2 },
        );
        assert.deepEqual(executor.starts, ["a1", "a2"], "siblings share the workspace limit");

        assert.deepEqual(
            await dispatch("b1", workspaceB, sessionB, loopB, turnB, 1),
            { status: 200, outcome: "started" },
            "another workspace has independent capacity",
        );
        await eventually(() => executor.starts.includes("b1"), "the other workspace never entered its available slot");

        executor.release("a1");
        await eventually(() => executor.starts.includes("a3"), "the oldest queued execution never started");
        assert.equal(executor.starts.includes("a4"), false, "one released slot starts exactly one queued execution");
        executor.release("a2");
        await eventually(() => executor.starts.includes("a4"), "the second queued execution never started");
        assert.deepEqual(
            executor.starts.filter((body) => body.startsWith("a")),
            ["a1", "a2", "a3", "a4"],
            "same-workspace admission is FIFO across sessions",
        );
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});

test("{§exec-lifetime}: KILL cancels queued work without invoking its executor", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "1";
    const db = await openMigrated();
    const executor = new ControlledExecutor();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    const executors = registry(executor);
    engine.setExecutors(executors);
    schemes.registerRuntimeSchemes(executors);
    try {
        const workspaceId = await insertWorkspace(db, `exec-cancel-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (body: string, sequence: number, onDispatch?: (id: number) => void) => engine.dispatch({
            statement: statement(body), workspaceId, sessionId, loopId, turnId, sequence, origin: "model", onDispatch,
        });

        assert.deepEqual(await dispatch("running", 1), { status: 200, outcome: "started" });
        let queuedLogId = 0;
        assert.deepEqual(
            await dispatch("cancel-me", 2, (id) => { queuedLogId = id; }),
            { status: 202, outcome: "queued", executionsAhead: 1, concurrency: 1 },
        );
        assert.deepEqual(executor.starts, ["running"]);
        const queuedLog = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: queuedLogId });
        const pathname = (JSON.parse(queuedLog?.attrs ?? "{}") as { pathname?: string }).pathname;
        assert.ok(pathname);

        const killed = await engine.dispatch({
            statement: killStatement("controlled", pathname),
            workspaceId, sessionId, loopId, turnId, sequence: 3, origin: "model",
        });
        assert.equal(killed.status, 200);
        executor.release("running");
        await exec.idle();
        assert.deepEqual(executor.starts, ["running"], "cancelled queued work never enters the executor");

        const terminal = await engine.dispatch({
            statement: killStatement("controlled", pathname),
            workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "model",
        });
        // #757 — a KILL of an ended stream succeeds and reports how it ended.
        assert.equal(terminal.status, 200);
        assert.equal((terminal as { terminalStatus?: number }).terminalStatus, 200, "{§stream-control}: queued work its holder killed concludes as asked");
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});

test("{§exec-lifetime}: queue residence does not consume the execution timeout", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = "1";
    const db = await openMigrated();
    const executor = new ControlledExecutor();
    const executors = registry(executor);
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(executors);
    try {
        const workspaceId = await insertWorkspace(db, `exec-timeout-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId, executors });
        const attrs = (body: string, pathname: string, timeoutSec?: number) => ({
            runtime: "controlled",
            cwd: null,
            target: null,
            body,
            pathname,
            effect: "pure",
            ...(timeoutSec === undefined ? {} : { timeoutSec }),
        });

        assert.deepEqual(
            await exec.applyResolution({ attrs: attrs("running", "/1/1/1"), metadata: null }, ctx),
            { status: 200, outcome: "started" },
        );
        assert.equal(
            (await exec.applyResolution({ attrs: attrs("timed", "/1/1/2", 0.03), metadata: null }, ctx)).status,
            202,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        assert.deepEqual(executor.starts, ["running"], "the queued timeout has not admitted the executor");

        executor.release("running");
        await eventually(() => executor.starts.includes("timed"), "queued work was already timed out before admission");
        executor.release("timed");
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});
});

describe("exec-detached", () => {
// {§exec-lifetime} — `[{"lifetime":"detached"}]` outlives the loop (#494): the spawn survives its loop's own 200,
// is no obligation for that completion, and still ends with the daemon.










let prevDetachedWaitMs: string | undefined;
beforeAll(() => {
    prevDetachedWaitMs = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
});
afterAll(() => {
    if (prevDetachedWaitMs === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = prevDetachedWaitMs;
});

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A host exec that never exits on its own and leaves a heartbeat the test can read from outside.
const heartbeat = (file: string) => `while true; do date +%s%N > ${file}; sleep 0.05; done`;
const beat = async (file: string): Promise<string> => (await readFile(file, "utf8").catch(() => "")).trim();
const beating = async (file: string, ms: number): Promise<boolean> => {
    const before = await beat(file);
    await delay(ms);
    return before !== await beat(file);
};

test("{§exec-lifetime} a detached spawn is observed once, then outlives its loop and ends with the daemon", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const dir = await mkdtemp(join(tmpdir(), "exec-detached-"));
    const file = join(dir, "beat");
    try {
        const mock = new Mock({
            contextWindow: viableWindow(),
            responses: [mockTurn(`\`\`\`\`sh [{"lifetime": "detached"}]
${heartbeat(file)}
\`\`\`\`

\`\`\`\`SEND
the server stays up
\`\`\`\`
\`\`\`\`SEND
\`\`\`\``), mockTurn("````SEND [200]\n````")],
        });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-detached" });
                const concluded = subscribeNotifications(ws, "stream/concluded");
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "leave a server running" });
                const loopId = (run.result as { loopId: number }).loopId;

                // The detached stream remains live after its invocation is observed.
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 200,
                    { timeoutMs: 10000 },
                );
                await waitForDb(() => beat(file), (b) => b !== "", { timeoutMs: 5000 });
                assert.equal(mock.received.length, 2, "the invocation still requires a packet before completion");
                assert.equal(mock.remaining, 0);
                assert.equal(await beating(file, 400), true, "the detached spawn keeps running after the loop's 200");
                assert.equal(
                    (concluded() as Array<{ scheme: string }>).some((c) => c.scheme === "sh"),
                    false,
                    "no reap concluded the detached stream at loop end",
                );
            } finally { ws.close(); }
        });
        // withDaemon stopped the daemon: a detached spawn does not outlive it.
        await waitForDb(() => beating(file, 300), (moving) => ! moving, { timeoutMs: 10000 });
    } finally { await rm(dir, { recursive: true, force: true }); }
});
});

describe("exec-env-scoping", () => {
// SPEC {§exec} {§execution-output-identity} — an execution subprocess must NOT inherit plurnk's own
// secrets (provider keys, PLURNK_* config). The service scopes the env (ExecEnv.scoped:
// drop PLURNK_* + the provider key-vars) and hands it to the executor, which spawns with
// it (plurnk-execs 0.4.5+ ExecArgs.env). The canary is a PLURNK_*-shaped var, so the
// denylist drops it before the spawn.











const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

test(
    "{§execution-output-identity} an execution subprocess does not inherit plurnk's own env (provider keys / PLURNK_*)",
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
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "exec env scoping");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const idDeferred = deferred<number>();
            const dispatchPromise = engine.dispatch({
                statement: dslExecStmt(null, `echo "$${CANARY}"`),  // host runtime → propose
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
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
            assert.doesNotMatch(stdout?.content ?? "", /do-not-leak-to-subprocess/, "plurnk's own env must not reach the execution subprocess");
        } finally {
            await db.close();
            if (prev === undefined) delete process.env[CANARY]; else process.env[CANARY] = prev;
        }
    },
);

// {§execution-output-identity} the ceiling. The witness above uses a PLURNK_-prefixed canary, so it
// proves only the invariant and passes under any policy. This one proves the allowlist: an
// ordinary host name the policy does not admit never reaches the spawn, while one it does
// admit arrives intact — the distinction a denylist could not make.
test(
    "{§execution-output-identity} an execution subprocess inherits only the ambient names the policy admits",
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
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "exec env ceiling");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const idDeferred = deferred<number>();
            const dispatchPromise = engine.dispatch({
                statement: dslExecStmt(null, `echo "admitted=$${ADMITTED_IN_ENV} withheld=$${WITHHELD}"`),
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
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

// {§execution-output-identity} layer four — the Session's own state over the ambient ceiling, read at the spawn.
// The row is what the env verbs persist ({§functionality-coordinator}); here it is written directly so the
// spawn is witnessed alone: an enabled session entry sets its value, a disabled entry masks an ambient
// name for this Session only, a sibling with no row sees the ceiling untouched, and the invariant strips
// a reserved name even when the state names it.
test(
    "{§execution-output-identity} a Session's own environment reaches its next spawn; its sibling's ceiling is untouched",
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
            const workspaceId = await insertWorkspace(db, `exec-env-session-${crypto.randomUUID()}`);
            const shaped = await insertSession(db, workspaceId);
            const plain = await insertSession(db, workspaceId);
            await db.session_module_state_put.run({
                session_id: shaped, namespace_owner: "@plurnk/plurnk-service",
                state: JSON.stringify({ version: 1, definitions: {
                    CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" } },
                    CI: { origin: "service", enabled: false },
                    PLURNK_SERVICE_LEAK: { origin: "session", enabled: true, definition: { value: "never" } },
                } }),
            });
            const stdoutOf = async (sessionId: number): Promise<string> => {
                const loopId = await insertLoop(db, sessionId, 1, "exec env session state");
                const turnId = await insertTurn(db, loopId, 1, 102);
                const idDeferred = deferred<number>();
                const dispatchPromise = engine.dispatch({
                    statement: dslExecStmt(null, 'echo "target=[$CARGO_TARGET_DIR] ci=[$CI] leak=[$PLURNK_SERVICE_LEAK]"'),
                    workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
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
                "the Session's value is set, its masked ambient name is withheld, and a reserved name never reaches the command");
            assert.match(await stdoutOf(plain), /target=\[\] ci=\[1\] leak=\[\]/, "a sibling with no state sees the ceiling untouched");
        } finally {
            await db.close();
            if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
            if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
            else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
        }
    },
);

// {§host-path-layout} {§execution-output-identity} — when a daemon runs with an isolated HostPaths, its
// subprocesses, env:///READ, and operatorEnvironment() all see the daemon's resolved HOME rather
// than leaking into the operator's ambient process.env.HOME (#1224).
test(
    "{§host-path-layout} {§execution-output-identity} a daemon with an isolated HostPaths projects its HOME into subprocesses, env:///HOME, and operatorEnvironment",
    async () => {
        const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME";
        const isolatedHome = `/tmp/plurnk-isolated-home-${crypto.randomUUID()}`;
        const hostPaths = new HostPaths({ home: isolatedHome, env: {} });
        const db = await openMigrated();
        const daemon = new Daemon({ db, hostPaths });
        await daemon.start();
        try {
            assert.equal(daemon.operatorEnvironment().HOME, isolatedHome, "module launch base carries the daemon's isolated HOME");
            const { workspaceId } = await daemon.createWorkspace({ name: `isolated-home-${crypto.randomUUID()}` });
            await daemon.activateWorkspace({ workspaceId });
            const { sessionId } = await daemon.createSession({ workspaceId });
            const sessionEnv = (await daemon.readSessionEnvironment(workspaceId, sessionId))();
            assert.equal(sessionEnv.HOME, isolatedHome, "session environment resolves HOME to the daemon's HostPaths.home");

            const loopId = await insertLoop(db, sessionId, 1, "isolated home");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const envRead = await daemon.engine.dispatch({
                statement: readStmt(urlPath("env", "/HOME")),
                workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            });
            assert.equal(envRead.status, 200);
            assert.equal(envRead.content, isolatedHome, "READ (env:///HOME) matches the daemon's isolated HOME");

            const idDeferred = deferred<number>();
            const dispatchPromise = daemon.engine.dispatch({
                statement: dslExecStmt(null, 'printf "%s" "$HOME"'),
                workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
                onDispatch: (id) => idDeferred.resolve(id),
            });
            const logEntryId = await idDeferred.promise;
            daemon.engine.resolveProposal(logEntryId, { decision: "accept" });
            await dispatchPromise;
            const exec = daemon.schemes.get("exec") as Exec;
            await exec.idle();

            const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
            const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
            const stdout = (await db.test_get_channel.get<{ content: string }>({ entry_id: entry!.id, name: "stdout" }))?.content ?? "";
            assert.equal(stdout, isolatedHome, "subprocess $HOME resolves to the daemon's isolated HostPaths.home");
        } finally {
            await daemon.stop();
            await db.close();
            if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
            else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
        }
    },
);
});

describe("exec-hold", () => {
// {§exec-lifetime} — runtimes in
// PLURNK_SERVICE_EXEC_HOLD pause the cycle until their stream concludes, so the model never
// burns a turn waiting on a result the engine controls end-to-end. Bounded + fail-open.












// This file isolates the hold decision after ordinary optimistic settlement:
// disabling the latter keeps the selected-vs-unselected runtime distinction as
// the only variable under test.
let prevHoldWaitMs: string | undefined;
beforeAll(() => {
    prevHoldWaitMs = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
});
afterAll(() => {
    if (prevHoldWaitMs === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = prevHoldWaitMs;
});

const execStmt = (runtime: string, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

let wireN = 0;
const wire = async (finishAfterMs: number, effect: "read" | "host" | "pure" = "pure") => {
    // unique tag per wiring: testExecutors() is a shared cached registry — a duplicate
    // runtime registration throws and leaks the just-opened db, wedging the test file.
    const tag = `holdstub${++wireN}`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.registerRuntime(tag, {
        executor: {
            runtime: tag, glyph: "?",
            get manifest() { return { name: tag, channels: { results: "application/json" }, defaultChannel: "results", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "application/json" } }; },
            effect: () => effect,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args) => {
                await new Promise((r) => setTimeout(r, finishAfterMs));
                args.write("results", JSON.stringify([{ title: "HOLD-DONE" }]), "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        namespaceOwner: { kind: "module", name: `${tag} fixture` },
        glyph: "?", summary: "Hold fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } }, details: "", available: true, detail: undefined,
    });
    const workspaceId = await insertWorkspace(db, `hold-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "hold test");
    return { db, engine, schemes, workspaceId, sessionId, loopId, tag };
};

const streamsSection = (packetJson: string): string => {
    const p = JSON.parse(packetJson) as { sections?: Array<{ name: string; content: string }> };
    return p.sections?.find((s) => s.name === "work")?.content ?? "";
};

const driveLoop = async (finishAfterMs: number, midTurns: number, effect: "read" | "host" | "pure" = "pure", holdSuffix?: string) => {
    const { db, engine, schemes, workspaceId, sessionId, loopId, tag } = await wire(finishAfterMs, effect);
    // The effect-qualified selector uses the runtime's actual registered tag.
    if (holdSuffix !== undefined) process.env.PLURNK_SERVICE_EXEC_HOLD = `${tag}${holdSuffix}`;
    try {
        const responses = [
            { assistant: { content: "", reasoning: null, ops: [execStmt(tag, "go"), noteStmt("searching")] } },
            ...Array.from({ length: midTurns }, () => ({ assistant: { content: "", reasoning: null, ops: [dispositionStmt("WAIT", "waiting on the monitored stream")] } })),
            { assistant: { content: "", reasoning: null, ops: [completeStmt("done")] } },
        ];
        const provider = new Mock({ contextWindow: 100000, responses: responses });
        const t0 = Date.now();
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }], maxTurns: 5 });
        const elapsed = Date.now() - t0;
        const turn2 = await db.test_get_turn.get<{ packet: string }>({ id: result.turnIds[2] });
        return { result, elapsed, streams: streamsSection(turn2?.packet ?? "{}"), tag };
    } finally {
        await (schemes.get("exec") as Exec).idle();
        await db.close();
    }
};

test("{§exec-lifetime} a HOLD runtime pauses the cycle — turn 2 assembles AFTER the stream concludes", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "holdstub1";
    try {
        const { result, elapsed, streams } = await driveLoop(800, 0);
        assert.equal(result.result.status, 200);
        assert.ok(elapsed >= 800, `the cycle paused for the stream (elapsed ${elapsed}ms >= 800ms)`);
        assert.ok(!/holdstub1/.test(streams), "turn 2's packet lists no live holdstub stream after its completion");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});

test("{§exec-lifetime} a runtime OUTSIDE the hold set keeps the standard cycle — turn 2 sees the live stream", async () => {
    const prevHold = process.env.PLURNK_SERVICE_EXEC_HOLD;
    process.env.PLURNK_SERVICE_EXEC_HOLD = "some-other-runtime";
    try {
        // The standard cycle: T2 assembles immediately with the live stream
        // and parks on it (this direct Engine fixture has no daemon wake owner).
        const { result, streams } = await driveLoop(1200, 1);
        assert.equal(result.result.status, 202, "the unheld stream enters the ordinary monitored lifecycle");
        assert.ok(/holdstub2/.test(streams), "turn 2's packet LISTS the live stream — no hold applied outside the set");
    } finally {
        if (prevHold === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prevHold;
    }
});

test("{§exec-lifetime}: a `:read` delimiter holds a read-effect spawn", async () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_HOLD;
    try {
        const { elapsed, streams } = await driveLoop(400, 0, "read", ":read");
        assert.ok(!/holdstub/.test(streams), "turn 2 observed completion — the read-effect spawn was held by its :read delimiter");
        assert.ok(elapsed >= 350, "the cycle actually paused for the stream (held, not raced)");
    } finally { if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prior; }
});

test("{§exec-lifetime}: a `:host` delimiter does not hold a read-effect spawn", async () => {
    const prior = process.env.PLURNK_SERVICE_EXEC_HOLD;
    try {
        const { result, streams } = await driveLoop(2000, 1, "read", ":host");
        assert.equal(result.result.status, 202, "the mismatched selector leaves the stream monitored");
        assert.ok(/holdstub/.test(streams), "turn 2 saw the LIVE stream — a read spawn is not held by a :host delimiter");
    } finally { if (prior === undefined) delete process.env.PLURNK_SERVICE_EXEC_HOLD; else process.env.PLURNK_SERVICE_EXEC_HOLD = prior; }
});
});

describe("exec-lifetime", () => {
// {§exec-lifetime} — the fence states how long its run may live, and nothing else. The scope slot
// is text coordinates, which an execution has none of; an unreadable lifetime is refused by name
// before anything spawns. Real daemon, real `sh`, no proposal review (the run is consented).







const refusal = async (fence: string, name: string): Promise<{ status: number; problem: { type: string; detail: string; recovery?: string } }> => {
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse(`${fence}\nsleep 0\n\`\`\`\`\n\n\`\`\`\`WAIT\nObserve the refusal.\n\`\`\`\``, 10),
        makeRawMockResponse("````SEND [200]\nRefused; done.\n````", 10),
    ] });
    let row: { status: number; problem: { type: string; detail: string; recovery?: string } } | undefined;
    await withDaemon(mock, async (db, daemon, addr) => {
        const client = await connect(addr);
        try {
            await rpcCall(client, 1, "workspace.create", { name });
            const [workspace] = await daemon.listWorkspaces();
            const sessionId = await namedModelSession(daemon, workspace.id, "main");
            await runLoopToTerminal(client, 2, { prompt: "Run it.", sessionId });
            const rows = await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: sessionId });
            const refused = rows.find(({ op, origin }) => op === "sh" && origin === "model");
            assert.ok(refused, `the refused execution is a row: ${JSON.stringify(rows.map(({ op, status_rx }) => [op, status_rx]))}`);
            row = { status: refused.status_rx, problem: JSON.parse(refused.rx).problem };
        } finally { client.close(); }
    });
    assert.ok(row);
    return row;
};

test("{§exec-lifetime} {§diagnostic-observation}: a scope on an execution is refused, saying only that", { timeout: 120_000 }, async () => {
    const { status, problem } = await refusal("````sh <30,5>", "exec-scope");
    assert.equal(status, 400);
    assert.match(problem.type, /scheme\/exec\/scope-unsupported$/u);
    assert.equal(problem.detail, "An execution takes no scope.");
    assert.equal(problem.recovery, undefined);
});

test("{§exec-lifetime}: an unreadable lifetime is refused before the spawn, with every form it could take", { timeout: 120_000 }, async () => {
    const { status, problem } = await refusal('````sh [{"lifetime": "30"}]', "exec-lifetime-invalid");
    assert.equal(status, 400);
    assert.match(problem.type, /scheme\/exec\/lifetime-invalid$/u);
    assert.match(problem.detail, /'30' is not a lifetime/u);
    assert.match(problem.recovery ?? "", /"30s", "30m", "2h".*"loop", "turn", or "detached"/u);
});

test("{§exec-lifetime}: a tool's opaque metadata is still its own — the service reads no lifetime from it", { timeout: 120_000 }, async () => {
    // {§executor-contract} — `sh` takes the option-array shape, so a block that is not that shape is
    // the tool's to refuse. The service must not refuse it first in the name of `lifetime`.
    const { status, problem } = await refusal("````sh [ custom syntax ]", "exec-lifetime-opaque");
    assert.equal(status, 400);
    assert.match(problem.type, /executor\/metadata\/metadata-invalid$/u, "the executor's own refusal, not the service's");
    assert.doesNotMatch(problem.detail, /lifetime/u);
});

test("{§exec-lifetime}: a turn-scoped run is reaped at the next pre-turn; a loop-bound one at the loop's end", { timeout: 120_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse('````sh [{"lifetime": "turn"}]\nsleep 45\n````\n\n````NOTE\nBackgrounded for this turn only.\n````', 10),
        makeRawMockResponse("````NOTE\nThe next turn begins; the turn-scoped run is gone.\n````", 10),
        makeRawMockResponse("````SEND [200]\nDone.\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const client = await connect(addr);
        try {
            await rpcCall(client, 1, "workspace.create", { name: "exec-lifetime-turn" });
            const [workspace] = await daemon.listWorkspaces();
            const sessionId = await namedModelSession(daemon, workspace.id, "main");
            const { finalStatus } = await runLoopToTerminal(client, 2, { prompt: "Background it.", sessionId });
            assert.equal(finalStatus, 200, "the loop concluded without waiting on a stream it no longer holds");
            const open = await db.test_count_active_subscriptions.get<{ n: number }>({});
            assert.equal(open?.n, 0, "the turn-scoped stream did not survive into the subsequent turn");
        } finally { client.close(); }
    });
});

// {§exec-lifetime} {§notifications} A loop-bound run ends with its loop, whichever segment of the loop
// spawned it: reaped at the loop's terminal, its stream concluded before that terminal is announced.
for (const spawnedBy of ["the ending segment", "a segment before a park"] as const) {
    test(`{§exec-lifetime}: a loop-bound run spawned by ${spawnedBy} is reaped at its loop's terminal`, { timeout: 120_000 }, async (t) => {
        serverProposals(t, "accept");
        const window = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
        t.after(() => {
            if (window === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = window;
        });
        const parks = spawnedBy === "a segment before a park";
        const mock = new Mock({ contextWindow: 100_000, responses: [
            makeRawMockResponse(`\`\`\`\`sh\nsleep 45\n\`\`\`\`\n\n${parks ? "````WAIT [1]\nWaiting on it.\n````" : "````NOTE\nWorking on.\n````"}`, 10),
            makeRawMockResponse("````NOTE\nWorking on.\n````", 10),
        ] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `exec-lifetime-${parks ? "parked" : "ending"}` });
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            const order: string[] = [];
            const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
                const event = params as { scheme?: string; loopId?: number; result?: { status: number } };
                if (method === "stream/concluded" && event.scheme === "sh") order.push(`concluded ${event.result?.status}`);
                if (method === "loop/terminated") order.push(`terminated ${event.loopId} ${event.result?.status}`);
            });
            try {
                // The turn ceiling ends the loop in the segment after its spawn, or after the park, while the run still runs.
                const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Background it.", maxTurns: parks ? 2 : 1 });
                await waitForDb(async () => order, (events) => events.some((event) => event.startsWith("terminated")), { timeoutMs: 60_000 });
                assert.deepEqual(order, ["concluded 499", `terminated ${loopId} 429`], "the run is reaped before its loop's terminal is announced");
                const open = await db.test_count_active_subscriptions.get<{ n: number }>({});
                assert.equal(open?.n, 0, "no stream outlives its loop");
            } finally {
                off();
            }
        });
    });
}
});

describe("exec-timeout", () => {
// {§exec-lifetime} — a bounded `[{"lifetime": …}]` caps the spawn. At the deadline the service
// aborts it (bounded reap) and stamps the stream 504, distinct from a deliberate kill (499).
// Own file: real subprocess + timing, process-isolated.







test("{§exec-lifetime} a bounded lifetime kills the spawn at its deadline and closes the stream 504", { timeout: 60_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // `sleep 30` under a 2-second lifetime: the spawn MUST be killed at its deadline, never run to completion.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        // Park on the stream: its only conclusion is the reap, so turn 2 sees the 504 close.
        makeMockResponse("````sh [{\"lifetime\": \"2s\"}]\nsleep 30\n````\n\n````WAIT\nwaiting for the reap\n````", 10),
        makeMockResponse("````SEND [200]\nthe spawn timed out; done\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-timeout" });
            const concluded = subscribeNotifications(ws, "stream/concluded");
            const t0 = Date.now();
            await runLoopToTerminal(ws, 2, { prompt: "go" }, { timeoutMs: 45_000 });
            const elapsed = Date.now() - t0;
            // The proof: the deadline is never early, and a working lifetime ends the loop far short of the 30s the sleep
            // would take — a correctness check about the contract's own time, not a race.
            assert.ok(elapsed >= 2_000 && elapsed < 25_000, `the spawn was reaped at its 2s deadline, not run to 30s; elapsed=${elapsed}ms`);
            const closes = await waitFor(
                () => concluded() as Array<{ scheme: string; result: { status: number; problem?: { type: string } } }>,
                (events) => events.some(({ scheme }) => scheme === "sh"),
            );
            assert.ok(
                closes.some((c) => c.result.status === 504
                    && c.result.problem?.type === "https://problems.plurnk.xyz/scheme/exec/execution-timeout"),
                `the exec stream closed with the exact lifetime Problem; got ${JSON.stringify(closes.map((c) => c.result))}`,
            );
        } finally { ws.close(); }
    });
});
});

