import test, { describe } from "node:test";
import assert from "node:assert/strict";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Daemon from "../../src/server/Daemon.ts";
import SessionModels from "../../src/server/SessionModels.ts";
import { serverProposals } from "./_approval.ts";
import { Mock, ProviderError, type ProviderAlias, type ProviderSpec } from "@plurnk/plurnk-providers";
import { type Effort } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../../src/core/results.ts";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated } from "./_db.ts";
import { connect, rpcCall, runLoopToTerminal, waitForDb, withDaemon } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";

describe("Daemon.session-model", () => {
const declaredProviderEnv = new Map<string, string | undefined>();
test.afterEach(() => {
    for (const [key, value] of declaredProviderEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    declaredProviderEnv.clear();
});

const declaredProvider = (name: string, model: string): ProviderAlias => {
    const spec = {
        alias: `${name}-${crypto.randomUUID()}`,
        provider: "openai",
        model,
    };
    const key = `PLURNK_MODEL_${spec.alias}`;
    declaredProviderEnv.set(key, process.env[key]);
    process.env[key] = `${spec.provider}/${spec.model}`;
    return spec;
};

type SessionRow = { id: number; name: string; model_route_id: number | null; spawn_model_route_id: number | null; effort: Effort | null };
type LoopRow = { id: number; session_id: number; model_route_id: number | null; spawn_model_route_id: number | null; effort: Effort | null; status: number };

const routeSpec = async (db: Db, routeId: number | null): Promise<ProviderSpec | null> => {
    if (routeId === null) return null;
    const row = await db.model_route_by_id.get<{ alias: string | null; provider: string; model: string; base_url: string | null }>({ id: routeId });
    if (row === undefined) throw new Error(`model_route ${routeId} is missing`);
    return {
        provider: row.provider,
        model: row.model,
        ...(row.alias === null ? {} : { alias: row.alias }),
        ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
    };
};

test("{§session-model-selection}: the configured default is selected on first use without a boot provider", async () => {
    const spec = declaredProvider("lazy", "lazy-model");
    declaredProviderEnv.set("PLURNK_MODEL", process.env.PLURNK_MODEL);
    process.env.PLURNK_MODEL = spec.alias;
    const mock = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("await plurnk.done({\"text\":\"ready\"});")] });
    ProviderInstantiate.registerInstance(mock, spec);
    await withDaemon(null, async (_db, daemon, addr) => {
        assert.equal(daemon.provider, null, "no process-wide model was constructed");
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "lazy-default" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "use the selected default" });
            assert.equal(result.finalStatus, 200);
            assert.equal(mock.remaining, 0, "the default was actually used, not substituted or left unconfigured");
        } finally { ws.close(); }
    });
});

test("{§acp-status-descendants}: each alias lists the route a session seeded from it reads back, its configured effort included", async () => {
    const spec = declaredProvider("listed", "listed-model");
    const effortKey = `PLURNK_PROVIDERS_EFFORT_${spec.alias}`;
    for (const key of ["PLURNK_MODEL", effortKey]) declaredProviderEnv.set(key, process.env[key]);
    process.env.PLURNK_MODEL = spec.alias;
    process.env[effortKey] = "high";
    ProviderInstantiate.registerInstance(new Mock({ contextWindow: 16_384, responses: [] }), spec);
    await withDaemon(null, async (_db, daemon) => {
        const listed = daemon.listProviders().aliases.find(({ alias }) => alias === spec.alias);
        assert.ok(listed?.active, "the standing selection is listed active");
        const { active: _active, inputCapacity: _capacity, ...route } = listed;
        assert.deepEqual(route, { alias: spec.alias, provider: "openai", model: "listed-model", effort: "high", effortSource: "default" },
            "the alias's own effort, given rather than chosen");
        const { workspaceId } = await daemon.createWorkspace({ name: "listed-route" });
        const sessionId = await namedModelSession(daemon, workspaceId, "seeded");
        await daemon.readSessionEffort({ workspaceId, sessionId });
        assert.deepEqual((await daemon.readSessionModel({ workspaceId, sessionId })).model, route,
            "a session seeded from the alias reads back exactly the listed route");
    });
});

test("{§configuration-repair-path}: an invalid default leaves client inspection and explicit model repair available", async () => {
    const spec = declaredProvider("repair", "repair-model");
    declaredProviderEnv.set("PLURNK_MODEL", process.env.PLURNK_MODEL);
    process.env.PLURNK_MODEL = "missing-default";
    const mock = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("await plurnk.done({\"text\":\"repaired\"});")] });
    ProviderInstantiate.registerInstance(mock, spec);
    await withDaemon(null, async (db, daemon, addr) => {
        assert.ok(daemon.listProviders().aliases.some(({ alias }) => alias === spec.alias));
        const ws = await connect(addr);
        try {
            const workspace = await rpcCall(ws, 1, "workspace.create", { name: "repair-default" });
            assert.ok(workspace.result);
            const rejected = await rpcCall(ws, 2, "loop.run", { prompt: "do not guess a model" });
            const failure = rejected.result as { status: number; problem: { key: string } };
            assert.equal(failure.status, 503);
            assert.equal(failure.problem.key, "PLURNK_MODEL");
            assert.equal(mock.remaining, 1, "an invalid default cannot silently consume another model");
            const result = await runLoopToTerminal(ws, 3, { prompt: "repair through explicit selection", selector: spec.alias });
            assert.equal(result.finalStatus, 200);
            assert.equal(mock.remaining, 0);
            const sessions = await db.test_sessions_with_model.all<SessionRow>({});
            assert.deepEqual(await routeSpec(db, sessions.find(({ id }) => id === result.modelSessionId)!.model_route_id), spec);
        } finally { ws.close(); }
    });
});

test("{§configuration-repair-path}: an invalid child default refuses work until an explicit child selection repairs it", async () => {
    const spec = declaredProvider("parent", "parent-repair-model");
    const child = declaredProvider("child", "child-repair-model");
    declaredProviderEnv.set("PLURNK_MODEL_CHILD", process.env.PLURNK_MODEL_CHILD);
    process.env.PLURNK_MODEL_CHILD = "missing-child";
    const mock = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("await plurnk.done({\"text\":\"repaired child policy\"});")] });
    ProviderInstantiate.registerInstance(mock, spec);
    ProviderInstantiate.registerInstance(new Mock({ contextWindow: 16_384, responses: [] }), child);
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "repair-child" });
            const workspaceId = (created.result as { id: number }).id;
            const rejected = await rpcCall(ws, 2, "loop.run", { prompt: "do not substitute the child model", selector: spec.alias });
            const failure = rejected.result as { status: number; problem: { key: string } };
            assert.equal(failure.status, 503);
            assert.equal(failure.problem.key, "PLURNK_MODEL_CHILD");
            assert.equal(mock.remaining, 1);
            const result = await runLoopToTerminal(ws, 3, { prompt: "repair child selection", childSelector: child.alias });
            assert.equal(result.finalStatus, 200);
            assert.ok(result.modelSessionId !== undefined);
            const state = await daemon.readSessionModel({ workspaceId, sessionId: result.modelSessionId });
            assert.equal(state.spawnModel?.alias, child.alias);
        } finally { ws.close(); }
    });
});

