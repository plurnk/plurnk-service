import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import SessionName, { SessionNameError } from "../../src/core/SessionName.ts";
import Results from "../../src/core/results.ts";
import Envelope from "../../src/server/envelope.ts";
import ExecutionOutputs from "../../src/core/ExecutionOutputs.ts";
import Daemon from "../../src/server/Daemon.ts";
import { ownSession, serverProposals } from "./_approval.ts";
import { type ExecStatement, type RuntimeTag, type UrlPath, type ReadStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel } from "./_db.ts";
import { testExecutors, executionAddress } from "./_execs.ts";
import { schemeManifest } from "./_scheme.ts";
import { type Executor, type Effect } from "@plurnk/plurnk-execs";
import { type SchemeManifest } from "../../src/core/types.ts";
import { localPath } from "./_dsl.ts";
import { writeFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { type RepresentationPreparationRequest, type SchemeCtx, type SchemeHandler, OutputScheme, type EntryReadResult } from "@plurnk/plurnk-schemes";
import { parsePath } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import { type WakeSessionPayload } from "../../src/core/ChannelWrite.ts";
import { rpcCall, connect, runLoopToTerminal } from "./_rpc.ts";
import { clientRead } from "./_client-read.ts";
import { makeMockResponse } from "./_mock.ts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { MCP_CONTROLS, mcpFixture, stdioEntry } from "./_mcp-config.ts";


describe("Exec.scheme-source", () => {
type Actor = {
    readonly sessionId: number;
    readonly loopId: number;
    readonly turnId: number;
    sequence: number;
};

type Run = {
    readonly body: string;
    readonly target: string | null;
    readonly metadata?: readonly string[];
    readonly materialized?: string;
};

const urlTarget = (raw: string): UrlPath => {
    const target = parsePath(raw);
    if (target?.kind !== "url") throw new Error(`Expected a URL target: ${raw}`);
    return target;
};

const execStatement = (target: string, body: string, metadata: string[] | null = null): ExecStatement => ({
    metadata,
    aside: null,
    runtime: "tool", target: urlTarget(target),
    lineMarker: null,
    body,
    position: { line: 1, column: 0 },
});

const runtimeManifest = (name: string): SchemeManifest => OutputScheme.manifestFromRuntime({
    name,
    channels: { results: "text/plain" },
    defaultChannel: "results",
});

const materializeSource = async (
    request: RepresentationPreparationRequest,
    ctx: SchemeCtx,
    content: string,
    channel = "body",
) => {
    const written = await ctx.entries.write(request.pathname, {
        channels: {
            [channel]: { content, mimetype: "text/plain" },
        },
    });
    assert.ok(written.status === 200 || written.status === 201);
    return { status: 200 } as const;
};

const wire = async (beforeRun?: () => Promise<void>): Promise<{
    readonly db: Awaited<ReturnType<typeof openMigrated>>;
    readonly engine: Engine;
    readonly exec: Exec;
    readonly schemes: SchemeRegistry;
    readonly workspaceId: number;
    readonly root: Actor;
    readonly runs: Run[];
    readonly wakes: WakeSessionPayload[];
    actor(parentSessionId: number | null, name: string): Promise<Actor>;
    dispatch(actor: Actor, target: string, body?: string, metadata?: string[] | null): Promise<Awaited<ReturnType<Engine["dispatch"]>>>;
    close(): Promise<void>;
}> => {
    const runs: Run[] = [];
    const wakes: WakeSessionPayload[] = [];
    const executor: Executor = {
        runtime: "tool",
        glyph: "🔧",
        get manifest(): SchemeManifest { return runtimeManifest("tool"); },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "text/plain" } }; },
        async prepare({ cwd }) { return { status: 200, cwd }; },
        async run({ body, target, metadata, setState }) {
            await beforeRun?.();
            runs.push({
                body,
                target,
                ...(metadata == null ? {} : { metadata }),
                ...(target === null ? {} : { materialized: await readFile(target, "utf8") }),
            });
            if (body === "replace-temporary-with-directory" && target !== null) {
                await rm(target);
                await mkdir(target);
            }
            setState("results", "closed");
            return { status: 200 };
        },
        async probe() { return { available: true }; },
        effect(target: string | null): Effect { return target === null ? "pure" : "read"; },
    };
    const executors = new ExecutorRegistry(new Map([
        ["tool", {
            executor,
            namespaceOwner: { kind: "module", name: "scheme-source fixture" },
            glyph: "🔧",
            summary: "Scheme source fixture.",
            invocation: {
                body: { role: "fixture input", required: false },
                target: { role: "fixture resource", required: false, kind: "resource" },
                example: { body: "fixture" },
            },
            details: "",
            available: true,
            detail: undefined,
        }],
    ]));
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.registerRuntimeSchemes(executors);
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({
        db,
        schemes,
        wakeSessionNotify: (payload) => { wakes.push(payload); },
    });
    engine.setExecutors(executors);
    const workspaceId = await insertWorkspace(db, `exec-source-${crypto.randomUUID()}`);
    const makeActor = async (parentSessionId: number | null, name: string): Promise<Actor> => {
        const sessionId = await insertSession(db, workspaceId, parentSessionId, name);
        const loopId = await insertLoop(db, sessionId, 1, `${name} source test`);
        const turnId = await insertTurn(db, loopId, 1, 102);
        return { sessionId, loopId, turnId, sequence: 0 };
    };
    const root = await makeActor(null, "root");
    return {
        db,
        engine,
        exec,
        schemes,
        workspaceId,
        root,
        runs,
        wakes,
        actor: makeActor,
        async dispatch(actor, target, body = "", metadata = null) {
            const result = await engine.dispatch({
                statement: execStatement(target, body, metadata),
                workspaceId,
                sessionId: actor.sessionId,
                loopId: actor.loopId,
                turnId: actor.turnId,
                sequence: ++actor.sequence,
                origin: "model",
            });
            await exec.idle();
            return result;
        },
        async close() {
            await exec.idle();
            await schemes.close();
            await db.close();
        },
    };
};

