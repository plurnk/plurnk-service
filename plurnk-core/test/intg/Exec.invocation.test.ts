import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePath, type ExecStatement } from "@plurnk/plurnk-contracts";
import { Results, type ExecArgs, type ExecInput, type RuntimeInvocationDecl } from "@plurnk/plurnk-execs";
import { InvalidOperationResultError } from "@plurnk/plurnk-schemes";
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
    readonly metadata?: readonly string[];
    readonly materialized?: string;
}

const INVOCATIONS: Readonly<Record<string, RuntimeInvocationDecl>> = {
    literaltool: {
        body: { role: "JSON arguments", required: false },
        target: { role: "tool", required: true, kind: "literal" },
        example: { target: "fixture_tool", body: "{}" },
    },
    familytool: {
        body: { role: "JSON arguments", required: false },
        target: { role: "registered tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    },
    bodyonly: {
        body: { role: "query", required: true },
        example: { body: "fixture query" },
    },
    pathtool: {
        body: { role: "operation", required: true },
        target: { role: "database", required: false, kind: "path" },
        example: { body: "inspect" },
    },
    resourcetool: {
        body: { role: "filter", required: false },
        target: { role: "input", required: false, kind: "resource" },
        example: { body: "inspect" },
    },
    exclusivetool: {
        body: { role: "inline query", required: false },
        target: { role: "query file", required: false, kind: "resource" },
        exclusive: true,
        example: { body: "SELECT 1" },
    },
};

const statement = (runtime: string, target: string | null, body: string): ExecStatement => ({
    metadata: null,
    op: "EXEC",
    aside: null,
    executor: runtime, target: target === null ? null : parsePath(target),
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
                    ...(args.metadata == null ? {} : { metadata: args.metadata }),
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
            ...(runtime === "literaltool" ? {
                async prepare(input: ExecInput) {
                    if (input.metadata?.includes("refuse")) {
                        return Results.failure("executor:fixture", "invalid-option", 400, "Fixture option was rejected.");
                    }
                    if (input.metadata?.includes("broken")) return { status: 200 };
                    return { status: 200, cwd: input.cwd };
                },
            } : {}),
            ...(runtime === "familytool"
                ? {
                    toolRegistry() {
                        return {
                            tools: [{
                                target: "enabled_tool",
                                summary: "Use the enabled fixture tool.",
                                invocation: {
                                    body: { role: "required JSON arguments", required: true },
                                    target: { role: "Enabled fixture tool", required: true, kind: "literal" as const },
                                    signature: '{"value": string}',
                                },
                            }],
                        };
                    },
                }
                : {}),
        };
        return [runtime, {
            executor,
            namespaceOwner: { kind: "module" as const, name: `${runtime} fixture` },
            glyph: "?",
            summary: `${runtime} fixture.`,
            invocation,
            details: "",
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
        engine,
        runs,
        effects,
        workspaceId,
        workerId,
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

test("{§executor-tool-registry} exact tools own admission and their invocation contract", async () => {
    const ctx = await wire();
    try {
        const reference = await ctx.engine.referenceEntries(ctx.workspaceId);
        const familyDoc = reference.find((doc) => doc.pathname === "/_plurnk/plurnk/familytool.md");
        assert.match(familyDoc?.content ?? "", /```familytool \(enabled_tool\)/, "the family document carries every registered target");
        assert.equal(
            reference.some((doc) => doc.pathname.startsWith("/_plurnk/plurnk/familytool/")),
            false,
            "per-target child documents do not exist (#336)",
        );
        const missing = await ctx.dispatch(statement("familytool", null, "{}"));
        assert.equal(missing.status, 400);
        assert.match(missing.problem?.type ?? "", /target-required$/);

        const disabled = await ctx.dispatch(statement("familytool", "disabled_tool", "{}"));
        assert.equal(disabled.status, 404);
        assert.match(disabled.problem?.type ?? "", /target-not-registered$/);
        assert.equal(disabled.problem?.availableTargetCount, 1);
        assert.equal(disabled.problem?.recovery, "Select a target documented under worker:///_plurnk/tools/familytool/.");
        assert.equal("availableTargets" in (disabled.problem ?? {}), false);

        const missingBody = await ctx.dispatch(statement("familytool", "enabled_tool", ""));
        assert.equal(missingBody.status, 400);
        assert.match(missingBody.problem?.type ?? "", /body-required$/);
        assert.equal(ctx.effects.has("familytool"), false);

        const accepted = await ctx.dispatch(statement("familytool", "enabled_tool", '{"value":"ok"}'));
        assert.equal(accepted.status, 200);
        assert.deepEqual(ctx.runs.get("familytool"), [{
            body: '{"value":"ok"}',
            cwd: process.cwd(),
            target: "enabled_tool",
        }]);
        assert.deepEqual(ctx.effects.get("familytool"), ["enabled_tool"]);
    } finally {
        await ctx.close();
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
        const result = await ctx.dispatch(statement("exclusivetool", "query.sql", "SELECT 1"));
        assert.equal(result.status, 400);
        assert.match(result.problem?.type ?? "", /input-conflict$/);
        assert.equal(ctx.runs.has("exclusivetool"), false);
        assert.equal(ctx.effects.has("exclusivetool"), false);
    } finally {
        await ctx.close();
    }
});

test("{§executor-metadata} a tool owns opaque options even when its literal target looks like another scheme", async () => {
    const ctx = await wire();
    try {
        const request = {
            ...statement("literaltool", "unregistered://literal/tool", "raw body"),
            metadata: [" custom syntax ", "args=not a subprocess argument vector"],
        };
        const accepted = await ctx.dispatch(request);
        assert.equal(accepted.status, 200, JSON.stringify(accepted));
        assert.deepEqual(ctx.runs.get("literaltool"), [{
            body: "raw body", cwd: process.cwd(), target: "unregistered://literal/tool", metadata: request.metadata,
        }]);
        assert.deepEqual(ctx.effects.get("literaltool"), ["unregistered://literal/tool"]);
    } finally {
        await ctx.close();
    }
});

test("{§executor-metadata} absent and rejecting preparation refuse options before effect admission", async () => {
    const ctx = await wire();
    try {
        const unsupported = { ...statement("bodyonly", null, "query"), metadata: ["option"] };
        const rejected = await ctx.dispatch(unsupported);
        assert.equal(rejected.status, 400);
        assert.match(rejected.problem?.type ?? "", /metadata-unsupported$/);
        const refused = await ctx.dispatch({ ...statement("literaltool", "tool", ""), metadata: ["refuse"] });
        assert.equal(refused.status, 400);
        assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/executor/fixture/invalid-option");
        assert.equal(refused.problem?.detail, "Fixture option was rejected.");
        assert.equal(ctx.effects.size, 0);
        assert.equal(ctx.runs.size, 0);
    } finally {
        await ctx.close();
    }
});

test("{§executor-metadata} a malformed preparation is an internal failure before execution", async () => {
    const ctx = await wire();
    try {
        await assert.rejects(
            ctx.dispatch({ ...statement("literaltool", "tool", ""), metadata: ["broken"] }),
            (cause: unknown) => cause instanceof InvalidOperationResultError
                && /invalid invocation preparation/.test(cause.message),
        );
        assert.equal(ctx.effects.size, 0);
        assert.equal(ctx.runs.size, 0);
    } finally {
        await ctx.close();
    }
});
