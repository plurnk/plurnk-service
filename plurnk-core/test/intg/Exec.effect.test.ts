// {§exec-host-proposes} {§exec-readpure-ungated} The executor declares its effect; the
// service owns the policy. `host` runtimes (sh/node/python, file-backed
// sqlite) propose — a human gate. `read`/`pure` runtimes (search, :memory:
// sqlite) auto-run ungated: no proposal, no notification — but, like every
// exec, they background and stream their output ({§exec-stream}), not in-band.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePath, type ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, rootWorkspace, seedEntryWithChannel } from "./_helpers.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    schemes.registerRuntimeSchemes(executors); // {§executor-scheme-output} Register per-tag READ faces as daemon boot does.
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
        // No in-band receipt: like every exec it backgrounds + streams ({§exec-stream}); the output
        // reaches the model via the env-observation injector next turn, not here.
        assert.equal(result.body, undefined, "pure auto-run returns no in-band body — it streams");
        await exec.idle();
    } finally { await db.close(); }
});

test("effect-gating: a pure EXEC being applied is never discoverable as a client proposal", async () => {
    const { db, engine, exec, workspaceId, workerId, loopId, turnId } = await wire();
    const applyEntered = deferred<void>();
    const releaseApply = deferred<void>();
    const originalApply = exec.applyResolution.bind(exec);
    exec.applyResolution = async (args, ctx) => {
        applyEntered.resolve();
        await releaseApply.promise;
        return originalApply(args, ctx);
    };
    const idDeferred = deferred<number>();
    const dispatched = engine.dispatch({
        statement: execStmt("sqlite", null, "SELECT 1 AS n;"),
        workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        onDispatch: (id) => idDeferred.resolve(id),
    });
    try {
        const logEntryId = await idDeferred.promise;
        await applyEntered.promise;

        assert.deepEqual(engine.pendingProposalIds(), [], "effect-auto execution has no resolution waiter");
        assert.deepEqual(
            await engine.pendingProposals(workspaceId),
            [],
            "reconnect discovery cannot advertise an operation the public resolution seam does not own",
        );

        releaseApply.resolve();
        const result = await dispatched;
        assert.equal(result.status, 200);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.status_rx, 200);
        assert.equal((JSON.parse(row?.attrs ?? "{}") as { effect?: unknown }).effect, "pure");
    } finally {
        releaseApply.resolve();
        await dispatched.catch(() => undefined);
        await exec.idle();
        await db.close();
    }
});

// {§exec-target-routing} {§executor-sinks}: cwd and target remain distinct inputs.
test("{§exec-target-routing}: targetless sqlite ignores workspace cwd and opens an in-memory database", async () => {
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
        // The output streams like every EXEC; a project directory never becomes the SQLite target.
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

test("one canonical target derives one preserved effect fact (#107)", async () => {
    const effectCalls: Array<{ target: string | null; argumentCount: number }> = [];
    const runs: Array<{ command: string; cwd: string | null; target: string | null; materialized?: string }> = [];
    const exe: Executor = {
        runtime: "tool", glyph: "🔧",
        get manifest(): SchemeManifest { return { name: "tool" } as unknown as SchemeManifest; },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "application/json" } }; },
        run: async ({ command, cwd, target, setState }) => {
            runs.push({
                command,
                cwd,
                target,
                ...(target?.startsWith(tmpdir()) === true
                    ? { materialized: await readFile(target, "utf8") }
                    : {}),
            });
            setState("results", "closed");
            return { status: 200 };
        },
        probe: async () => ({ available: true }),
        effect(target: string | null): Effect {
            effectCalls.push({ target, argumentCount: arguments.length });
            return target === null ? "pure" : "read";
        },
    };
    const registry = new ExecutorRegistry(new Map([["tool", { executor: exe, namespaceOwner: { kind: "module", name: "effect fixture" }, glyph: "🔧", example: "", documentation: "", available: true, detail: undefined }]]));
    const db = await openMigrated();
    const root = await mkdtemp(join(tmpdir(), "plurnk-effect-"));
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(registry);
    const workspaceId = await insertWorkspace(db, `canonical-effect-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "canonical effect");
    const turnId = await insertTurn(db, loopId, 1, 102);
    try {
        await writeFile(join(root, "data.txt"), "local data");
        await mkdir(join(root, "work"));
        await rootWorkspace(db, workspaceId, root);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/source",
            channel: "body",
            content: "scheme data",
            state: "static",
        });

        const schemeTarget = parsePath("worker:///source#body");
        assert.ok(schemeTarget !== null);
        const statements: ExecStatement[] = [
            execStmt("tool", null, "inline"),
            execStmt("tool", "data.txt", "file input"),
            execStmt("tool", "work", "directory cwd"),
            { ...execStmt("tool", null, ""), target: schemeTarget },
            { ...execStmt("tool", null, "filter"), target: schemeTarget },
        ];
        const effects: Effect[] = [];
        for (const [index, statement] of statements.entries()) {
            let logEntryId: number | undefined;
            const result = await engine.dispatch({
                statement,
                workspaceId, workerId, loopId, turnId,
                sequence: index + 1,
                origin: "model",
                onDispatch: (id) => { logEntryId = id; },
            });
            assert.equal(result.status, 200);
            assert.notEqual(logEntryId, undefined);
            const row = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId as number });
            effects.push((JSON.parse(row?.attrs ?? "{}") as { effect: Effect }).effect);
        }
        await exec.idle();

        assert.deepEqual(effectCalls, [
            { target: null, argumentCount: 1 },
            { target: "data.txt", argumentCount: 1 },
            { target: null, argumentCount: 1 },
            { target: null, argumentCount: 1 },
            { target: "worker:///source#body", argumentCount: 1 },
        ], "effect() is called once against the canonical logical target and never receives command metadata");
        assert.deepEqual(effects, ["pure", "read", "pure", "pure", "read"], "the admitted effect fact is persisted with each invocation");
        assert.deepEqual(runs.map(({ command, cwd, target, materialized }) => ({
            command,
            cwd: cwd === join(root, "work") ? "<directory>" : cwd,
            target: target?.startsWith(tmpdir()) === true ? "<materialized>" : target,
            ...(materialized === undefined ? {} : { materialized }),
        })), [
            { command: "inline", cwd: root, target: null },
            { command: "file input", cwd: root, target: "data.txt" },
            { command: "directory cwd", cwd: "<directory>", target: null },
            { command: "scheme data", cwd: root, target: null },
            { command: "filter", cwd: root, target: "<materialized>", materialized: "scheme data" },
        ], "run() receives the correctly routed local realization of the same invocation");
    } finally {
        await exec.idle();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("bare EXEC resolves to sh and respects the workspace's sh policy gate", async () => {
    const { db, engine, exec, workspaceId, workerId, loopId, turnId } = await wire();
    try {
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ execs: { PLURNK_EXECS_SH: "0" } }) });
        const result = await engine.dispatch({
            statement: execStmt("", null, "echo hi"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501, "sh disabled → bare EXEC is refused, not proposed or spawned");
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/exec/runtime-disabled");
        assert.equal(result.problem?.requestedRuntime, "sh");
        assert.equal(result.problem?.retryable, false);
        assert.ok(typeof result.problem?.recovery === "string");
        await exec.idle();
    } finally { await db.close(); }
});