// {§exec-target-routing} {§exec-target-routing} A scheme-backed execution source
// is one exact ordinary READ; non-native sources use a spawn-scoped temporary.
test("{§op-methods-op-dispatch}: create, launch, and delete are ordered without waiting for an asynchronous executor", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    const gate = Promise.withResolvers<void>();
    const ctx = await wire(() => gate.promise);
    try {
        const source = "````EDIT (workspace:///script)\nsource code\n````\n````tool (workspace:///script)````\n````KILL (workspace:///script)````\n````NOTE\nContinue the task.\n````";
        const result = await ctx.engine.runTurn({
            workspaceId: ctx.workspaceId, sessionId: ctx.root.sessionId, loopId: ctx.root.loopId,
            messages: [], provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
        });
        const rows = await ctx.db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ op }) => ["EDIT", "tool", "KILL"].includes(op ?? "")).map(({ op, status_rx }) => [op, status_rx]), [
            ["EDIT", 201], ["tool", 200], ["KILL", 200],
        ]);
        assert.equal(await ctx.db.test_get_entry_id_by_pathname.get({ pathname: "/script" }), undefined, "cleanup has happened while the executor remains in flight");
        assert.equal(ctx.runs.length, 0, "dispatch does not imply process completion");
        gate.resolve();
        await ctx.exec.idle();
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), ["source code"], "execution acquired the source at its authored position before KILL");
    } finally {
        gate.resolve();
        await ctx.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§exec-target-routing} execution source READ preserves the complete authored scheme address (#163)", async () => {
    const ctx = await wire();
    const seen: RepresentationPreparationRequest[] = [];
    const completeSource = Array.from({ length: 20 }, (_, index) => `source line ${index + 1}`).join("\n");
    const raw = "source://alice:secret@example.test:8443/items/path?b=2&a=1&a=3#payload";
    try {
        ctx.schemes.register("source", {
            manifest: {
                ...schemeManifest("source", { payload: "text/plain" }, "payload"),
                metadataModifier: true,
            },
            async prepareRepresentation(request, schemeCtx) {
                seen.push(structuredClone(request));
                return materializeSource(request, schemeCtx, completeSource, "payload");
            },
        } satisfies SchemeHandler);

        const result = await ctx.dispatch(ctx.root, raw, "transform", ["Accept: text/plain", "X-Trace: one:two"]);

        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.pathname, "/example.test/items/path");
        const preparedTarget = seen[0]?.target;
        assert.equal(preparedTarget?.kind, "url");
        if (preparedTarget?.kind !== "url") throw new Error("source preparation lost its URL target");
        assert.equal(preparedTarget.username, "alice");
        assert.equal(preparedTarget.password, "secret");
        assert.equal(preparedTarget.hostname, "example.test");
        assert.equal(preparedTarget.port, 8443);
        assert.equal(preparedTarget.pathname, "/items/path");
        assert.equal(preparedTarget.query, "b=2&a=1&a=3");
        assert.equal(seen[0]?.metadata, null, "source acquisition does not inherit another tool's metadata");
        assert.deepEqual(ctx.runs[0]?.metadata, ["Accept: text/plain", "X-Trace: one:two"], "the invoked tool owns the ordered raw blocks");
        assert.equal(preparedTarget.fragment, null, "core withholds channel selection from acquisition");
        assert.deepEqual(ctx.runs.map(({ body, materialized }) => ({ body, materialized })), [
            { body: "transform", materialized: completeSource },
        ]);
        const tempPath = ctx.runs[0]?.target;
        assert.ok(tempPath !== null && tempPath !== undefined);
        await assert.rejects(
            readFile(tempPath, "utf8"),
            (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT",
            "the source temporary is removed after the executor settles",
        );
    } finally {
        await ctx.close();
    }
});

test("{§executor-contract} execution metadata does not require the source scheme to accept metadata", async () => {
    const ctx = await wire();
    try {
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation(request, schemeCtx) {
                assert.equal(request.metadata, null);
                return materializeSource(request, schemeCtx, "program");
            },
        } satisfies SchemeHandler);
        const metadata = ["opaque tool option", " second block "];
        const result = await ctx.dispatch(ctx.root, "source:///script", "input", metadata);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.deepEqual(ctx.runs[0]?.metadata, metadata);
        assert.equal(ctx.runs[0]?.materialized, "program");
    } finally {
        await ctx.close();
    }
});

