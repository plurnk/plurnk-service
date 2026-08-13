import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePath, type ExecStatement } from "@plurnk/plurnk-contracts";
import type { ExecArgs, RuntimeInvocationDecl } from "@plurnk/plurnk-execs";
import Engine from "../../src/core/Engine.ts";
import ExecutorRegistry, { type Executor } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { SchemeManifest } from "../../src/core/types.ts";
import Exec from "../../src/schemes/Exec.ts";
import {
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
    rootWorkspace,
    schemeManifest,
    seedEntryWithChannel,
} from "./_helpers.ts";

interface Run {
    readonly body: string;
    readonly cwd: string | null;
    readonly target: string | null;
    readonly materialized?: string;
}

const INVOCATIONS: Readonly<Record<string, RuntimeInvocationDecl>> = {
    literaltool: {
        body: { role: "JSON arguments", required: false },
        target: { role: "tool", required: true, kind: "literal" },
    },
    bodyonly: {
        body: { role: "query", required: true },
    },
    pathtool: {
        body: { role: "operation", required: true },
        target: { role: "database", required: false, kind: "path" },
    },
    resourcetool: {
        body: { role: "filter", required: false },
        target: { role: "input", required: false, kind: "resource" },
    },
    exclusivetool: {
        body: { role: "inline module", required: false },
        target: { role: "module", required: false, kind: "resource" },
        exclusive: true,
    },
};

const statement = (runtime: string, target: string | null, body: string): ExecStatement => ({
    op: "EXEC",
    suffix: "",
    signal: runtime,
    target: target === null ? null : parsePath(target),
    lineMarker: null,
    body,
    position: { line: 1, column: 1 },
});

const wire = async () => {
    const runs = new Map<string, Run[]>();
    const effects = new Map<string, Array<string | null>>();
    const entries = new Map([...Object.entries(INVOCATIONS)].map(([runtime, invocation]) => {
        const executor: Executor = {
            runtime,
            glyph: "?",
            get manifest(): SchemeManifest {
                return { ...schemeManifest(runtime, { results: "text/plain" }, "results"), volatile: true };
            },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/plain" } }; },
            async run(args: ExecArgs) {
                const materialized = runtime === "resourcetool" && args.target !== null
                    ? await readFile(args.target, "utf8")
                    : undefined;
                const runtimeRuns = runs.get(runtime) ?? [];
                runtimeRuns.push({
                    body: args.body,
                    cwd: args.cwd,
                    target: args.target,
                    ...(materialized === undefined ? {} : { materialized }),
                });
                runs.set(runtime, runtimeRuns);
                args.setState("results", "closed");
                return { status: 200 };
            },
            async probe() { return { available: true }; },
            effect(target) {
                const runtimeEffects = effects.get(runtime) ?? [];
                runtimeEffects.push(target);
                effects.set(runtime, runtimeEffects);
                return "pure";
            },
        };
        return [runtime, {
            executor,
            namespaceOwner: { kind: "module" as const, name: `${runtime} fixture` },
            glyph: "?",
            invocation,
            documentation: "",
            available: true,
            detail: undefined,
        }] as const;
    }));
    const executors = new ExecutorRegistry(entries);
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.registerRuntimeSchemes(executors);
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(executors);
    const workspaceId = await insertWorkspace(db, `exec-invocation-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "invocation contract");
    const turnId = await insertTurn(db, loopId, 1, 102);
    let sequence = 0;
    return {
        db,
        runs,
        effects,
        workspaceId,
        async dispatch(execStatement: ExecStatement) {
            const result = await engine.dispatch({
                statement: execStatement,
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: ++sequence,
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

test("{§exec-target-routing} literal targets survive directory collisions without filesystem interpretation", async () => {
    const ctx = await wire();
    const root = await mkdtemp(join(tmpdir(), "exec-literal-"));
    try {
        await mkdir(join(root, "tool_name"));
        await rootWorkspace(ctx.db, ctx.workspaceId, root);
        const result = await ctx.dispatch(statement("literaltool", "tool_name", "{}"));
        assert.equal(result.status, 200);
        assert.deepEqual(ctx.runs.get("literaltool"), [{ body: "{}", cwd: root, target: "tool_name" }]);
        assert.deepEqual(ctx.effects.get("literaltool"), ["tool_name"]);
    } finally {
        await ctx.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§executor-invocation} required and unsupported buckets are refused before execution", async () => {
    const ctx = await wire();
    try {
        const missingTarget = await ctx.dispatch(statement("literaltool", null, "{}"));
        assert.equal(missingTarget.status, 400);
        assert.match(missingTarget.problem?.type ?? "", /target-required$/);

        const unsupportedTarget = await ctx.dispatch(statement("bodyonly", "anything", "query"));
        assert.equal(unsupportedTarget.status, 400);
        assert.match(unsupportedTarget.problem?.type ?? "", /target-not-supported$/);

        const missingBody = await ctx.dispatch(statement("bodyonly", null, ""));
        assert.equal(missingBody.status, 400);
        assert.match(missingBody.problem?.type ?? "", /body-required$/);
        assert.equal(ctx.runs.has("literaltool"), false);
        assert.equal(ctx.runs.has("bodyonly"), false);
    } finally {
        await ctx.close();
    }
});

test("{§exec-target-routing} path targets remain targets and refuse non-file addresses", async () => {
    const ctx = await wire();
    const root = await mkdtemp(join(tmpdir(), "exec-path-"));
    try {
        await mkdir(join(root, "database"));
        await rootWorkspace(ctx.db, ctx.workspaceId, root);
        const local = await ctx.dispatch(statement("pathtool", "database", "inspect"));
        assert.equal(local.status, 200);
        assert.deepEqual(ctx.runs.get("pathtool"), [{ body: "inspect", cwd: root, target: "database" }]);

        const addressed = await ctx.dispatch(statement("pathtool", "worker:///source", "inspect"));
        assert.equal(addressed.status, 400);
        assert.match(addressed.problem?.type ?? "", /target-kind-invalid$/);
        assert.equal(ctx.runs.get("pathtool")?.length, 1);
    } finally {
        await ctx.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§exec-source-temporary} a resource target is always a target, including with an empty body", async () => {
    const ctx = await wire();
    try {
        await seedEntryWithChannel(ctx.db, {
            workspaceId: ctx.workspaceId,
            scheme: "worker",
            pathname: "/source",
            channel: "body",
            content: "resource bytes",
            state: "static",
        });
        const result = await ctx.dispatch(statement("resourcetool", "worker:///source#body", ""));
        assert.equal(result.status, 200);
        const [run] = ctx.runs.get("resourcetool") ?? [];
        assert.equal(run?.body, "");
        assert.ok(run?.target?.startsWith(tmpdir()));
        assert.equal(run?.materialized, "resource bytes");
        assert.deepEqual(ctx.effects.get("resourcetool"), ["worker:///source#body"]);
    } finally {
        await ctx.close();
    }
});

test("{§executor-invocation} an exclusive runtime refuses body plus target", async () => {
    const ctx = await wire();
    try {
        const result = await ctx.dispatch(statement("exclusivetool", "module.wat", "(module)"));
        assert.equal(result.status, 400);
        assert.match(result.problem?.type ?? "", /input-conflict$/);
        assert.equal(ctx.runs.has("exclusivetool"), false);
        assert.equal(ctx.effects.has("exclusivetool"), false);
    } finally {
        await ctx.close();
    }
});
