import assert from "node:assert/strict";
import test from "node:test";
import { OutputScheme } from "@plurnk/plurnk-schemes";
import type { ExecStatement, KillStatement } from "@plurnk/plurnk-contracts";
import type { ExecArgs, ExecResult } from "@plurnk/plurnk-execs";
import Engine from "../../src/core/Engine.ts";
import ExecutorRegistry, { type Executor, type RegistryEntry } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import {
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
    makeSchemeCtx,
} from "./_helpers.ts";

const statement = (body: string): ExecStatement => ({
    op: "EXEC",
    annotation: null,
    delimiter: "",
    signal: "controlled",
    target: null,
    lineMarker: null,
    body,
    position: { line: 1, column: 1 },
});

const killStatement = (scheme: string, pathname: string): KillStatement => ({
    op: "KILL",
    annotation: null,
    delimiter: "",
    signal: null,
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
    body: null,
    position: { line: 1, column: 1 },
});

class ControlledExecutor implements Executor {
    readonly runtime = "controlled";
    readonly glyph = "?";
    readonly starts: string[] = [];
    readonly #gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    #releaseFuture = false;

    // A runtime executor authors no manifest of its own: the face derives the read-only-output
    // default from its runtime declaration ({§executor-scheme-output}), exactly like `sh`.
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

test("{§exec-concurrency}: EXEC admission is FIFO and workspace-scoped", async () => {
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
        const workerA1 = await insertWorker(db, workspaceA);
        const workerA2 = await insertWorker(db, workspaceA);
        const loopA1 = await insertLoop(db, workerA1, 1);
        const loopA2 = await insertLoop(db, workerA2, 1);
        const turnA1 = await insertTurn(db, loopA1, 1, 102);
        const turnA2 = await insertTurn(db, loopA2, 1, 102);

        const workspaceB = await insertWorkspace(db, `exec-cap-b-${crypto.randomUUID()}`);
        const workerB = await insertWorker(db, workspaceB);
        const loopB = await insertLoop(db, workerB, 1);
        const turnB = await insertTurn(db, loopB, 1, 102);

        const dispatch = (
            body: string,
            workspaceId: number,
            workerId: number,
            loopId: number,
            turnId: number,
            sequence: number,
        ) => engine.dispatch({
            statement: statement(body),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence,
            origin: "model",
        });

        assert.deepEqual(
            await dispatch("a1", workspaceA, workerA1, loopA1, turnA1, 1),
            { status: 200, outcome: "started" },
        );
        assert.deepEqual(
            await dispatch("a2", workspaceA, workerA2, loopA2, turnA2, 1),
            { status: 200, outcome: "started" },
        );
        assert.deepEqual(
            await dispatch("a3", workspaceA, workerA1, loopA1, turnA1, 2),
            { status: 202, outcome: "queued", executionsAhead: 2, concurrency: 2 },
        );
        assert.deepEqual(
            await dispatch("a4", workspaceA, workerA2, loopA2, turnA2, 2),
            { status: 202, outcome: "queued", executionsAhead: 3, concurrency: 2 },
        );
        assert.deepEqual(executor.starts, ["a1", "a2"], "siblings share the workspace limit");

        assert.deepEqual(
            await dispatch("b1", workspaceB, workerB, loopB, turnB, 1),
            { status: 200, outcome: "started" },
            "another workspace has independent capacity",
        );
        await eventually(() => executor.starts.includes("b1"), "the other workspace never entered its available slot");

        executor.release("a1");
        await eventually(() => executor.starts.includes("a3"), "the oldest queued EXEC never started");
        assert.equal(executor.starts.includes("a4"), false, "one released slot starts exactly one queued EXEC");
        executor.release("a2");
        await eventually(() => executor.starts.includes("a4"), "the second queued EXEC never started");
        assert.deepEqual(
            executor.starts.filter((body) => body.startsWith("a")),
            ["a1", "a2", "a3", "a4"],
            "same-workspace admission is FIFO across workers",
        );
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});

test("{§exec-concurrency}: KILL cancels queued work without invoking its executor", async () => {
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
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (body: string, sequence: number, onDispatch?: (id: number) => void) => engine.dispatch({
            statement: statement(body), workspaceId, workerId, loopId, turnId, sequence, origin: "model", onDispatch,
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
            workspaceId, workerId, loopId, turnId, sequence: 3, origin: "model",
        });
        assert.equal(killed.status, 200);
        executor.release("running");
        await exec.idle();
        assert.deepEqual(executor.starts, ["running"], "cancelled queued work never enters the executor");

        const terminal = await engine.dispatch({
            statement: killStatement("controlled", pathname),
            workspaceId, workerId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(terminal.status, 410, "the ordinary stream lifecycle records queued cancellation as 499");
    } finally {
        executor.releaseAll();
        await exec.idle();
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_CONCURRENCY;
        else process.env.PLURNK_SERVICE_EXEC_CONCURRENCY = previous;
    }
});

test("{§exec-concurrency}: queue residence does not consume the EXEC timeout", async () => {
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
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, executors });
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
            await exec.applyResolution({ attrs: attrs("running", "/1/1/1") }, ctx),
            { status: 200, outcome: "started" },
        );
        assert.equal(
            (await exec.applyResolution({ attrs: attrs("timed", "/1/1/2", 0.03) }, ctx)).status,
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