test("{§exec-target-routing} independent spawns never reuse one temporary identity", async () => {
    const first = await wire();
    const second = await wire();
    try {
        for (const [ctx, content] of [[first, "first"], [second, "second"]] as const) {
            ctx.schemes.register("source", {
                manifest: schemeManifest("source"),
                async prepareRepresentation(request, schemeCtx) {
                    return materializeSource(request, schemeCtx, content);
                },
            } satisfies SchemeHandler);
            const result = await ctx.dispatch(ctx.root, "source:///item");
            assert.equal(result.status, 200);
        }

        assert.notEqual(
            first.runs[0]?.target,
            second.runs[0]?.target,
            "identical database coordinates in separate daemon instances cannot alias in the host temporary directory",
        );
    } finally {
        await Promise.all([first.close(), second.close()]);
    }
});

test("{§exec-target-routing} cleanup failure preserves the settled result and complete diagnostic cause", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const ctx = await wire();
    let tempPath: string | null = null;
    try {
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation(request, schemeCtx) {
                return materializeSource(request, schemeCtx, "temporary content");
            },
        } satisfies SchemeHandler);

        const started = await ctx.dispatch(ctx.root, "source:///item", "replace-temporary-with-directory");
        tempPath = ctx.runs[0]?.target ?? null;

        assert.equal(started.status, 200);
        assert.equal(ctx.wakes.length, 1);
        assert.equal(ctx.wakes[0]?.result.status, 200, "cleanup cannot rewrite the executor's settled result");
        assert.ok(tempPath !== null);
        assert.equal((await stat(tempPath)).isDirectory(), true, "the specimen leaves a real unlink failure behind");
        assert.equal(diagnostics.length, 1, "cleanup failure is diagnosed exactly once");
        assert.match(String(diagnostics[0]?.[0]), /Execution source temporary cleanup failed/);
        const cause = diagnostics[0]?.[1];
        assert.ok(cause instanceof Error);
        assert.equal("path" in cause ? cause.path : undefined, tempPath);
        assert.ok("code" in cause && (cause.code === "EISDIR" || cause.code === "EPERM"));
    } finally {
        if (tempPath !== null) await rm(tempPath, { recursive: true, force: true });
        await ctx.close();
    }
});

test("{§session-scheme} execution source READ preserves literal shared and named scratch identities", async () => {
    const ctx = await wire();
    try {
        const child = await ctx.actor(ctx.root.sessionId, "child");
        const sibling = await ctx.actor(ctx.root.sessionId, "sibling");
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "workspace",
            pathname: "/script",
            content: "commons command",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            authority: await SessionName.forId(ctx.db, ctx.root.sessionId),
            scheme: "session",
            pathname: "/script",
            content: "root command",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            authority: await SessionName.forId(ctx.db, child.sessionId),
            scheme: "session",
            pathname: "/script",
            content: "child command",
        });

        const commonsRead = await ctx.dispatch(ctx.root, "workspace:///script#body");
        assert.equal(commonsRead.status, 200, JSON.stringify(commonsRead));
        assert.equal((await ctx.dispatch(ctx.root, `session://${await SessionName.forId(ctx.db, ctx.root.sessionId)}/script#body`)).status, 200);
        assert.equal((await ctx.dispatch(ctx.root, "session://child/script#body")).status, 200);
        assert.deepEqual(ctx.runs.map(({ body }) => body), ["", "", ""]);
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), [
            "commons command",
            "root command",
            "child command",
        ]);

        // {§session-scheme} — a sibling names another session's space and materializes it (#394).
        const named = await ctx.dispatch(sibling, "session://child/script#body");
        assert.equal(named.status, 200, JSON.stringify(named));
        assert.equal(ctx.runs.at(-1)?.materialized, "child command", "the sibling's execution materialized the named session's script");
        const unknown = await ctx.dispatch(ctx.root, "session://unknown/script#body");
        assert.equal(unknown.status, 404);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/scheme/session/entry-not-found");
        assert.equal(ctx.runs.length, 4, "failed source resolution never invokes the executor");
    } finally {
        await ctx.close();
    }
});

test("{§execution-output-identity}: execution source READ uses the same workspace output from either session", async () => {
    const ctx = await wire();
    try {
        const child = await ctx.actor(ctx.root.sessionId, "child");
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "tool",
            pathname: "/aa123456",
            channel: "results",
            content: "root stream command",
            state: "closed",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "tool",
            pathname: "/bb234567",
            channel: "results",
            content: "child stream command",
            state: "closed",
        });

        assert.equal((await ctx.dispatch(ctx.root, "tool:///aa123456#results")).status, 200);
        assert.equal((await ctx.dispatch(child, "tool:///bb234567#results")).status, 200);
        assert.deepEqual(ctx.runs.map(({ body }) => body), ["", ""]);
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), [
            "root stream command",
            "child stream command",
        ]);
    } finally {
        await ctx.close();
    }
});