test("{§session-model-selection}: an explicit selection persists onto the session and an omitted selector continues it", async () => {
    const spec = declaredProvider("durable", "durable-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("await plurnk.done({\"text\":\"first\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"second\"});"),
        ],
    });
    ProviderInstantiate.registerInstance(mock, spec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `durable-${crypto.randomUUID()}` });
            const first = await runLoopToTerminal(ws, 2, {
                prompt: "first turn",
                selector: spec.alias,
            });
            assert.equal(first.finalStatus, 200);
            const second = await runLoopToTerminal(ws, 3, { prompt: "second turn with no selector" });
            assert.equal(second.finalStatus, 200, "the omitted selector continues the session's durable model instead of failing unconfigured");
            assert.equal(mock.remaining, 0, "both turns ran on the same selected model");

            const sessions = await db.test_sessions_with_model.all<SessionRow>({});
            const modelSession = sessions.find(({ id }) => id === first.modelSessionId);
            assert.ok(modelSession !== undefined);
            assert.deepEqual(await routeSpec(db, modelSession.model_route_id), spec, "the explicit selection persisted onto the session");
            assert.equal(modelSession.effort, "adaptive", "the alias-scoped default seeds the session once");
            const loops = (await db.test_all_loops.all<LoopRow>({}))
                .filter(({ session_id: owner, model_route_id }) => owner === first.modelSessionId && model_route_id !== null);
            assert.equal(loops.length, 2);
            assert.deepEqual(await routeSpec(db, loops[0].model_route_id), spec);
            assert.deepEqual(await routeSpec(db, loops[1].model_route_id), spec, "the continuation snapshots the session's durable route");
            assert.deepEqual(loops.map(({ effort }) => effort), ["adaptive", "adaptive"]);
        } finally {
            ws.close();
        }
    });
});

test("{§session-model-selection}: an exact provider/model selector persists without fabricated alias provenance", async () => {
    const spec: ProviderSpec = { provider: "openai", model: `direct-${crypto.randomUUID()}` };
    const bootAlias = `boot-${crypto.randomUUID()}`;
    for (const [key, value] of Object.entries({
        PLURNK_MODEL: bootAlias,
        [`PLURNK_MODEL_${bootAlias}`]: "openai/unrelated-local-model",
    })) {
        declaredProviderEnv.set(key, process.env[key]);
        process.env[key] = value;
    }
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("await plurnk.done({\"text\":\"direct route complete\"});")],
    });
    ProviderInstantiate.registerInstance(mock, spec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `direct-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "run the direct route",
                selector: `${spec.provider}/${spec.model}`,
            });
            assert.equal(result.finalStatus, 200);
            const sessions = await db.test_sessions_with_model.all<SessionRow>({});
            const session = sessions.find(({ id }) => id === result.modelSessionId);
            assert.ok(session !== undefined);
            assert.deepEqual(await routeSpec(db, session.model_route_id), spec);
            const stored = await db.model_route_by_id.get<{ alias: string | null }>({ id: session.model_route_id });
            assert.equal(stored?.alias, null, "database identity records the absence of an alias directly");
            assert.equal(mock.remaining, 0, "the direct route ran to completion");
        } finally {
            ws.close();
        }
    });
});

test("{§session-model-selection}: session model actions never disclose daemon endpoint configuration", async () => {
    const alias = `private-${crypto.randomUUID()}`;
    const spec: ProviderAlias = {
        alias,
        provider: "openai",
        model: "private-model",
        baseUrl: "http://private-model-host.internal/v1",
    };
    for (const [key, value] of Object.entries({
        [`PLURNK_MODEL_${alias}`]: `${spec.provider}/${spec.model}`,
        [`PLURNK_BASEURL_${alias}`]: spec.baseUrl,
    })) {
        declaredProviderEnv.set(key, process.env[key]);
        process.env[key] = value;
    }
    ProviderInstantiate.registerInstance(new Mock({ contextWindow: 16_384, responses: [] }), spec);

    await withDaemon(null, async (_db, daemon) => {
        const envelope = await daemon.createWorkspace({
            name: `private-route-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const sessionId = await namedModelSession(daemon, envelope.workspaceId, "main");
        const selected = await daemon.setSessionModel({
            workspaceId: envelope.workspaceId,
            sessionId,
            selector: alias,
        });
        assert.deepEqual(selected, {
            alias,
            provider: spec.provider,
            model: spec.model,
            effort: "adaptive",
            effortSource: "default",
        });
        assert.equal("baseUrl" in selected, false);

        const projected = await daemon.readSessionModel({
            workspaceId: envelope.workspaceId,
            sessionId,
        });
        assert.deepEqual(projected.model, selected);
        assert.equal(projected.model !== null && "baseUrl" in projected.model, false);
    });
});

