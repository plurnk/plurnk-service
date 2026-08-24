import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { parsePath } from "@plurnk/plurnk-contracts";
import type { ExecStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { Effect } from "@plurnk/plurnk-execs";
import type {
    RepresentationPreparationRequest,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
} from "@plurnk/plurnk-schemes";
import { OutputScheme } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import type { WakeWorkerPayload } from "../../src/core/ChannelWrite.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Results from "../../src/core/results.ts";
import Exec from "../../src/schemes/Exec.ts";
import {
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
    schemeManifest,
    seedEntryWithChannel,
} from "./_helpers.ts";

type Actor = {
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    sequence: number;
};

type Run = {
    readonly body: string;
    readonly target: string | null;
    readonly materialized?: string;
};

const urlTarget = (raw: string): UrlPath => {
    const target = parsePath(raw);
    if (target?.kind !== "url") throw new Error(`Expected a URL target: ${raw}`);
    return target;
};

const execStatement = (target: string, body: string): ExecStatement => ({
    op: "EXEC",
    annotation: null,
    delimiter: "",
    signal: "tool",
    target: urlTarget(target),
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

const wire = async (): Promise<{
    readonly db: Awaited<ReturnType<typeof openMigrated>>;
    readonly engine: Engine;
    readonly exec: Exec;
    readonly schemes: SchemeRegistry;
    readonly workspaceId: number;
    readonly root: Actor;
    readonly runs: Run[];
    readonly wakes: WakeWorkerPayload[];
    actor(parentWorkerId: number | null, name: string): Promise<Actor>;
    dispatch(actor: Actor, target: string, body?: string): Promise<Awaited<ReturnType<Engine["dispatch"]>>>;
    close(): Promise<void>;
}> => {
    const runs: Run[] = [];
    const wakes: WakeWorkerPayload[] = [];
    const executor: Executor = {
        runtime: "tool",
        glyph: "🔧",
        get manifest(): SchemeManifest { return runtimeManifest("tool"); },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "text/plain" } }; },
        async run({ body, target, setState }) {
            runs.push({
                body,
                target,
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
        wakeWorkerNotify: (payload) => { wakes.push(payload); },
    });
    engine.setExecutors(executors);
    const workspaceId = await insertWorkspace(db, `exec-source-${crypto.randomUUID()}`);
    const makeActor = async (parentWorkerId: number | null, name: string): Promise<Actor> => {
        const workerId = await insertWorker(db, workspaceId, parentWorkerId, name);
        const loopId = await insertLoop(db, workerId, 1, `${name} source test`);
        const turnId = await insertTurn(db, loopId, 1, 102);
        return { workerId, loopId, turnId, sequence: 0 };
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
        async dispatch(actor, target, body = "") {
            const result = await engine.dispatch({
                statement: execStatement(target, body),
                workspaceId,
                workerId: actor.workerId,
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

// {§exec-target-routing} {§exec-source-temporary} A scheme-backed EXEC source
// is one exact ordinary READ and always uses a spawn-scoped temporary.
test("EXEC source READ preserves the complete authored scheme address (#163)", async () => {
    const ctx = await wire();
    const seen: RepresentationPreparationRequest[] = [];
    const completeSource = Array.from({ length: 20 }, (_, index) => `source line ${index + 1}`).join("\n");
    const raw = "source://alice:secret@example.test:8443/items/path?b=2&a=1&a=3#payload{Accept: text/plain}{X-Trace: one:two}";
    try {
        ctx.schemes.register("source", {
            manifest: schemeManifest("source", { payload: "text/plain" }, "payload"),
            async prepareRepresentation(request, schemeCtx) {
                seen.push(structuredClone(request));
                return materializeSource(request, schemeCtx, completeSource, "payload");
            },
        } satisfies SchemeHandler);

        const result = await ctx.dispatch(ctx.root, raw, "transform");

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
        assert.deepEqual(preparedTarget.headers, [["Accept", "text/plain"], ["X-Trace", "one:two"]]);
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

test("{§exec-source-temporary} independent spawns never reuse one temporary identity", async () => {
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

test("{§exec-source-temporary} cleanup failure preserves the settled result and complete diagnostic cause", async (t) => {
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
        assert.match(String(diagnostics[0]?.[0]), /EXEC source temporary cleanup failed/);
        const cause = diagnostics[0]?.[1];
        assert.ok(cause instanceof Error);
        assert.equal("path" in cause ? cause.path : undefined, tempPath);
        assert.ok("code" in cause && (cause.code === "EISDIR" || cause.code === "EPERM"));
    } finally {
        if (tempPath !== null) await rm(tempPath, { recursive: true, force: true });
        await ctx.close();
    }
});

test("EXEC source READ preserves worker commons, current, named, and ancestry boundaries (#163)", async () => {
    const ctx = await wire();
    try {
        const child = await ctx.actor(ctx.root.workerId, "child");
        const sibling = await ctx.actor(ctx.root.workerId, "sibling");
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "worker",
            pathname: "/script",
            content: "commons command",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            ownerId: ctx.root.workerId,
            scheme: "worker",
            pathname: "/script",
            content: "root command",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            ownerId: child.workerId,
            scheme: "worker",
            pathname: "/script",
            content: "child command",
        });

        const commonsRead = await ctx.dispatch(ctx.root, "worker:///script#body");
        assert.equal(commonsRead.status, 200, JSON.stringify(commonsRead));
        assert.equal((await ctx.dispatch(ctx.root, "worker://~/script#body")).status, 200);
        assert.equal((await ctx.dispatch(ctx.root, "worker://child/script#body")).status, 200);
        assert.deepEqual(ctx.runs.map(({ body }) => body), ["", "", ""]);
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), [
            "commons command",
            "root command",
            "child command",
        ]);

        const forbidden = await ctx.dispatch(sibling, "worker://child/script#body");
        assert.equal(forbidden.status, 404);
        assert.equal(forbidden.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-not-found");
        const unknown = await ctx.dispatch(ctx.root, "worker://unknown/script#body");
        assert.equal(unknown.status, 404);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/scheme/worker/worker-not-found");
        assert.equal(ctx.runs.length, 3, "failed source resolution never invokes the executor");
    } finally {
        await ctx.close();
    }
});

test("EXEC source READ preserves current and named runtime-stream ownership (#163)", async () => {
    const ctx = await wire();
    try {
        const child = await ctx.actor(ctx.root.workerId, "child");
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            ownerId: ctx.root.workerId,
            scheme: "tool",
            pathname: "/9/8/7",
            channel: "results",
            content: "root stream command",
            state: "closed",
        });
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            ownerId: child.workerId,
            scheme: "tool",
            pathname: "/9/8/7",
            channel: "results",
            content: "child stream command",
            state: "closed",
        });

        assert.equal((await ctx.dispatch(ctx.root, "tool:///9/8/7#results")).status, 200);
        assert.equal((await ctx.dispatch(ctx.root, "tool://child/9/8/7#results")).status, 200);
        assert.deepEqual(ctx.runs.map(({ body }) => body), ["", ""]);
        assert.deepEqual(ctx.runs.map(({ materialized }) => materialized), [
            "root stream command",
            "child stream command",
        ]);
    } finally {
        await ctx.close();
    }
});

test("EXEC source eligibility and failures come from the owning READ contract (#163)", async () => {
    const ctx = await wire();
    let loggingPreparationCalled = false;
    try {
        const { entryOwner: _entryOwner, inherit: _inherit, ...auditManifest } = schemeManifest("audit");
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

        const unknown = await ctx.dispatch(ctx.root, "unknown:///item");
        assert.equal(unknown.status, 501);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-not-found");

        const absent = await ctx.dispatch(ctx.root, "absent:///item");
        assert.equal(absent.status, 404);
        assert.equal(absent.problem?.type, "https://problems.plurnk.xyz/scheme/absent/representation-not-found");

        const failing = await ctx.dispatch(ctx.root, "failing:///item");
        assert.equal(failing.status, 409);
        assert.equal(failing.problem?.type, "https://problems.plurnk.xyz/scheme/failing/source-refused");
        assert.equal(failing.problem?.detail, "The source owner refused this representation.");
        assert.equal(ctx.runs.length, 0);
    } finally {
        await ctx.close();
    }
});