test("{§exec-target-routing} execution source eligibility and failures come from the owning READ contract (#163)", async () => {
    const ctx = await wire();
    let loggingPreparationCalled = false;
    try {
        const auditManifest = schemeManifest("audit");
        ctx.schemes.register("audit", {
            manifest: { ...auditManifest, category: "logging" },
            async prepareRepresentation() {
                loggingPreparationCalled = true;
                return { status: 200 };
            },
        } satisfies SchemeHandler);
        ctx.schemes.register("writeonly", {
            manifest: schemeManifest("writeonly"),
        } satisfies SchemeHandler);
        ctx.schemes.register("absent", {
            manifest: schemeManifest("absent"),
            async prepareRepresentation() {
                return Results.failure(
                    "scheme:absent",
                    "representation-not-found",
                    404,
                    "The source representation does not exist.",
                );
            },
        } satisfies SchemeHandler);
        ctx.schemes.register("failing", {
            manifest: schemeManifest("failing"),
            async prepareRepresentation() {
                return Results.failure(
                    "scheme:failing",
                    "source-refused",
                    409,
                    "The source owner refused this representation.",
                    {},
                    { retryable: false },
                );
            },
        } satisfies SchemeHandler);

        const logging = await ctx.dispatch(ctx.root, "audit:///event");
        assert.equal(logging.status, 501);
        assert.equal(logging.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/exec-source-not-data");
        assert.equal(loggingPreparationCalled, false);

        const writeonly = await ctx.dispatch(ctx.root, "writeonly:///item");
        assert.equal(writeonly.status, 404);
        assert.equal(writeonly.problem?.type, "https://problems.plurnk.xyz/scheme/writeonly/entry-not-found");
        // #425 F4 — the owning identity stays; the execution slot contract rides the recovery.
        assert.equal(writeonly.problem?.recovery, "The target `writeonly:///item` names the program resource; the body is its arguments.");

        const unknown = await ctx.dispatch(ctx.root, "unknown:///item");
        assert.equal(unknown.status, 501);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");

        const absent = await ctx.dispatch(ctx.root, "absent:///item");
        assert.equal(absent.status, 404);
        assert.equal(absent.problem?.type, "https://problems.plurnk.xyz/scheme/absent/representation-not-found");
        // The recovery states the slot contract and never guesses that the missing resource was a tool call.
        assert.doesNotMatch(String(absent.problem?.recovery), /\[[a-z]+\] \(/, "execution does not guess that a missing resource was intended as a tool call");
        assert.equal(absent.problem?.recovery, "The target `absent:///item` names the program resource; the body is its arguments.");

        const failing = await ctx.dispatch(ctx.root, "failing:///item");
        assert.equal(failing.status, 409);
        assert.equal(failing.problem?.type, "https://problems.plurnk.xyz/scheme/failing/source-refused");
        assert.equal(failing.problem?.detail, "The source owner refused this representation.");
        assert.equal(ctx.runs.length, 0);
    } finally {
        await ctx.close();
    }
});

test("{§exec-target-routing} an own-scheme target that can never be a stream is a name for the run; a real stream id stays a source (#758)", async () => {
    const ctx = await wire();
    try {
        const labelled = await ctx.dispatch(ctx.root, "tool:///daemon-env", "print the environment");
        assert.equal(labelled.status < 400, true, `a label target with a body runs: ${labelled.status}`);
        assert.deepEqual(ctx.runs.map(({ body, target }) => ({ body, target })), [{ body: "print the environment", target: null }]);

        const stream = await ctx.dispatch(ctx.root, "tool:///0badcafe", "print the environment");
        assert.equal(stream.status, 404, "an eight-hex stream id is still read as the program source");
        assert.equal(ctx.runs.length, 1);

        const bodiless = await ctx.dispatch(ctx.root, "tool:///daemon-env", "");
        assert.equal(bodiless.status, 404, "without a body there is nothing else to run");
        assert.equal(ctx.runs.length, 1);
    } finally {
        await ctx.close();
    }
});

// {§exec-target-routing} — the recorded shape (#853, run99 qflash): ```sh (workspace:///_plurnk/plurnk/sh.md)```
// over `git checkout -- …` was accepted, realized as a host temporary the containerized runtime never saw,
// and failed as `cannot open /tmp/plurnk-exec-….md`.
test("{§exec-target-routing} {§diagnostic-observation} a generated reference target is refused at admission, saying what it is and nothing more", async () => {
    const ctx = await wire();
    try {
        const withBody = await ctx.dispatch(ctx.root, "workspace:///_plurnk/plurnk/tool.md", "git checkout -- src/_pytest/assertion/util.py");
        assert.equal(withBody.status, 400);
        assert.match(String(withBody.problem?.type), /\/target-is-documentation$/);
        assert.equal(withBody.problem?.detail, "`workspace:///_plurnk/plurnk/tool.md` is reference documentation the harness generated, not a program; tool cannot run it.");
        assert.equal(withBody.problem?.recovery, undefined, "the body is not presumed to be a command");
        const bodiless = await ctx.dispatch(ctx.root, "workspace:///_plurnk/tools/tool.md");
        assert.equal(bodiless.status, 400);
        assert.equal(bodiless.problem?.recovery, undefined);
        assert.equal(ctx.runs.length, 0, "nothing was realized or run");
    } finally {
        await ctx.close();
    }
});

// {§exec-target-routing} — the recorded shape (#882): ```sh (log:///…)``` was realized under host
// /tmp, which the bench's containerized runtime never mounts, and failed mid-run.
test("{§exec-target-routing} a standalone source is realized under the knob's directory and removed afterwards", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_SCRATCH;
    const scratch = join(tmpdir(), `plurnk-scratch-${crypto.randomUUID()}`, "nested");
    process.env.PLURNK_SERVICE_EXEC_SCRATCH = scratch;
    let ctx: Awaited<ReturnType<typeof wire>> | null = null;
    try {
        ctx = await wire();
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation(request, schemeCtx) {
                return materializeSource(request, schemeCtx, "program");
            },
        } satisfies SchemeHandler);
        const result = await ctx.dispatch(ctx.root, "source:///script.py");
        assert.equal(result.status, 200, JSON.stringify(result));
        const target = ctx.runs[0]?.target;
        assert.ok(target !== null && target !== undefined);
        assert.equal(dirname(target), scratch, "the executor saw a path under the scratch directory");
        assert.match(basename(target), /^plurnk-exec-[0-9a-f-]{36}\.py$/u);
        assert.equal(ctx.runs[0]?.materialized, "program");
        assert.equal((await stat(scratch)).mode & 0o777, 0o700, "created on first use, private to the daemon");
        await assert.rejects(stat(target), { code: "ENOENT" }, "the source is removed after the run settles");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_SCRATCH;
        else process.env.PLURNK_SERVICE_EXEC_SCRATCH = previous;
        await ctx?.close();
        await rm(dirname(scratch), { recursive: true, force: true });
    }
});