test("{§session-model-selection}: effort controls seed the daemon-default model before the first loop", async () => {
    const spec = declaredProvider("reasoning-default", "reasoning-default-model");
    const mock = new Mock({ contextWindow: 16_384, responses: [] });
    const priorModel = process.env.PLURNK_MODEL;
    const declaration = `PLURNK_MODEL_${spec.alias}`;
    const priorDeclaration = process.env[declaration];
    process.env.PLURNK_MODEL = spec.alias;
    process.env[declaration] = `${spec.provider}/${spec.model}`;
    ProviderInstantiate.registerInstance(mock, spec, process.env, "adaptive");
    ProviderInstantiate.registerInstance(mock, spec, process.env, "high");

    try {
        await withDaemon(mock, async (db, daemon) => {
            const workspace = await daemon.createWorkspace({
                name: `reasoning-default-${crypto.randomUUID()}`,
                projectRoot: null,
            });
            const inspectedSession = await namedModelSession(daemon, workspace.workspaceId, "main");
            assert.deepEqual(await daemon.readSessionEffort({
                workspaceId: workspace.workspaceId,
                sessionId: inspectedSession,
            }), {
                effort: "adaptive",
                source: "default",
                supportedEfforts: ["off", "adaptive", "low", "medium", "high", "xhigh", "max"],
            });

            const selectedWorkspace = await daemon.createWorkspace({
                name: `reasoning-selected-${crypto.randomUUID()}`,
                projectRoot: null,
            });
            const selectedSession = await namedModelSession(daemon, selectedWorkspace.workspaceId, "main");
            assert.equal((await daemon.setSessionEffort({
                workspaceId: selectedWorkspace.workspaceId,
                sessionId: selectedSession,
                effort: "high",
            })).effort, "high");

            const rows = await db.test_sessions_with_model.all<SessionRow>({});
            for (const sessionId of [inspectedSession, selectedSession]) {
                const row = rows.find(({ id }) => id === sessionId);
                assert.ok(row !== undefined);
                assert.deepEqual(await routeSpec(db, row.model_route_id), spec);
            }
        });
    } finally {
        if (priorModel === undefined) delete process.env.PLURNK_MODEL;
        else process.env.PLURNK_MODEL = priorModel;
        if (priorDeclaration === undefined) delete process.env[declaration];
        else process.env[declaration] = priorDeclaration;
    }
});

test("{§session-model-selection}: alias configuration seeds once, explicit policy persists, and loops snapshot it", async () => {
    const spec = declaredProvider("reasoning-durable", "reasoning-durable-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("await plurnk.done({\"text\":\"fixed reasoning\"});")],
    });
    const aliasKnob = `PLURNK_PROVIDERS_EFFORT_${spec.alias}`;
    const previous = process.env[aliasKnob];
    process.env[aliasKnob] = "low";
    ProviderInstantiate.registerInstance(mock, spec, process.env, "low");
    ProviderInstantiate.registerInstance(mock, spec, process.env, "high");

    const db = await openMigrated();
    let first: Daemon | undefined;
    let second: Daemon | undefined;
    try {
        first = new Daemon({ db, provider: null });
        await first.start();
        const workspace = await first.createWorkspace({
            name: `reasoning-durable-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const sessionId = await namedModelSession(first, workspace.workspaceId, "main");
        await first.setSessionModel({
            workspaceId: workspace.workspaceId,
            sessionId,
            selector: spec.alias,
        });
        assert.deepEqual(await first.readSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
        }), {
            effort: "low",
            source: "default",
            supportedEfforts: ["off", "adaptive", "low", "medium", "high", "xhigh", "max"],
        });

        process.env[aliasKnob] = "adaptive";
        const selected = await first.setSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
            effort: "high",
        });
        assert.equal(selected.effort, "high");
        assert.equal(selected.source, "explicit", "{§session-model-selection}: a set effort is explicit");
        assert.equal((await first.readSessionEffort({ workspaceId: workspace.workspaceId, sessionId })).source, "explicit");
        const accepted = await first.runLoop({
            workspaceId: workspace.workspaceId,
            sessionId,
            prompt: "snapshot the durable policy",
        });
        for (let i = 0; i < 100; i++) {
            const row = await db.test_get_loop_status.get<{ status: number }>({ id: accepted.loopId });
            if (row?.status === 200) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const loops = await db.test_all_loops.all<LoopRow>({});
        assert.equal(loops.find(({ id }) => id === accepted.loopId)?.effort, "high");
        await first.stop();
        first = undefined;

        second = new Daemon({ db, provider: null });
        await second.start();
        assert.equal((await second.readSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
        })).effort, "high", "restart reads the session's durable value, not the changed env seed");
        const { model: route } = await second.readSessionModel({ workspaceId: workspace.workspaceId, sessionId });
        assert.equal(route?.effort, "high");
        assert.equal(route?.effortSource, "explicit", "{§session-model-selection}: the route carries the source beside the policy");
    } finally {
        if (first !== undefined) await first.stop();
        if (second !== undefined) await second.stop();
        await db.close();
        if (previous === undefined) delete process.env[aliasKnob];
        else process.env[aliasKnob] = previous;
    }
});

test("{§session-model-selection}: unsupported policy fails precisely and leaves durable state unchanged", async () => {
    const spec = declaredProvider("reasoning-limited", "reasoning-limited-model");
    const limited = new Mock({ contextWindow: 16_384, responses: [] });
    Object.defineProperty(limited, "supportedEfforts", {
        value: ["off", "adaptive", "high"],
    });
    ProviderInstantiate.registerInstance(limited, spec);
    ProviderInstantiate.registerInstance(limited, spec, process.env, "medium");

    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({
            name: `reasoning-limited-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
        await daemon.setSessionModel({
            workspaceId: workspace.workspaceId,
            sessionId,
            selector: spec.alias,
        });
        const refused = await daemon.setSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
            effort: "medium",
        }).then(
            () => null,
            (error: unknown) => error as { result?: { problem?: { type?: string; status?: number; recovery?: string }; supportedEfforts?: unknown } },
        );
        assert.equal(refused?.result?.problem?.status, 409);
        assert.equal(
            refused?.result?.problem?.type,
            "https://problems.plurnk.xyz/daemon/provider/effort-unsupported",
        );
        assert.equal(
            refused?.result?.problem?.recovery,
            "Select one of the provider's supported efforts: off, adaptive, high.",
        );
        assert.equal((await daemon.readSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
        })).effort, "adaptive", "a rejected selection does not mutate the session");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§session-model-selection}: a client-created branch copies durable generation policy by value", async () => {
    const spec = declaredProvider("branch-parent", "branch-parent-model");
    const childSpec = declaredProvider("branch-child", "branch-child-model");
    const parent = new Mock({ contextWindow: 16_384, responses: [] });
    const child = new Mock({ contextWindow: 16_384, responses: [] });
    Object.defineProperty(child, "supportedEfforts", {
        value: ["adaptive", "high"],
    });
    ProviderInstantiate.registerInstance(parent, spec);
    ProviderInstantiate.registerInstance(parent, spec, process.env, "high");
    ProviderInstantiate.registerInstance(child, childSpec);
    ProviderInstantiate.registerInstance(child, childSpec, process.env, "high");

    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({
            name: `branch-policy-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
        await daemon.setSessionModel({
            workspaceId: workspace.workspaceId,
            sessionId,
            selector: spec.alias,
        });
        await daemon.setSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
            effort: "high",
        });
        await daemon.setSessionSpawnModel({
            workspaceId: workspace.workspaceId,
            sessionId,
            selector: childSpec.alias,
        });
        assert.deepEqual((await daemon.readSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
        })).supportedEfforts, ["adaptive", "high"], "session choices are the root/spawn intersection");

        const branch = await daemon.forkSession({
            workspaceId: workspace.workspaceId,
            sessionId,
            name: "policy-branch",
        });
        const rows = await db.test_sessions_with_model.all<SessionRow>({});
        const source = rows.find(({ id }) => id === sessionId);
        const copied = rows.find(({ id }) => id === branch.sessionId);
        assert.ok(source !== undefined && copied !== undefined);
        assert.equal(copied.model_route_id, source.model_route_id);
        assert.equal(copied.spawn_model_route_id, source.spawn_model_route_id);
        assert.equal(copied.effort, "high");

        await daemon.setSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId,
            effort: "adaptive",
        });
        assert.equal((await daemon.readSessionEffort({
            workspaceId: workspace.workspaceId,
            sessionId: branch.sessionId,
        })).effort, "high", "the branch does not retain a live link to later source changes");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§session-model-selection}: the spawn override persists onto the session and supplies a later delegation", async () => {
    const parentSpec = declaredProvider("spawn-parent", "spawn-parent-model");
    const childSpec = declaredProvider("spawn-child", "spawn-child-model");
    const parent = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("await plurnk.done({\"text\":\"first done\"});"),
            makeMockResponse("await plurnk.work({\"target\":\"session://kid\",\"prompt\":\"delegate it\"});\n\nawait plurnk.wait({\"text\":\"waiting\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"second done\"});"),
        ],
    });
    const child = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("await plurnk.done({\"text\":\"kid done\"});")] });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `spawn-override-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const first = await runLoopToTerminal(ws, 2, {
                prompt: "first turn",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
            });
            assert.equal(first.finalStatus, 200);
            const second = await runLoopToTerminal(ws, 3, { prompt: "spawn a kid with no selectors" });
            assert.equal(second.finalStatus, 200);
            assert.equal(child.remaining, 0, "the later delegation ran on the session's durable spawn override");

            const sessions = await db.test_sessions_with_model.all<SessionRow>({});
            const root = sessions.find(({ id }) => id === first.modelSessionId);
            const kid = sessions.find(({ name }) => name === "kid");
            assert.ok(root !== undefined && kid !== undefined, "the delegation created a child session");
            assert.deepEqual(await routeSpec(db, root.spawn_model_route_id), childSpec, "the explicit spawn override persisted onto the session");
            assert.deepEqual(await routeSpec(db, kid.model_route_id), childSpec, "the child begins with the spawning loop's effective spawn model");
            assert.equal(kid.spawn_model_route_id, null, "the inherited child carries no override of its own");
            assert.equal(kid.effort, "adaptive", "the child inherits the spawning loop's effort by value");
            const delegatedPrompt = (await daemon.readLog({
                workspaceId,
                sessionId: kid.id,
            })).find((entry) => entry.op === "send" && entry.origin === "_plurnk");
            assert.equal(
                delegatedPrompt?.source,
                `session://${root.name}`,
                "the child's message retains its delegating session's causal identity",
            );
            const loops = await db.test_all_loops.all<LoopRow>({});
            const delegated = loops.find(({ session_id: owner }) => owner === kid.id);
            assert.deepEqual(await routeSpec(db, delegated?.model_route_id ?? null), childSpec);
        } finally {
            ws.close();
        }
    });
});

