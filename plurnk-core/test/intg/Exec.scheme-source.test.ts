import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePath } from "@plurnk/plurnk-contracts";
import type { ExecStatement, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { Effect } from "@plurnk/plurnk-execs";
import type { SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
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
    readonly command: string;
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
    suffix: "",
    signal: "tool",
    target: urlTarget(target),
    lineMarker: null,
    body,
    position: { line: 1, column: 0 },
});

const runtimeManifest = (name: string): SchemeManifest => ({
    ...schemeManifest(name, { results: "text/plain" }, "results"),
    scope: "worker",
    volatile: true,
    foldedByDefault: true,
});

const wire = async (): Promise<{
    readonly db: Awaited<ReturnType<typeof openMigrated>>;
    readonly engine: Engine;
    readonly exec: Exec;
    readonly schemes: SchemeRegistry;
    readonly workspaceId: number;
    readonly root: Actor;
    readonly runs: Run[];
    actor(parentWorkerId: number | null, name: string): Promise<Actor>;
    dispatch(actor: Actor, target: string, body?: string): Promise<Awaited<ReturnType<Engine["dispatch"]>>>;
    close(): Promise<void>;
}> => {
    const runs: Run[] = [];
    const executor: Executor = {
        runtime: "tool",
        glyph: "🔧",
        get manifest(): SchemeManifest { return runtimeManifest("tool"); },
        get defaultChannel(): string { return "results"; },
        get channels() { return { results: { mimetype: "text/plain" } }; },
        async run({ command, target, setState }) {
            runs.push({
                command,
                target,
                ...(target === null ? {} : { materialized: await readFile(target, "utf8") }),
            });
            setState("results", "closed");
            return { status: 200 };
        },
        async probe() { return { available: true }; },
        effect(target: string | null): Effect { return target === null ? "pure" : "read"; },
    };
    const executors = new ExecutorRegistry(new Map([
        ["tool", { executor, glyph: "🔧", example: "", documentation: "", available: true, detail: undefined }],
    ]));
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.registerRuntimeSchemes(executors);
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
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

// {§exec-target-routing} A scheme-backed EXEC source is one exact ordinary READ.
test("EXEC source READ preserves the complete authored scheme address (#163)", async () => {
    const ctx = await wire();
    const seen: ReadStatement[] = [];
    const raw = "source://alice:secret@example.test:8443/items/path?b=2&a=1&a=3#payload{Accept: text/plain}{X-Trace: one:two}";
    try {
        ctx.schemes.register("source", {
            manifest: schemeManifest("source", { payload: "text/plain" }, "payload"),
            async read(statement: ReadStatement) {
                seen.push(statement);
                return { status: 200, content: "complete identity", mimetype: "text/plain", channel: "payload" };
            },
        } satisfies SchemeHandler);

        const result = await ctx.dispatch(ctx.root, raw, "transform");

        assert.equal(result.status, 200);
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0], {
            op: "READ",
            suffix: "",
            signal: null,
            target: urlTarget(raw),
            lineMarker: null,
            body: null,
            position: { line: 0, column: 0 },
        });
        assert.deepEqual(ctx.runs.map(({ command, materialized }) => ({ command, materialized })), [
            { command: "transform", materialized: "complete identity" },
        ]);
    } finally {
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

        assert.equal((await ctx.dispatch(ctx.root, "worker:///script#body")).status, 200);
        assert.equal((await ctx.dispatch(ctx.root, "worker://~/script#body")).status, 200);
        assert.equal((await ctx.dispatch(ctx.root, "worker://child/script#body")).status, 200);
        assert.deepEqual(ctx.runs.map(({ command }) => command), [
            "commons command",
            "root command",
            "child command",
        ]);

        const forbidden = await ctx.dispatch(sibling, "worker://child/script#body");
        assert.equal(forbidden.status, 404);
        assert.equal(forbidden.problem?.type, "https://problems.plurnk.dev/scheme/worker/worker-not-found");
        const unknown = await ctx.dispatch(ctx.root, "worker://unknown/script#body");
        assert.equal(unknown.status, 404);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.dev/scheme/worker/worker-not-found");
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
        assert.deepEqual(ctx.runs.map(({ command }) => command), [
            "root stream command",
            "child stream command",
        ]);
    } finally {
        await ctx.close();
    }
});

test("EXEC source eligibility and failures come from the owning READ contract (#163)", async () => {
    const ctx = await wire();
    let loggingReadCalled = false;
    try {
        ctx.schemes.register("audit", {
            manifest: { ...schemeManifest("audit"), category: "logging" },
            async read() {
                loggingReadCalled = true;
                return { status: 200, content: "must not execute", mimetype: "text/plain", channel: "body" };
            },
        } satisfies SchemeHandler);
        ctx.schemes.register("writeonly", {
            manifest: schemeManifest("writeonly"),
        } satisfies SchemeHandler);
        ctx.schemes.register("absent", {
            manifest: schemeManifest("absent"),
            async read() {
                return { status: 204 };
            },
        } satisfies SchemeHandler);
        ctx.schemes.register("failing", {
            manifest: schemeManifest("failing"),
            async read() {
                return Results.failure(
                    "scheme:failing",
                    "source-refused",
                    409,
                    "The source owner refused this representation.",
                    { content: null, mimetype: null, channel: null },
                    { retryable: false },
                );
            },
        } satisfies SchemeHandler);

        const logging = await ctx.dispatch(ctx.root, "audit:///event");
        assert.equal(logging.status, 501);
        assert.equal(logging.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/exec-source-not-data");
        assert.equal(loggingReadCalled, false);

        const writeonly = await ctx.dispatch(ctx.root, "writeonly:///item");
        assert.equal(writeonly.status, 501);
        assert.equal(writeonly.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/operation-not-implemented");

        const unknown = await ctx.dispatch(ctx.root, "unknown:///item");
        assert.equal(unknown.status, 501);
        assert.equal(unknown.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/scheme-not-found");

        const absent = await ctx.dispatch(ctx.root, "absent:///item");
        assert.equal(absent.status, 422);
        assert.equal(absent.problem?.type, "https://problems.plurnk.dev/scheme/exec/source-content-unavailable");

        const failing = await ctx.dispatch(ctx.root, "failing:///item");
        assert.equal(failing.status, 409);
        assert.equal(failing.problem?.type, "https://problems.plurnk.dev/scheme/failing/source-refused");
        assert.equal(failing.problem?.detail, "The source owner refused this representation.");
        assert.equal(ctx.runs.length, 0);
    } finally {
        await ctx.close();
    }
});