test("{§exec-target-routing} an unusable scratch directory refuses the execution at admission", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_SCRATCH;
    const occupied = join(tmpdir(), `plurnk-scratch-${crypto.randomUUID()}`);
    await writeFile(occupied, "not a directory");
    process.env.PLURNK_SERVICE_EXEC_SCRATCH = occupied;
    let ctx: Awaited<ReturnType<typeof wire>> | null = null;
    try {
        ctx = await wire();
        ctx.schemes.register("source", {
            manifest: schemeManifest("source"),
            async prepareRepresentation() {
                throw new Error("admission refused before any source was read");
            },
        } satisfies SchemeHandler);
        const refused = await ctx.dispatch(ctx.root, "source:///script");
        assert.equal(refused.status, 400);
        assert.match(String(refused.problem?.type), /\/scratch-unavailable$/u);
        assert.equal(
            refused.problem?.detail,
            `The execution scratch directory \`${occupied}\` named by PLURNK_SERVICE_EXEC_SCRATCH cannot be created or written (EEXIST), so the tool source \`source:///script\` cannot be realized.`,
        );
        assert.equal(
            refused.problem?.recovery,
            "The operator points PLURNK_SERVICE_EXEC_SCRATCH at a writable absolute directory the tool executor can also read; meanwhile, target a program file the executor can reach, or put the command beneath a tool heading with no target.",
        );
        assert.equal(refused.problem?.scratch, occupied);
        assert.equal(refused.problem?.configuration, "PLURNK_SERVICE_EXEC_SCRATCH");
        assert.equal(ctx.runs.length, 0, "nothing was realized or run");
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_SCRATCH;
        else process.env.PLURNK_SERVICE_EXEC_SCRATCH = previous;
        await ctx?.close();
        await rm(occupied, { force: true });
    }
});
});