test("{§session-model-selection}: an absent spawn override inherits the session's own model by value", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const spec = declaredProvider("inherit-session", "same-through-tree");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("await plurnk.work({\"target\":\"session://kid\",\"prompt\":\"delegate it\"});\n\nawait plurnk.wait({\"text\":\"waiting\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"done\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"kid done\"});"),
        ],
    });
    ProviderInstantiate.registerInstance(mock, spec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `inherit-session-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "spawn one kid",
                selector: spec.alias,

            });
            assert.equal(result.finalStatus, 200);
            assert.equal(mock.remaining, 0);

            const sessions = await db.test_sessions_with_model.all<SessionRow>({});
            const root = sessions.find(({ id }) => id === result.modelSessionId);
            const kid = sessions.find(({ name }) => name === "kid");
            assert.ok(root !== undefined && kid !== undefined, "the delegation created a child session");
            assert.deepEqual(await routeSpec(db, root.model_route_id), spec, "the explicit selection persisted onto the root session");
            assert.equal(root.spawn_model_route_id, null, "no override: inherit remains absence");
            assert.deepEqual(await routeSpec(db, kid.model_route_id), spec, "the child inherits the parent's model by value");
            assert.equal(kid.spawn_model_route_id, null, "inherit does not become a sticky alias on the child");
            assert.equal(kid.effort, "adaptive", "effort follows the model through the tree");
        } finally {
            ws.close();
        }
    });
});

test("{§session-model-selection}: a redeclared alias does not rewrite the session's durable model", async () => {
    const spec = declaredProvider("mutable", "original-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("await plurnk.done({\"text\":\"first\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"second\"});"),
        ],
    });
    ProviderInstantiate.registerInstance(mock, spec);

    const declaration = `PLURNK_MODEL_${spec.alias}`;
    const priorDeclaration = process.env[declaration];
    try {
        await withDaemon(null, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `mutable-alias-${crypto.randomUUID()}` });
                process.env[declaration] = `${spec.provider}/${spec.model}`;
                const first = await runLoopToTerminal(ws, 2, {
                    prompt: "first turn",
                    selector: spec.alias,
                });
                assert.equal(first.finalStatus, 200);
                process.env[declaration] = "deepseek/redeclared-elsewhere";
                const second = await runLoopToTerminal(ws, 3, { prompt: "second turn with no selector" });
                assert.equal(second.finalStatus, 200, "the continuation keeps the session's durable route despite the redeclared alias");
                assert.equal(mock.remaining, 0, "the redeclared alias never resolved into a different model");
                const loops = (await db.test_all_loops.all<LoopRow>({}))
                    .filter(({ session_id: owner, model_route_id }) => owner === first.modelSessionId && model_route_id !== null);
                for (const loop of loops) {
                    assert.deepEqual(await routeSpec(db, loop.model_route_id), spec, "the durable snapshot is the original resolved spec, not the redeclaration");
                }
            } finally {
                ws.close();
            }
        });
    } finally {
        if (priorDeclaration === undefined) delete process.env[declaration];
        else process.env[declaration] = priorDeclaration;
    }
});

test("{§session-model-selection}: the session's durable model and spawn override survive daemon restart", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const spec = declaredProvider("restart-durable", "restart-durable-model");
    const childSpec = declaredProvider("restart-child", "restart-child-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("await plurnk.done({\"text\":\"before restart\"});"),
            makeMockResponse("await plurnk.work({\"target\":\"session://kid\",\"prompt\":\"delegate\"});\n\nawait plurnk.wait({\"text\":\"waiting\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"after restart\"});"),
        ],
    });
    const child = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("await plurnk.done({\"text\":\"kid done\"});")] });
    ProviderInstantiate.registerInstance(mock, spec);
    ProviderInstantiate.registerInstance(child, childSpec);

    const db = await openMigrated();
    let first: Daemon | undefined;
    let second: Daemon | undefined;
    try {
        first = new Daemon({ db, provider: null });
        await first.start();
        const envelope = await first.createWorkspace({ name: `session-model-restart-${crypto.randomUUID()}`, projectRoot: null });
        const sessionId = await namedModelSession(first, envelope.workspaceId, "main");
        await first.setSessionModel({ workspaceId: envelope.workspaceId, sessionId, selector: spec.alias });
        await first.setSessionSpawnModel({ workspaceId: envelope.workspaceId, sessionId, selector: childSpec.alias });
        const terminated: Array<{ loopId: number; result: { status: number } }> = [];
        first.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
        });
        const before = await first.runLoop({ workspaceId: envelope.workspaceId, sessionId, prompt: "before restart" });
        assert.equal(before.status, 100);
        for (let i = 0; i < 500 && !terminated.some((t) => t.loopId === before.loopId); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(terminated.some((t) => t.loopId === before.loopId && t.result.status === 200), true, "the pre-restart loop completed");
        await first.stop();
        first = undefined;

        second = new Daemon({ db, provider: null });
        await second.start();
        const settled: Array<{ loopId: number; result: { status: number } }> = [];
        second.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") settled.push(params as { loopId: number; result: { status: number } });
        });
        const after = await second.runLoop({ workspaceId: envelope.workspaceId, sessionId, prompt: "after restart, no selector" });
        for (let i = 0; i < 500 && !settled.some((t) => t.loopId === after.loopId); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(settled.some((t) => t.loopId === after.loopId && t.result.status === 200), true, "the selector-less post-restart loop completed");
        assert.equal(mock.remaining, 0, "every turn ran on the session's durable model");
        assert.equal(child.remaining, 0, "the post-restart delegation ran on the session's durable spawn override");
        const sessions = await db.test_sessions_with_model.all<SessionRow>({});
        const root = sessions.find(({ id }) => id === sessionId);
        const kid = sessions.find(({ name }) => name === "kid");
        assert.deepEqual(await routeSpec(db, root?.model_route_id ?? null), spec, "the durable model survived restart");
        assert.deepEqual(await routeSpec(db, root?.spawn_model_route_id ?? null), childSpec, "the durable spawn override survived restart");
        assert.deepEqual(await routeSpec(db, kid?.model_route_id ?? null), childSpec, "the child began with the effective spawn model after restart");
    } finally {
        if (first !== undefined) await first.stop();
        if (second !== undefined) await second.stop();
        await db.close();
    }
});

for (const selection of ["model", "spawn model", "reasoning", "prompt model", "prompt spawn model"] as const) {
    test(`{§session-model-selection} {§session-loop-lifecycle} {§notifications}: queued work adopts ${selection} changes for its next turn while settled loops keep their policy; only a change that lands is announced`, async (approvalContext) => {
        serverProposals(approvalContext, "accept");
        const spec = declaredProvider("queued", "queued-model");
        const replacement = declaredProvider("replacement", "replacement-model");
        const completeQueued = (label: string) => selection === "prompt model" || selection === "prompt spawn model"
            ? makeMockResponse(`await plurnk.done({"target":"message://main/01","text":"accepted"});\n\nawait plurnk.done({"target":"message://main/02","text":${JSON.stringify(label)}});`)
            : makeMockResponse(`await plurnk.done({"text":${JSON.stringify(label)}});`);
        const settledMock = new Mock({
            contextWindow: 16_384,
            responses: [makeMockResponse("await plurnk.done({\"text\":\"settled on initial policy\"});")],
        });
        const initialQueueMock = new Mock({
            contextWindow: 16_384,
            responses: [
                ...(selection === "spawn model" || selection === "prompt spawn model"
                    ? [
                        makeMockResponse("await plurnk.bare({\"prompt\":\"check spawn\"});"),
                        completeQueued("spawn verified"),
                    ]
                    : []),
            ],
        });
        const highEffortMock = new Mock({
            contextWindow: 16_384,
            responses: [completeQueued("ran on high effort")],
        });
        const replacementMock = new Mock({
            contextWindow: 16_384,
            responses: selection === "spawn model" || selection === "prompt spawn model"
                ? [{ assistant: { content: "from replacement child", reasoning: null } }]
                : [completeQueued("ran on replacement")],
        });
        ProviderInstantiate.registerInstance(settledMock, spec);
        ProviderInstantiate.registerInstance(highEffortMock, spec, process.env, "high");
        ProviderInstantiate.registerInstance(replacementMock, replacement);

        await withDaemon(null, async (db, daemon) => {
            const workspace = await daemon.createWorkspace({ name: `queued-${crypto.randomUUID()}`, projectRoot: null });
            const identity = { workspaceId: workspace.workspaceId, sessionId: await namedModelSession(daemon, workspace.workspaceId, "main") };
            type Policy = Awaited<ReturnType<typeof daemon.readSessionModel>> & { sessionId: number };
            const policies: Policy[] = [];
            const terminatedLoops = new Set<number>();
            const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "session/policy" && (params as Policy).sessionId === identity.sessionId) policies.push(params as Policy);
                if (method === "loop/terminated") terminatedLoops.add((params as { loopId: number }).loopId);
            });
            approvalContext.after(unsubscribe);

            await daemon.setSessionModel({ ...identity, selector: spec.alias });
            const before = await daemon.readSessionModel(identity);
            assert.deepEqual(policies, [{ sessionId: identity.sessionId, ...before }], "{§notifications}: the session's first model is announced, as session.model.get reads it");

            // Conclude one loop first so we verify terminal loops retain their settled policy snapshot.
            const settled = await daemon.runLoop({ ...identity, prompt: "settle initial loop" });
            await waitForDb(async () => terminatedLoops.has(settled.loopId), (done) => done);
            ProviderInstantiate.registerInstance(initialQueueMock, spec);

            const select = () => {
                if (selection === "prompt model") return daemon.runLoop({ ...identity, loopId: queued.loopId, prompt: "change model", selector: replacement.alias });
                if (selection === "prompt spawn model") return daemon.runLoop({ ...identity, loopId: queued.loopId, prompt: "change spawn model", childSelector: replacement.alias });
                if (selection === "model") return daemon.setSessionModel({ ...identity, selector: replacement.alias });
                if (selection === "spawn model") return daemon.setSessionSpawnModel({ ...identity, selector: replacement.alias });
                return daemon.setSessionEffort({ ...identity, effort: "high" });
            };

            // Hold the real admitted queue before its consumer starts.
            const resumeDrain = daemon.drains.suspendSession(identity.sessionId);
            const queued = await daemon.runLoop({ ...identity, prompt: "accepted work" });
            assert.deepEqual(await db.test_get_loop_status.get({ id: queued.loopId }), { status: 100 });
            await daemon.setSessionModel({ ...identity, selector: spec.alias });
            await daemon.setSessionSpawnModel({ ...identity, selector: null });
            await daemon.setSessionEffort({ ...identity, effort: "adaptive" });
            // {§session-model-selection}: reasserting the value in force marks effort explicit and announces only the source change.
            const reasserted = { ...before, model: { ...before.model!, effortSource: "explicit" as const } };
            assert.deepEqual(await daemon.readSessionModel(identity), reasserted);
            assert.deepEqual(policies.map(({ model }) => model?.effortSource), ["default", "explicit"]);

            await select();
            const after = await daemon.readSessionModel(identity);
            if (selection === "model" || selection === "prompt model") assert.equal(after.model?.alias, replacement.alias);
            else if (selection === "spawn model" || selection === "prompt spawn model") assert.equal(after.spawnModel?.alias, replacement.alias);
            else assert.equal(after.model?.effort, "high");
            assert.deepEqual(policies.slice(2), [{ sessionId: identity.sessionId, ...after }], "{§notifications}: the accepted live change is announced once");

            const loopsBeforeDrain = await db.test_all_loops.all<LoopRow>({});
            const settledLoopRow = loopsBeforeDrain.find(({ id }) => id === settled.loopId);
            const queuedLoopRow = loopsBeforeDrain.find(({ id }) => id === queued.loopId);
            assert.deepEqual(await routeSpec(db, settledLoopRow?.model_route_id ?? null), spec, "terminal loops keep the policy they settled under");
            assert.equal(settledLoopRow?.spawn_model_route_id, null);
            assert.equal(settledLoopRow?.effort, "adaptive");
            if (selection === "model" || selection === "prompt model") {
                assert.deepEqual(await routeSpec(db, queuedLoopRow?.model_route_id ?? null), replacement, "the queued loop adopts the new model immediately");
            } else if (selection === "spawn model" || selection === "prompt spawn model") {
                assert.deepEqual(await routeSpec(db, queuedLoopRow?.spawn_model_route_id ?? null), replacement, "the queued loop adopts the new spawn model immediately");
            } else {
                assert.equal(queuedLoopRow?.effort, "high", "the queued loop adopts the new effort immediately");
            }

            await resumeDrain();
            await waitForDb(async () => terminatedLoops.has(queued.loopId), (done) => done);
            assert.deepEqual(await db.test_get_loop_status.get({ id: queued.loopId }), { status: 200 });
            if (selection === "reasoning") assert.equal(highEffortMock.remaining, 0, "the queued loop executed on the new effort");
            else assert.equal(replacementMock.remaining, 0, "the queued loop executed on the replacement route");
            assert.equal(policies.length, 3, "{§notifications}: draining on the policy in force announces nothing");
        });
    });
}

test("{§session-model-selection}: work admitted during provider validation converges onto the committed session policy", async (t) => {
    const spec = declaredProvider("selection-race", "selection-race-model");
    const mock = new Mock({ contextWindow: 16_384, responses: [] });
    ProviderInstantiate.registerInstance(mock, spec);
    ProviderInstantiate.registerInstance(mock, spec, process.env, "high");
    await withDaemon(null, async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: `selection-race-${crypto.randomUUID()}`, projectRoot: null });
        const identity = { workspaceId: workspace.workspaceId, sessionId: await namedModelSession(daemon, workspace.workspaceId, "main") };
        await daemon.setSessionModel({ ...identity, selector: spec.alias });
        const validating = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const validate = SessionModels.prototype.supportedEfforts;
        t.mock.method(SessionModels.prototype, "supportedEfforts", async function (
            this: SessionModels,
            policy: Parameters<SessionModels["supportedEfforts"]>[0],
        ) {
            if (policy.effort === "high") {
                validating.resolve();
                await release.promise;
            }
            return validate.call(this, policy);
        });
        const resumeSuspended = daemon.drains.suspendSession(identity.sessionId);
        t.after(() => resumeSuspended());
        const updating = daemon.setSessionEffort({ ...identity, effort: "high" });
        await validating.promise;
        const admitting = daemon.runLoop({ ...identity, prompt: "admitted during selection" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        release.resolve();
        const [, queued] = await Promise.all([updating, admitting]);
        const after = await daemon.readSessionModel(identity);
        assert.equal(after.model?.effort, "high");
        const loopRow = (await db.test_all_loops.all<LoopRow>({})).find(({ id }) => id === queued.loopId);
        assert.equal(loopRow?.effort, "high", "session and open loop converge without split-brain");
        await daemon.cancelSession(identity);
    });
});

test("{§session-model-selection} {§engine-rails}: running (102) and crash-parked (202) loops switch models at the next turn boundary without cancellation", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const firstSpec = declaredProvider("running-first", "running-first-model");
    const secondSpec = declaredProvider("running-second", "running-second-model");
    const childSpec = declaredProvider("running-child", "running-child-model");
    const crashedSpec = declaredProvider("crashed", "crashed-model");

    const turnOneGate = Promise.withResolvers<void>();
    const turnOneEntered = Promise.withResolvers<void>();
    const firstMock = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("await plurnk.note({\"text\":\"turn 1 on first model\"});")],
    });
    const baseGenerate = firstMock.generate.bind(firstMock);
    firstMock.generate = async (request) => {
        turnOneEntered.resolve();
        await turnOneGate.promise;
        return baseGenerate(request);
    };
    const secondMock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("await plurnk.bare({\"prompt\":\"delegate to new child\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"turn 3 finished on second model\"});"),
            makeMockResponse("await plurnk.done({\"target\":\"message://main/01\",\"text\":\"first\"});\n\nawait plurnk.done({\"target\":\"message://main/02\",\"text\":\"recovered from crash without cancelling\"});"),
        ],
    });
    const childMock = new Mock({
        contextWindow: 8_192,
        responses: [{ assistant: { content: "child response", reasoning: null } }],
    });
    const crashedMock = new Mock({ contextWindow: 16_384, responses: [] });
    crashedMock.generate = async () => {
        throw new ProviderError("plurnk", "network_failure", "upstream crashed");
    };

    ProviderInstantiate.registerInstance(firstMock, firstSpec);
    ProviderInstantiate.registerInstance(secondMock, secondSpec);
    ProviderInstantiate.registerInstance(secondMock, secondSpec, process.env, "high");
    ProviderInstantiate.registerInstance(childMock, childSpec);
    ProviderInstantiate.registerInstance(childMock, childSpec, process.env, "high");
    ProviderInstantiate.registerInstance(crashedMock, crashedSpec);

    await withDaemon(null, async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: `live-switch-${crypto.randomUUID()}`, projectRoot: null });
        await daemon.registerSessionOwner(workspace.workspaceId, {
            address: "acp://test/operator",
            tools: [],
            interactive: true,
        });
        const created = await daemon.createSession({
            workspaceId: workspace.workspaceId,
            name: "main",
            owner: "acp://test/operator",
        });
        const identity = { workspaceId: workspace.workspaceId, sessionId: created.sessionId };

        // 1. Mid-turn (102) switch: Turn 1 finishes on firstSpec; Turn 2+ runs on secondSpec + childSpec + high effort.
        const running = await daemon.runLoop({ ...identity, prompt: "start on first", selector: firstSpec.alias, maxTurns: 6 });
        await turnOneEntered.promise;
        assert.deepEqual(await db.test_get_loop_status.get({ id: running.loopId }), { status: 102 });

        // Rejected turn-ceiling conflict during an active loop leaves generation policy untouched.
        await assert.rejects(
            daemon.runLoop({ ...identity, prompt: "bad ceiling", selector: secondSpec.alias, maxTurns: 9 }),
            (err: unknown) => err instanceof OperationFailureError
                && err.result.problem?.type === "https://problems.plurnk.xyz/daemon/loop/turn-ceiling-conflict",
        );
        assert.equal((await daemon.readSessionModel(identity)).model?.alias, firstSpec.alias, "failed admission did not mutate the session model");

        const switchedModel = await daemon.setSessionModel({ ...identity, selector: secondSpec.alias });
        assert.equal(switchedModel.alias, secondSpec.alias);
        await daemon.setSessionSpawnModel({ ...identity, selector: childSpec.alias });
        await daemon.setSessionEffort({ ...identity, effort: "high" });

        turnOneGate.resolve();
        await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: running.loopId }), (row) => row?.status === 200);
        assert.equal(firstMock.remaining, 0, "turn 1 finished undisturbed on firstSpec");
        assert.equal(childMock.remaining, 0, "turn 2 BARE ran on the newly selected spawn model");
        assert.equal(secondMock.remaining, 1, "turns 2 and 3 ran on secondSpec");

        // 2. Crash-parked (202) recovery: provider crashes -> loop parks in 202 -> re-pin to secondSpec and resume in-place!
        await daemon.setSessionEffort({ ...identity, effort: "adaptive" });
        await daemon.setSessionSpawnModel({ ...identity, selector: null });
        const crashing = await daemon.runLoop({ ...identity, prompt: "hit crashed route", selector: crashedSpec.alias });
        await waitForDb(
            () => db.test_get_loop_status.get<{ status: number }>({ id: crashing.loopId }),
            (row) => row?.status === 202,
            { timeoutMs: 8_000 },
        );

        const repinned = await daemon.setSessionModel({ ...identity, selector: secondSpec.alias });
        assert.equal(repinned.alias, secondSpec.alias, "re-pinned while parked in 202 without cancelling");
        const resumed = await daemon.runLoop({ ...identity, prompt: "resume after crash" });
        assert.equal(resumed.action, "injected_next_turn");
        assert.equal(resumed.loopId, crashing.loopId, "resumed the exact parked loop in place");
        await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: crashing.loopId }), (row) => row?.status === 200);
        assert.equal(secondMock.remaining, 0, "the parked loop woke and completed on the healthy provider");
    });
});

test("{§session-model-selection}: a model switch re-derives a default policy from the new alias but keeps an explicit one", async () => {
    const first = declaredProvider("source-first", "source-first-model");
    const second = declaredProvider("source-second", "source-second-model");
    const mock = new Mock({ contextWindow: 16_384, responses: [] });
    const knobs = [`PLURNK_PROVIDERS_EFFORT_${first.alias}`, `PLURNK_PROVIDERS_EFFORT_${second.alias}`];
    const previous = knobs.map((k) => process.env[k]);
    process.env[knobs[0]] = "low";
    process.env[knobs[1]] = "medium";
    for (const policy of ["low", "medium", "high"] as const) {
        ProviderInstantiate.registerInstance(mock, first, process.env, policy);
        ProviderInstantiate.registerInstance(mock, second, process.env, policy);
    }
    const db = await openMigrated();
    let daemon: Daemon | undefined;
    try {
        daemon = new Daemon({ db, provider: null });
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `source-${crypto.randomUUID()}`, projectRoot: null });
        const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
        const args = { workspaceId: workspace.workspaceId, sessionId };

        // Seeded from the first alias: default.
        await daemon.setSessionModel({ ...args, selector: first.alias });
        assert.deepEqual(
            [(await daemon.readSessionEffort(args)).effort, (await daemon.readSessionEffort(args)).source],
            ["low", "default"],
        );
        // A default follows the alias: switching models re-derives it.
        await daemon.setSessionModel({ ...args, selector: second.alias });
        assert.deepEqual(
            [(await daemon.readSessionEffort(args)).effort, (await daemon.readSessionEffort(args)).source],
            ["medium", "default"],
            "a seeded value never outlives the alias that supplied it",
        );
        // An explicit choice follows the session across models.
        await daemon.setSessionEffort({ ...args, effort: "high" });
        await daemon.setSessionModel({ ...args, selector: first.alias });
        assert.deepEqual(
            [(await daemon.readSessionEffort(args)).effort, (await daemon.readSessionEffort(args)).source],
            ["high", "explicit"],
            "a chosen policy survives a model switch",
        );
        const { model: route } = await daemon.readSessionModel(args);
        assert.equal(route?.effortSource, "explicit");
    } finally {
        if (daemon !== undefined) await daemon.stop();
        await db.close();
        knobs.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]!; });
    }
});

const effortFixture = () => {
    const full = declaredProvider("effort-full", "effort-full-model");
    const limited = declaredProvider("effort-limited", "effort-limited-model");
    const fullMock = new Mock({ contextWindow: 16_384, responses: [] });
    const limitedMock = new Mock({ contextWindow: 16_384, responses: [] });
    Object.defineProperty(limitedMock, "supportedEfforts", { value: ["off", "adaptive", "low", "medium", "xhigh"] });
    for (const effort of ["adaptive", "medium", "high"] as const) {
        ProviderInstantiate.registerInstance(fullMock, full, process.env, effort);
        ProviderInstantiate.registerInstance(limitedMock, limited, process.env, effort);
    }
    return { full, limited, limitedMock };
};
const unsupported = (error: { result?: { problem?: { type?: string } } }): boolean =>
    error.result?.problem?.type === "https://problems.plurnk.xyz/daemon/provider/effort-unsupported";

test("{§session-model-selection}: a model and an effort it supports are chosen together; the carried effort alone is refused", async () => {
    const { full, limited } = effortFixture();
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `effort-${crypto.randomUUID()}`, projectRoot: null });
        const args = { workspaceId: workspace.workspaceId, sessionId: await namedModelSession(daemon, workspace.workspaceId, "main") };
        await daemon.setSessionModel({ ...args, selector: full.alias });
        await daemon.setSessionEffort({ ...args, effort: "high" });
        await assert.rejects(daemon.setSessionModel({ ...args, selector: limited.alias }), unsupported,
            "an explicit effort follows the session, so a model without it is refused");
        const route = await daemon.setSessionModel({ ...args, selector: limited.alias, effort: "medium" });
        assert.deepEqual([route.effort, route.effortSource], ["medium", "explicit"]);
        assert.deepEqual([(await daemon.readSessionEffort(args)).effort, (await daemon.readSessionEffort(args)).source], ["medium", "explicit"]);
        await assert.rejects(daemon.setSessionModel({ ...args, selector: full.alias, effort: "turbo" }),
            (error: { result?: { problem?: { type?: string; recovery?: string } } }) =>
                error.result?.problem?.type === "https://problems.plurnk.xyz/daemon/input/effort-invalid"
                && error.result?.problem?.recovery === "Select a valid effort: off, adaptive, low, medium, high, xhigh, max.");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§session-model-selection}: an effort its model no longer supports is corrected by choosing one it does, never trapped", async () => {
    const { full, limitedMock } = effortFixture();
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `effort-stale-${crypto.randomUUID()}`, projectRoot: null });
        const args = { workspaceId: workspace.workspaceId, sessionId: await namedModelSession(daemon, workspace.workspaceId, "main") };
        await daemon.setSessionModel({ ...args, selector: full.alias });
        await daemon.setSessionEffort({ ...args, effort: "high" });
        // The model's declaration changes beneath the stored pair.
        for (const effort of ["adaptive", "medium", "high"] as const) ProviderInstantiate.registerInstance(limitedMock, full, process.env, effort);
        const corrected = await daemon.setSessionEffort({ ...args, effort: "medium" });
        assert.equal(corrected.effort, "medium");
        await assert.rejects(daemon.setSessionEffort({ ...args, effort: "high" }), unsupported, "the new pair is still validated");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§session-model-selection}: switching to a smaller model whose budget cannot hold the session's context is a 413 until context is curated", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const largeSpec = declaredProvider("large", "large-window-model");
    const smallSpec = declaredProvider("small", "small-window-model");
    const bigNote = "context ".repeat(3_000);
    const large = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse(`await plurnk.note({"text":"${bigNote}"});

await plurnk.done({"text":"stored note"});`),
            makeMockResponse("await plurnk.kill({\"path\":\"log:///**/note\"});\n\nawait plurnk.done({\"text\":\"curated note\"});"),
        ],
    });
    const small = new Mock({
        contextWindow: 12_000,
        responses: [makeMockResponse("await plurnk.done({\"text\":\"small model ran\"});")],
    });
    ProviderInstantiate.registerInstance(large, largeSpec);
    ProviderInstantiate.registerInstance(small, smallSpec);

    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `downsize-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const first = await runLoopToTerminal(ws, 2, {
                prompt: "accumulate context",
                selector: largeSpec.alias,
            });
            assert.equal(first.finalStatus, 200);
            const sessionId = first.modelSessionId!;

            // Both session.model.set and loop.run with a smaller selector refuse with 413 context-exceeds-model-budget.
            const refusedSet = await daemon.setSessionModel({
                workspaceId,
                sessionId,
                selector: smallSpec.alias,
            }).then(() => null, (error: unknown) => error as OperationFailureError);
            assert.ok(refusedSet instanceof OperationFailureError);
            assert.equal(refusedSet.result.status, 413);
            assert.equal(refusedSet.result.problem?.type, "https://problems.plurnk.xyz/daemon/provider/context-exceeds-model-budget");
            assert.match(refusedSet.result.problem?.detail ?? "", new RegExp(`^Current context \\(\\d+ tokens\\) does not fit in provider alias '${smallSpec.alias}' \\(openai/small-window-model\\) \\(budget: \\d+ tokens\\)\\.$`, "u"));
            assert.match(refusedSet.result.problem?.recovery ?? "", /^Curate context below \d+ tokens or select a larger model\.$/u);

            const refusedRun = await rpcCall(ws, 3, "loop.run", {
                prompt: "attempt on small model",
                selector: smallSpec.alias,
            });
            const runFailure = refusedRun.result as { status: number; problem?: { type?: string } };
            assert.equal(runFailure.status, 413);
            assert.equal(runFailure.problem?.type, "https://problems.plurnk.xyz/daemon/provider/context-exceeds-model-budget");
            assert.equal((await daemon.readSessionModel({ workspaceId, sessionId })).model?.alias, largeSpec.alias, "the refused switch leaves the session's model unchanged");

            // Curate the large NOTE out of context on the current model; switching to the smaller model now succeeds.
            const curated = await runLoopToTerminal(ws, 4, { prompt: "curate context for smaller model" });
            assert.equal(curated.finalStatus, 200);
            const switched = await daemon.setSessionModel({
                workspaceId,
                sessionId,
                selector: smallSpec.alias,
            });
            assert.equal(switched.alias, smallSpec.alias);
            const second = await runLoopToTerminal(ws, 5, { prompt: "continue on small model" });
            assert.equal(second.finalStatus, 200);
            assert.equal(small.remaining, 0);
        } finally {
            ws.close();
        }
    });
});
});