describe("entry-owner", () => {
// {§execution-output-identity} {§execution-output-identity}













const execStmt = (runtime: string, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const streamRead = (scheme: string, hostname: string | null, pathname: string): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "url", raw: `${scheme}://${hostname ?? ""}${pathname}`, scheme, username: null, password: null, hostname, port: null, pathname, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

test("{§exec} fan-out: equal causal coordinates create distinct outputs shared by the workspace", async () => {
    const prior = process.env.PLURNK_SERVICE_EFFECT_HOST;
    process.env.PLURNK_SERVICE_EFFECT_HOST = "auto";
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors); // {§exec} — per-tag faces let READ js:// resolve
        const exec = schemes.get("exec") as Exec;
        assert.ok(schemes.get("js"));
        const ws = await insertWorkspace(db, `owner-fanout-${crypto.randomUUID()}`);

        const parent = await insertSession(db, ws, null, "parent");
        const host = await insertSession(db, ws, parent, "extract-host");
        const hLoop = await insertLoop(db, host, 1, "host");
        const hTurn = await insertTurn(db, hLoop, 1, 102);
        const pool = await insertSession(db, ws, parent, "extract-pool");
        const pLoop = await insertLoop(db, pool, 1, "pool");
        const pTurn = await insertTurn(db, pLoop, 1, 102);

        await engine.dispatch({ statement: execStmt("js", 'console.log("db.internal")'), workspaceId: ws, sessionId: host, loopId: hLoop, turnId: hTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: execStmt("js", "console.log(5)"), workspaceId: ws, sessionId: pool, loopId: pLoop, turnId: pTurn, sequence: 1, origin: "model" });
        await exec.idle();

        const hostPath = new URL(await executionAddress(db, hTurn)).pathname;
        const poolPath = new URL(await executionAddress(db, pTurn)).pathname;
        assert.notEqual(hostPath, poolPath, "independent executions never alias because their causal coordinates match");
        const read = async (sessionId: number, statement: ReadStatement): Promise<EntryReadResult> => {
            const result = await clientRead(engine, db, { statement, workspaceId: ws, sessionId });
            Results.assertReadResult(result);
            return result as EntryReadResult;
        };
        for (const sessionId of [host, pool, parent]) {
            const hostRead = await read(sessionId, streamRead("js", null, hostPath));
            const poolRead = await read(sessionId, streamRead("js", null, poolPath));
            assert.equal(hostRead.status, 200);
            assert.match(hostRead.content ?? "", /db\.internal/);
            assert.equal(poolRead.status, 200);
            assert.match(poolRead.content ?? "", /^5$/m);
        }
        await db.test_delete_session.run({ id: host });
        assert.match((await read(parent, streamRead("js", null, hostPath))).content ?? "", /db\.internal/,
            "deleting the producer leaves its workspace output readable");
        const foreignWorkspace = await insertWorkspace(db, "foreign-output");
        const foreignSession = await insertSession(db, foreignWorkspace);
        const foreign = await clientRead(engine, db, { statement: streamRead("js", null, hostPath),
            workspaceId: foreignWorkspace, sessionId: foreignSession });
        assert.equal(foreign.status, 404, "the same address does not cross workspace boundaries");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EFFECT_HOST;
        else process.env.PLURNK_SERVICE_EFFECT_HOST = prior;
        await db.close();
    }
});

test("{§execution-output-identity}: simultaneous claims retry collisions instead of reusing an output", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "output-collisions");
        const names = ["a1234567", "a1234567", "b2345678"];
        t.mock.method(ExecutionOutputs, "short", () => {
            const name = names.shift();
            assert.ok(name);
            return name;
        });
        const paths = await Promise.all([
            ExecutionOutputs.claim(db, workspaceId, "sh"),
            ExecutionOutputs.claim(db, workspaceId, "sh"),
        ]);
        assert.deepEqual(paths.toSorted(), ["/a1234567", "/b2345678"]);
    } finally { await db.close(); }
});

test("{§execution-output-identity} shared entries require only a workspace, not a synthetic Session", async () => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-commons-${crypto.randomUUID()}`);
        const row = await db.envelope_get_session_by_name.get<{ id: number }>({ workspace_id: ws, name: "commons" });
        assert.equal(row, undefined, "no synthetic commons Session is created");

        // The identity index holds ON the commons: a second insert at the same key conflicts —
        // the exact fragmentation a NULL owner would have allowed (NULLs are distinct under UNIQUE).
        await db.test_seed_entry_workspace.get({ workspace_id: ws, scheme: "js", authority: "", pathname: "/1/1/1/js" });
        await assert.rejects(
            db.test_seed_entry_workspace.get({ workspace_id: ws, scheme: "js", authority: "", pathname: "/1/1/1/js" }),
            /UNIQUE/,
            "the same (workspace, owner, scheme, authority, pathname) key conflicts — no silent duplicate",
        );
    } finally { await db.close(); }
});

test("{§execution-output-identity}: unnamed model sessions retry occupied names; explicit names retain their validation", async (t) => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-name-${crypto.randomUUID()}`);
        const names = ["ab3d5678", "ab3d5678", "bc4e6789", "cd5f7890", "de6a8901"];
        t.mock.method(SessionName, "short", () => {
            const name = names.shift();
            assert.ok(name !== undefined);
            return name;
        });
        const first = await Envelope.createModelSession(db, ws);
        assert.equal(first.name, "ab3d5678");
        const second = await Envelope.createModelSession(db, ws);
        assert.equal(second.name, "bc4e6789", "a generated name never reuses another session's identity");
        await Envelope.createModelSession(db, ws, "cd5f7890");
        const afterOccupiedLiteral = await Envelope.createModelSession(db, ws);
        assert.equal(afterOccupiedLiteral.name, "de6a8901", "explicit and generated names share the same namespace");

        assert.equal((await Envelope.createModelSession(db, ws, "commons")).name, "commons");
        await assert.rejects(Envelope.createModelSession(db, ws, "_plurnk"), SessionNameError, "the runtime actor's name is not mintable");
        assert.equal((await Envelope.createModelSession(db, ws, "plurnk")).name, "plurnk", "plurnk is an ordinary literal session name");
        await assert.rejects(Envelope.createModelSession(db, ws, "~"), SessionNameError, "tilde is not a session name");
        assert.equal((await Envelope.createModelSession(db, ws, "self")).name, "self", "self is an ordinary literal session name");
    } finally { await db.close(); }
});
});


describe("exec-tool-fall-through", () => {
// {§exec-target-routing} — a bare shell command whose program is the name of an enabled
// runtime's tool dies with the shell's exit 127; the failure receipt says so at the failure site
// and names the invocation the registry actually publishes, so recovery takes one turn.









test("{§exec-target-routing} {§diagnostic-observation} a bare execution of a tool's name fails with a receipt that names the tool and its document", { timeout: 60_000 }, async (t) => {
    serverProposals(t, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nfail {\"message\":\"boom\"}\n````\n\n````WAIT\nwaiting on the shell\n````", 10),
            makeMockResponse("````SEND [200]\nseen\n````", 10),
        ],
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tool-fall-through-${crypto.randomUUID()}` });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "try the tool by name" }, { timeoutMs: 30_000 });
            assert.equal(finalStatus, 200);
            // {§exec-stream}: the spawn's execution row is `started`; the process's conclusion is the receipt
            // on the stream's terminal READ — one per channel with content, and the shell's complaint is on stderr alone.
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const receipts = rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.equal(receipts.length, 1, "one terminal READ, on the channel that holds the shell's complaint");
            assert.deepEqual((JSON.parse(receipts[0].rx) as { channels?: unknown }).channels, { "#stdout": 0 }, "the empty stdout is a fact on that receipt");
            assert.equal(receipts[0].status_rx, 404, "the named program did not run");
            const receipt = JSON.parse(receipts[0].rx) as { exitCode?: number; problem?: { type?: string; detail?: string; recovery?: string; toolRuntimes?: string[]; tool?: string } };
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem?.type, "https://problems.plurnk.xyz/scheme/exec/program-is-a-tool");
            assert.equal(receipt.problem?.detail, "'sh' exited with code 127; `fail` is a registered tool of `fixture`."); // {§operation-results}
            assert.equal(
                receipt.problem?.recovery,
                "`fail`'s contract: workspace:///_plurnk/tools/fixture/fail.json.",
            );
            assert.deepEqual(receipt.problem?.toolRuntimes, ["fixture"]);
            assert.equal(receipt.problem?.tool, "fail");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§exec-target-routing} a program the registry does not know keeps the shell's own answer", { timeout: 60_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nno_such_program_zq --help\n````\n\n````WAIT\nwaiting\n````", 10),
            makeMockResponse("````SEND [200]\nseen\n````", 10),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `plain-127-${crypto.randomUUID()}` });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "run nothing" }, { timeoutMs: 30_000 });
            const terminal = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; status_rx: number; rx: string }>({ loop_id: loopId }))
                .find((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.ok(terminal);
            const receipt = JSON.parse(terminal.rx) as { exitCode?: number; problem?: unknown };
            assert.equal(terminal.status_rx, 200);
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem, undefined, "no tool is invented for a program the registry does not know");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("execs-batteries", () => {
// Batteries-included executor coverage — every executor the service-owned
// default executor extensions ship, driven end-to-end through the REAL Exec
// scheme (dispatch → run/accept → spawn → read
// the captured output channel), not sh alone.
//
// Two axes: each runtime's output lands on its OWN
// declared channel (subprocess -> stdout), and host-effecting
// runtimes PROPOSE (accept) while pure/read ones are automatically accepted. The census requires
// every available self-contained tag to be covered and fails when a default tag is undiscovered
// ({§exec-target-routing}).












// The host sets FORCE_COLOR; ANSI control bytes are the subject of this sanitizer.
// oxlint-disable-next-line eslint/no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// {§op-shapes} — the battery's third column is the program path, never a cwd.
const execStmt = (runtime: string, target: string | null, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: target === null ? null : localPath(target),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Drive one executor through the full Exec path and return its captured, ANSI-stripped output —
// from the executor's OWN default channel (subprocess runtimes → stdout) —
// plus the one effect fact that drove automatic admission or proposal review.
const runExec = async (tag: string, body: string, cwd: string | null): Promise<{ status: number; out: string; effect: Effect; mimetype: string; declaredMimetype: string | undefined }> => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        const entry = registry.entry(tag);
        assert.ok(entry?.available, `the ${tag} executor is available`);
        const channel = entry.executor.defaultChannel;
        const declaredMimetype = entry.executor.channels[channel]?.mimetype;
        const workspaceId = await insertWorkspace(db, `batt-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "batteries");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(tag, cwd, body),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // Side-effecting (host) executors propose; pure/read ones are automatically
        // accepted within dispatch. The persisted effect is the deterministic fact —
        // a row-state check races automatic settlement. Accept only a host proposal.
        const proposal = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const effect = (JSON.parse(proposal?.attrs ?? "{}") as { effect: Effect }).effect;
        assert.ok(effect === "pure" || effect === "read" || effect === "host", "execution persists its canonical effect fact");
        if (effect === "host") engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        await exec.idle(); // the spawn runs async; idle() awaits its close

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: tag, pathname });
        // idle() awaits the spawn promise, which drains the channel-write queue before resolving, so the
        // output is committed by here — for auto-accepted and proposed runtimes alike. No poll, no close-race.
        const out = entryRow
            ? await db.test_get_channel.get<{ content: string; state: string; mimetype: string }>({ entry_id: entryRow.id, name: channel })
            : undefined;
        assert.equal(out?.state, "closed", `${tag} output channel settled to closed by idle()`);
        return { status: result.status, out: stripAnsi(out?.content ?? ""), effect, mimetype: out?.mimetype ?? "", declaredMimetype };
    } finally {
        await db.close();
    }
};


// One deterministic specimen per bundled runtime. `gate` verifies its
// executor-owned effect fact through core admission. {§executor-results}
const CASES: ReadonlyArray<{ tag: string; body: string; cwd: string | null; expect: string; gate: "propose" | "auto" }> = [
    // Subprocess runtimes execute arbitrary host code → ALWAYS `host` → always gated, even for a
    // visibly-harmless command (the executor classifies the target, never parses the command to judge it).
    { tag: "python3", body: "print(sum(range(101)))", cwd: null, expect: "5050\n", gate: "propose" },
    { tag: "js", body: "console.log(6 * 7)", cwd: null, expect: "42\n", gate: "propose" },
];

// Self-contained batteries tags — runnable deterministically with no external resource. The census
// REQUIRES every one of these that the host probes available to be covered by this suite (sh is
// covered by Exec.scheme.test.ts).
const SELF_CONTAINED = ["sh", "js", "python3"] as const;

test("{§exec-target-routing} execs batteries: coverage census — every self-contained default-install tag is exercised", async () => {
    const reg = await testExecutors();
    const available = new Set(reg.availableRuntimes());
    const covered = new Set(CASES.map((c) => c.tag).concat("sh")); // sh: Exec.scheme.test.ts
    // {§exec-target-routing}: the registry retains probe-failed entries as unavailable; a missing
    // entry means the default composition deleted or renamed a package, not that this host lacks it.
    const undiscovered = SELF_CONTAINED.filter((t) => reg.entry(t) === undefined);
    assert.deepEqual(undiscovered, [], `census tags missing from the bundle entirely (deleted/renamed package?): ${undiscovered.join(", ")}`);
    const exercised = SELF_CONTAINED.filter((t) => available.has(t) && covered.has(t));
    const unavailable = SELF_CONTAINED.filter((t) => !available.has(t));
    const uncovered = SELF_CONTAINED.filter((t) => available.has(t) && !covered.has(t));
    console.log(`  self-contained, exercised: ${exercised.join(", ")}`);
    console.log(`  unavailable in this env: ${unavailable.join(", ") || "(none)"}`);
    assert.deepEqual(uncovered, [], `every AVAILABLE self-contained batteries tag must be covered — uncovered: ${uncovered.join(", ")}`);

    // Subprocess runtimes declare text/stream on stdout.
    const declMime = (tag: string): string | undefined => {
        const e = reg.entry(tag);
        return e?.executor?.channels[e.executor.defaultChannel]?.mimetype;
    };
    for (const t of ["js", "python3"]) assert.equal(declMime(t), "text/stream", `${t} stdout channel is text/stream`);
});

for (const { tag, body, cwd, expect, gate } of CASES) {
    const label = `${tag}${cwd === null ? "" : ` (${gate} target)`}`;
    test(`{§executor-role} execs batteries: ${label} runs through the real Exec scheme, captures output, gates per effect`, async (t) => {
        const reg = await testExecutors();
        if (!reg.availableRuntimes().includes(tag)) {
            t.skip(`${tag} not available in this env (probe failed / resource-gated)`);
            return;
        }
        const { status, out, effect, mimetype, declaredMimetype } = await runExec(tag, body, cwd);
        assert.equal(status, 200, `${label} dispatch returns 200`);
        assert.equal(out, expect, `${label} output`);
        // The stream entry's channel carries the executor's OWN declared mimetype.
        // The Exec seed honors the declaration; the write never overwrites it.
        assert.equal(mimetype, declaredMimetype, `${label} channel carries the executor's declared mimetype`);
        // The security boundary: effect→gate must match. A host runtime MUST propose (be review-gated);
        // a pure/read one MUST auto-run. A regression that automatically admits
        // a host runtime would let arbitrary host code run ungated.
        assert.equal(effect === "host" ? "propose" : "auto", gate, `${label} effect drives the expected proposal policy`);
    });
}

test("{§op-shapes} an unregistered executable tag fails without shell reinterpretation", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        assert.ok(!registry.availableRuntimes().includes("echo"), "precondition: echo is NOT a registered runtime");
        const workspaceId = await insertWorkspace(db, `batt-ft-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "ft");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: execStmt("echo", null, "hello fallthrough"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        // {§op-shapes} — an unregistered executor name is refused as such, never reinterpreted
        // as a shell command word; the refusal lists what is registered.
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");
        assert.equal(result.problem?.requestedRuntime, "echo");
        assert.deepEqual(result.problem?.executors, registry.availableRuntimes(), "the refusal lists the registered executors");
        assert.equal(result.problem?.toolRuntimes, undefined, "an arbitrary unknown word names no tool runtime");
        const shell = await engine.dispatch({
            statement: execStmt("shell", null, "printf hello"),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(shell.status, 400);
        assert.equal(shell.problem?.requestedRuntime, "shell", "an unknown alias does not trigger an intent-presuming correction");
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname: "/1/1/1/sh" });
        assert.equal(entryRow, undefined, "an unknown tag never spawns or creates a shell stream");
    } finally { await db.close(); }
});
});

