import test, { describe } from "node:test";
import assert from "node:assert/strict";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Daemon from "../../src/server/Daemon.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import SessionModels from "../../src/server/SessionModels.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { serverProposals } from "./_approval.ts";
import { Mock, type ProviderAlias, type ProviderSpec, type MockResponse, AiSdkProvider } from "@plurnk/plurnk-providers";
import { type Effort, Validator } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../../src/core/results.ts";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop } from "./_db.ts";
import { connect, rpcCall, runLoopToTerminal, waitForDb, withDaemon, HARNESS_WAIT_MS, waitFor } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";
import { routeForSpec, specForRoute } from "../../src/server/model-route.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readSessionTopology } from "../SessionTopology.ts";
import { bindListener } from "./_http.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { SessionTranslator } from "@plurnk/plurnk-acp";
import { requestBody } from "../../../scripts/lib/test-fetch.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { completeStmt } from "./_dsl.ts";

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
    const mock = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("````SEND [200]\nready\n````")] });
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
    const mock = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("````SEND [200]\nrepaired\n````")] });
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
    const mock = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("````SEND [200]\nrepaired child policy\n````")] });
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
            makeMockResponse("````SEND [200]\nfirst\n````"),
            makeMockResponse("````SEND [200]\nsecond\n````"),
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
        [`PLURNK_PROVIDERS_GBNF_${bootAlias}`]: "/operator/rails/boot.gbnf",
    })) {
        declaredProviderEnv.set(key, process.env[key]);
        process.env[key] = value;
    }
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("````SEND [200]\ndirect route complete\n````")],
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
            assert.equal(mock.remaining, 0, "the unrelated boot alias's GBNF scope did not intercept the direct route");
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
        responses: [makeMockResponse("````SEND [200]\nfixed reasoning\n````")],
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
            makeMockResponse("````SEND [200]\nfirst done\n````"),
            makeMockResponse("````WORK (session://kid)\ndelegate it\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\nsecond done\n````"),
        ],
    });
    const child = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("````SEND [200]\nkid done\n````")] });
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
            })).find((entry) => entry.op === "SEND" && entry.origin === "_plurnk");
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
            makeMockResponse("````WORK (session://kid)\ndelegate it\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\ndone\n````"),
            makeMockResponse("````SEND [200]\nkid done\n````"),
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
            makeMockResponse("````SEND [200]\nfirst\n````"),
            makeMockResponse("````SEND [200]\nsecond\n````"),
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
            makeMockResponse("````SEND [200]\nbefore restart\n````"),
            makeMockResponse("````WORK (session://kid)\ndelegate\n````\n\n````WAIT\nwaiting\n````"),
            makeMockResponse("````SEND [200]\nafter restart\n````"),
        ],
    });
    const child = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("````SEND [200]\nkid done\n````")] });
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
        const before = await first.runLoop({ workspaceId: envelope.workspaceId, sessionId, prompt: "before restart" });
        assert.equal(before.status, 100);
        const terminated: Array<{ loopId: number; result: { status: number } }> = [];
        first.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
        });
        for (let i = 0; i < 100 && !terminated.some((t) => t.loopId === before.loopId); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(terminated.some((t) => t.loopId === before.loopId && t.result.status === 200), true, "the pre-restart loop completed");
        await first.stop();
        first = undefined;

        second = new Daemon({ db, provider: null });
        await second.start();
        const after = await second.runLoop({ workspaceId: envelope.workspaceId, sessionId, prompt: "after restart, no selector" });
        const settled: Array<{ loopId: number; result: { status: number } }> = [];
        second.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") settled.push(params as { loopId: number; result: { status: number } });
        });
        for (let i = 0; i < 100 && !settled.some((t) => t.loopId === after.loopId); i++) {
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
    test(`{§session-loop-lifecycle} {§notifications}: queued work blocks ${selection} changes until cancellation; only a change that lands is announced`, async (t) => {
        const spec = declaredProvider("queued", "queued-model");
        const replacement = declaredProvider("replacement", "replacement-model");
        const mock = new Mock({
            contextWindow: 16_384,
            responses: [makeMockResponse("````SEND [200]\nnew work complete\n````")],
        });
        ProviderInstantiate.registerInstance(mock, spec);
        ProviderInstantiate.registerInstance(mock, spec, process.env, "high");
        ProviderInstantiate.registerInstance(mock, replacement);

        await withDaemon(null, async (db, daemon) => {
            const workspace = await daemon.createWorkspace({ name: `queued-${crypto.randomUUID()}`, projectRoot: null });
            const identity = { workspaceId: workspace.workspaceId, sessionId: await namedModelSession(daemon, workspace.workspaceId, "main") };
            // {§notifications} What the session's subscribers are told of its policy.
            type Policy = Awaited<ReturnType<typeof daemon.readSessionModel>> & { sessionId: number };
            const policies: Policy[] = [];
            const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "session/policy" && (params as Policy).sessionId === identity.sessionId) policies.push(params as Policy);
            });
            t.after(unsubscribe);
            await daemon.setSessionModel({ ...identity, selector: spec.alias });
            const before = await daemon.readSessionModel(identity);
            assert.deepEqual(policies, [{ sessionId: identity.sessionId, ...before }], "{§notifications}: the session's first model is announced, as session.model.get reads it");
            const select = () => {
                if (selection === "prompt model") return daemon.runLoop({ ...identity, prompt: "change model", selector: replacement.alias });
                if (selection === "prompt spawn model") return daemon.runLoop({ ...identity, prompt: "change spawn model", childSelector: replacement.alias });
                if (selection === "model") return daemon.setSessionModel({ ...identity, selector: replacement.alias });
                if (selection === "spawn model") return daemon.setSessionSpawnModel({ ...identity, selector: replacement.alias });
                return daemon.setSessionEffort({ ...identity, effort: "high" });
            };

            // Hold the real admitted queue before its consumer starts.
            const drain = t.mock.method(DrainSupervisor.prototype, "ensureDrain", async () => null);
            const queued = await daemon.runLoop({ ...identity, prompt: "accepted work" });
            assert.deepEqual(await db.test_get_loop_status.get({ id: queued.loopId }), { status: 100 });
            await daemon.setSessionModel({ ...identity, selector: spec.alias });
            await daemon.setSessionSpawnModel({ ...identity, selector: null });
            await daemon.setSessionEffort({ ...identity, effort: "adaptive" });
            // {§session-model-selection}: reasserting the value in force is legal mid-loop and marks it chosen.
            const reasserted = { ...before, model: { ...before.model!, effortSource: "explicit" as const } };
            assert.deepEqual(await daemon.readSessionModel(identity), reasserted, "reasserting the same settings remains legal");
            assert.deepEqual(policies.map(({ model }) => model?.effortSource), ["default", "explicit"],
                "{§notifications}: reasserting the model and spawn model in force announces nothing; choosing the effort in force announces its new source");
            await assert.rejects(select(), (error: unknown) => error instanceof OperationFailureError
                && error.result.status === 409
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/session/session-loop-active");
            assert.deepEqual(await daemon.readSessionModel(identity), reasserted, "a refused selection changes no generation settings");
            assert.equal(policies.length, 2, "{§notifications}: and announces nothing");
            assert.equal(mock.remaining, 1, "queued work needs no provider call to establish liveness");

            await daemon.cancelSession({ ...identity, reason: "cancel queued task" });
            assert.deepEqual(await db.test_get_loop_status.get({ id: queued.loopId }), { status: 499 });
            if (selection === "prompt model") await daemon.setSessionModel({ ...identity, selector: replacement.alias });
            else if (selection === "prompt spawn model") await daemon.setSessionSpawnModel({ ...identity, selector: replacement.alias });
            else await select();
            const after = await daemon.readSessionModel(identity);
            if (selection === "model" || selection === "prompt model") assert.equal(after.model?.alias, replacement.alias);
            else if (selection === "spawn model" || selection === "prompt spawn model") assert.equal(after.spawnModel?.alias, replacement.alias);
            else assert.equal(after.model?.effort, "high");
            assert.deepEqual(policies.slice(2), [{ sessionId: identity.sessionId, ...after }], "{§notifications}: the accepted change is announced once");

            drain.mock.restore();
            const fresh = await daemon.runLoop({ ...identity, prompt: "new independent work" });
            await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: fresh.loopId }), (row) => row?.status === 200);
            assert.equal(mock.remaining, 0, "new work runs after cancellation and explicit reselection");
            assert.equal(policies.length, 3, "{§notifications}: new work on the policy in force announces nothing");
            assert.deepEqual(await db.test_get_loop_status.get({ id: queued.loopId }), { status: 499 }, "cancelled work is not revived");
        });
    });
}

test("{§session-model-selection}: work admitted during provider validation prevents a late policy change", async (t) => {
    const spec = declaredProvider("selection-race", "selection-race-model");
    const mock = new Mock({ contextWindow: 16_384, responses: [] });
    ProviderInstantiate.registerInstance(mock, spec);
    ProviderInstantiate.registerInstance(mock, spec, process.env, "high");
    await withDaemon(null, async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: `selection-race-${crypto.randomUUID()}`, projectRoot: null });
        const identity = { workspaceId: workspace.workspaceId, sessionId: await namedModelSession(daemon, workspace.workspaceId, "main") };
        await daemon.setSessionModel({ ...identity, selector: spec.alias });
        const before = await daemon.readSessionModel(identity);
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
        t.mock.method(DrainSupervisor.prototype, "ensureDrain", async () => null);
        const refused = assert.rejects(daemon.setSessionEffort({ ...identity, effort: "high" }),
            (error: unknown) => error instanceof OperationFailureError
                && error.result.status === 409
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/session/session-loop-active");
        await validating.promise;
        try {
            const queued = await daemon.runLoop({ ...identity, prompt: "admitted during selection" });
            assert.deepEqual(await db.test_get_loop_status.get({ id: queued.loopId }), { status: 100 });
        } finally { release.resolve(); }
        await refused;
        assert.deepEqual(await daemon.readSessionModel(identity), before, "the atomic write leaves the admitted policy intact");
        await daemon.cancelSession(identity);
    });
});

test("{§session-model-selection}: a selection while the session holds a parked loop is a precise 409", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const spec = declaredProvider("parked", "parked-model");
    const otherSpec = declaredProvider("switcheroo", "other-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("````sh\nsleep 30\n````\n\n````WAIT\ndone\n````"),
            makeMockResponse("````SEND [200]\nresumed\n````"),
        ],
    });
    ProviderInstantiate.registerInstance(mock, spec);
    ProviderInstantiate.registerInstance(mock, otherSpec);

    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        const priorOptimisticWait = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `parked-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace !== undefined);
            const sessionId = await namedModelSession(daemon, workspace.id, "main");
            const started = await daemon.runLoop({
                workspaceId: workspace.id,
                sessionId,
                prompt: "park",
                selector: spec.alias,

            });
            // The execution stream keeps the loop parked (202); wait for that state.
            for (let i = 0; i < 100; i++) {
                const loops = await db.test_all_loops.all<{ status: number }>({});
                if (loops.some(({ status }) => status === 202)) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const loops = await db.test_all_loops.all<{ status: number }>({});
            assert.ok(loops.some(({ status }) => status === 202), "the loop parked on its live stream");

            const refused = await daemon.setSessionModel({
                workspaceId: workspace.id,
                sessionId,
                selector: otherSpec.alias,
            }).then(
                () => null,
                (error: unknown) => error as { result?: { problem?: { type?: string; status?: number } } },
            );
            const refusedProblem = refused?.result?.problem;
            assert.equal(refusedProblem?.status, 409, "a selection under a parked loop is refused precisely");
            assert.equal(refusedProblem?.type, "https://problems.plurnk.xyz/daemon/session/session-loop-active");

            const reasoningRefused = await daemon.setSessionEffort({
                workspaceId: workspace.id,
                sessionId,
                effort: "high",
            }).then(
                () => null,
                (error: unknown) => error as { result?: { problem?: { type?: string; status?: number } } },
            );
            assert.equal(reasoningRefused?.result?.problem?.status, 409);
            assert.equal(
                reasoningRefused?.result?.problem?.type,
                "https://problems.plurnk.xyz/daemon/session/session-loop-active",
                "effort cannot mutate under a parked loop either",
            );

            // {§methods} cancelSession awaits the session's cancellation and reap.
            await daemon.cancelSession({ workspaceId: workspace.id, sessionId });
            const selected = await daemon.setSessionModel({
                workspaceId: workspace.id,
                sessionId,
                selector: otherSpec.alias,
            });
            assert.equal(selected.alias, otherSpec.alias, "after cancelling, the selection persists");
            void started;
        } finally {
            if (priorOptimisticWait === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = priorOptimisticWait;
            ws.close();
        }
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
            makeMockResponse(`\`\`\`\`NOTE\n${bigNote}\n\`\`\`\`\n\n\`\`\`\`SEND [200]\nstored note\n\`\`\`\``),
            makeMockResponse("````KILL (log:///**/NOTE)````\n\n````SEND [200]\ncurated note\n````"),
        ],
    });
    const small = new Mock({
        contextWindow: 12_000,
        responses: [makeMockResponse("````SEND [200]\nsmall model ran\n````")],
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

describe("ModelRoute", () => {
test("{§session-model-selection}: concurrent first selections share one immutable resolved route", async (t) => {
    const db = await openMigrated();
    try {
        const query = db.model_route_lookup;
        const get = query.get.bind(query);
        const bothRead = Promise.withResolvers<void>();
        let reads = 0;
        t.mock.method(query, "get", async (...args: Parameters<typeof get>) => {
            const row = await get(...args);
            if (++reads === 2) bothRead.resolve();
            await bothRead.promise;
            return row;
        });
        const spec = { provider: "openai", model: "first-selection" };
        const ids = await Promise.all([routeForSpec(db, spec), routeForSpec(db, spec)]);
        assert.ok(ids[0] !== null);
        assert.equal(ids[0], ids[1]);
        assert.deepEqual(await specForRoute(db, ids[0]), spec);
        assert.equal(await routeForSpec(db, spec), ids[0], "later lookup preserves the original identity");
        for (const distinct of [
            { ...spec, alias: "local" },
            { ...spec, baseUrl: "http://127.0.0.1:8080/v1" },
            { ...spec, model: "other-model" },
            { ...spec, provider: "other-provider" },
        ]) {
            const other = await routeForSpec(db, distinct);
            assert.notEqual(other, ids[0]);
            assert.deepEqual(await specForRoute(db, other), distinct);
            assert.deepEqual(await specForRoute(db, ids[0]), spec, "another selection never rewrites the original route");
        }
    } finally { await db.close(); }
});
});

describe("demo-reporting", () => {
test("{§methods-workspace-create} topology reporting counts children and grandchildren, not independent roots", async () => {
    const db = await openMigrated();
    try {
        const workspace = await insertWorkspace(db, "topology-report");
        const root = await insertSession(db, workspace, null, "root", "model");
        const independent = await insertSession(db, workspace, null, "independent", "model");
        const child = await insertSession(db, workspace, root, "child", "model");
        const grandchild = await insertSession(db, workspace, child, "grandchild", "model");
        const runtime = await RuntimeSession.ensure(db, workspace);
        const report = await readSessionTopology(db, workspace);
        assert.equal(report.delegatedSessions, 2);
        assert.deepEqual(new Set(report.sessions.map(({ id }) => id)), new Set([root, independent, child, grandchild, runtime]));
    } finally { await db.close(); }
});

test("{§packet-assembly} the advisory floor instrument measures a real initial packet", { timeout: 90_000 }, async () => {
    for (const items of ["0", "-1"]) {
        const { stdout } = await promisify(execFile)(process.execPath, [
            "--conditions=plurnk-dev", "--import=./test/setup.ts", "--env-file-if-exists=.env.defaults",
            "scripts/floor-report.mjs",
        ], {
            cwd: new URL("../../", import.meta.url), timeout: 40_000,
            env: { ...process.env, PLURNK_SERVICE_FILES_ITEMS: items },
        });
        assert.doesNotMatch(stdout, /floor report unavailable/);
        assert.match(stdout, /log rows\s+: [1-9]\d* rows, [1-9]\d* tok active, [1-9]\d* metadata/);
        if (items === "0") assert.doesNotMatch(stdout, /FIND \d+/, "disabled survey contributes no FIND weight");
        else assert.match(stdout, /FIND [1-9]\d*/, "enabled survey contributes its measured FIND weight");
        assert.match(stdout, /FLOOR \(approx\): ~[1-9]\d* tok/);
    }
});
});

describe("model-catalog-acp", () => {
test("{§session-model-selection}: ACP delivers route reasoning choices without creating a workspace or session", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/acp`;
    const initRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
        }),
    });
    assert.equal(initRes.status, 200);
    const connId = initRes.headers.get("acp-connection-id");
    assert.ok(connId);
    const sseAbort = new AbortController();
    t.after(() => sseAbort.abort());
    const sseRes = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream", "acp-connection-id": connId },
        signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    const query = { provider: "google", search: "gemini-3.7-flash", availability: "all" as const };
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "acp-connection-id": connId },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "_plurnk/action",
            params: { kind: "models.list", params: query },
        }),
    });
    assert.equal(response.status, 202);
    let rpc: { id?: number; result?: unknown; error?: unknown } | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of sseRes.body!) {
        buf += decoder.decode(chunk, { stream: true });
        for (const frame of buf.split("\n\n")) {
            if (!frame.startsWith("data: ")) continue;
            const parsed = JSON.parse(frame.slice(6)) as { id?: number; result?: unknown; error?: unknown };
            if (parsed.id === 1) {
                rpc = parsed;
                break;
            }
        }
        if (rpc !== undefined) break;
    }
    sseAbort.abort();
    assert.ok(rpc !== undefined);
    assert.equal(rpc.error, undefined, JSON.stringify(rpc));
    const page = Validator.assertModelCatalogPage(rpc.result);
    assert.deepEqual(page, daemon.listModels(query));
    const model = page.items.find((item) => item.model === "gemini-3.7-flash");
    assert.ok(model);
    assert.deepEqual(model.capabilities.efforts, ["adaptive", "low", "medium", "high"]);
    assert.deepEqual(await daemon.listWorkspaces(), []);
});
});

describe("reasoning-carrier", () => {
const reasoned = (dsl: string, reasoning: string): MockResponse => {
    const response = makeMockResponse(dsl);
    return { ...response, assistant: { ...response.assistant, reasoning } };
};

test("{§methods-invocation}: a turn's admitted reasoning rides its first model operation row, announced and read, and no other row repeats it", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        reasoned([
            PlurnkParser.frame("READ (workspace:///facts.txt)", null),
            PlurnkParser.frame("NOTE", "Answer from the facts."),
        ].join("\n\n"), "First turn reasoning."),
        reasoned(PlurnkParser.frame("SEND [200]", "Done."), "Second turn reasoning."),
    ] });
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "reasoning-carrier", projectRoot: null });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "reasoner" });
        const announced = new Map<number, { op: unknown; reasoning?: unknown }>();
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method !== "log/entry") return;
            const { entry } = params as { entry: { id: number; session_id: number; origin: string; op: unknown; reasoning?: unknown } };
            if (entry.session_id === sessionId && entry.origin === "model" && entry.op !== null && !announced.has(entry.id)) announced.set(entry.id, entry);
        });
        try {
            const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Report the facts." });
            await waitForDb(() => daemon.listSessionLoops({ workspaceId, sessionId }),
                (rows) => rows.some((row) => row.id === accepted.loopId && row.status === 200));
            const rows = (await daemon.readLog({ workspaceId, sessionId, loopId: accepted.loopId }))
                .filter((row) => row.origin === "model" && row.op !== null)
                .toSorted((left, right) => left.id - right.id);
            const carriers = [["READ", "First turn reasoning."], ["NOTE", null], ["SEND", "Second turn reasoning."]];
            assert.deepEqual(rows.map((row) => [row.op, row.reasoning ?? null]), carriers);
            assert.deepEqual(rows.map((row) => { const first = announced.get(row.id); return [first?.op, first?.reasoning ?? null]; }), carriers,
                "each row's first announcement already carries what a read returns");
        } finally {
            unsubscribe();
        }
    });
});
});

describe("reasoning-streaming", () => {
test("{§notifications}: provider SSE reaches standard ACP before the reasoning copy exists", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "streaming-reasoning");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Report the finding.");
        const translator = new SessionTranslator({ acpSessionId: "streaming", workspaceId, sessionId, origin: "http://acp.test" });
        const events: ReturnType<SessionTranslator["reasoning"]> = [];
        const ready = Promise.withResolvers<void>();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), reasoningEventNotify(_workspace, payload) {
            const translated = translator.reasoning(payload);
            events.push(...translated);
            if (translated.some(({ update }) => update.sessionUpdate === "agent_thought_chunk"
                && (update.content as { text?: string } | undefined)?.text === "Visible now.")) ready.resolve();
        } });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const send = (content: string, finish: string | null = null): void => controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ id: "streaming", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`,
        ));
        const provider = new AiSdkProvider({
            model: "m", url: "https://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: 0.2, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null }, reasoningResponseStyle: "think-tags",
            fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(stream) {
                controller = stream;
                send("<think>Visible now.");
            } }), { headers: { "Content-Type": "text/event-stream" } }),
        });
        const run = engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
        // The completion is held until the finally below, so reasoning that arrives at all arrived before it; the bound
        // only keeps a hang from outliving the test.
        const timer = setTimeout(() => ready.reject(new Error("ACP reasoning was withheld until completion")), HARNESS_WAIT_MS);
        try {
            await ready.promise;
            assert.deepEqual(await db.test_model_reasoning_resources.all({ session_id: sessionId }), [], "the live signal cannot originate from a not-yet-created copy");
            assert.equal(events.filter(({ update }) => update.sessionUpdate === "agent_thought_chunk").length, 1);
        } finally {
            clearTimeout(timer);
            send("</think>````SEND [200]\nDone.\n````", "stop");
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
            assert.equal((await run).status, 200);
        }
        assert.deepEqual(
            events
                .filter(({ update }) => update.sessionUpdate === "agent_thought_chunk")
                .map(({ update }) => (update as { content?: { text?: string } }).content?.text),
            ["Visible now."],
        );
        const rows = await db.test_model_reasoning_resources.all<{ content: string }>({ session_id: sessionId });
        assert.equal(rows[0].content, "Visible now.");
    } finally {
        await db.close();
    }
});

for (const style of ["structured", "think-tags"] as const) test(`{§notifications}: interleaved ${style} responses retain their session, packet and accounting owners`, async () => {
    const db = await openMigrated();
    const cancellation = new AbortController();
    const pending: Array<Promise<unknown>> = [];
    try {
        const workspaceId = await insertWorkspace(db, `concurrent-reasoning-${style}`);
        const sessions: Array<{ name: string; sessionId: number; loopId: number }> = [];
        for (const name of ["alpha", "bravo", "charlie"]) {
            const sessionId = await insertSession(db, workspaceId, null, name);
            const loopId = await insertLoop(db, sessionId, 1, `Report ONLY_${name}.`);
            sessions.push({ name, sessionId, loopId });
        }
        const observed = new Map<number, string[]>();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), reasoningEventNotify(_workspace, event) {
            if (event.phase !== "content") return;
            const deltas = observed.get(event.sessionId) ?? [];
            deltas.push(event.delta);
            observed.set(event.sessionId, deltas);
        } });
        const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
        const requests = new Map<string, Record<string, unknown>>();
        const provider = new AiSdkProvider({
            model: "m", url: "https://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: 0.2, repeatPenalty: null, retryAttempts: 0,
            effort: { mode: "adaptive", budget: null }, rawBody: true,
            reasoningResponseStyle: style === "think-tags" ? "think-tags" : "verbatim",
            supportsSlotPinning: true, slotCount: 2,
            fetch: async (_url, init) => {
                const body = JSON.parse(requestBody(init));
                const input = JSON.stringify(body.messages);
                const owners = sessions.filter(({ name }) => input.includes(`ONLY_${name}`));
                assert.equal(owners.length, 1, "each request carries exactly its own prompt");
                const { name } = owners[0];
                requests.set(name, body);
                return new Response(new ReadableStream<Uint8Array>({ start(stream) {
                    streams.set(name, stream);
                } }), { headers: { "Content-Type": "text/event-stream" } });
            },
        });
        const running = sessions.map(({ sessionId, loopId }) => engine.runTurn({
            provider, workspaceId, sessionId, loopId, messages: [], signal: cancellation.signal,
        }));
        pending.push(...running);
        const emit = (name: string, delta: object, finish: string | null = null, usage?: object): void => {
            streams.get(name)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                id: "shared-server-id", object: "chat.completion.chunk", created: 1, model: "m",
                choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
            })}\n\n`));
        };
        await waitFor(() => [...streams.keys()], (names) => names.length === sessions.length);
        assert.equal(new Set([...requests.values()].map(({ id_slot }) => id_slot)).size, 2,
            "shared backend affinity does not become a response ownership key");
        for (const { name } of sessions.toReversed()) emit(name, style === "structured"
            ? { reasoning_content: `Thinking ${name}.` } : { content: `<think>Thinking ${name}.` });
        await waitFor(() => [...observed.keys()], (ids) => ids.length === sessions.length);
        for (const { name, sessionId } of sessions) assert.equal(observed.get(sessionId)!.join(""), `Thinking ${name}.`);
        // Finish in a different order from admission while all three streams overlap.
        for (const index of [1, 2, 0]) {
            const { name } = sessions[index];
            emit(name, { content: `${style === "think-tags" ? "</think>" : ""}\`\`\`\`SEND [200]
ONLY_${name}
\`\`\`\`` }, "stop", {
                prompt_tokens: 10 + index, completion_tokens: 20 + index, total_tokens: 30 + 2 * index,
            });
            streams.get(name)!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            streams.get(name)!.close();
        }
        const results = await Promise.all(running);
        for (const [index, { turnId, status }] of results.entries()) {
            const { name, sessionId } = sessions[index];
            assert.equal(status, 200);
            const calls = await db.test_model_calls.all<{ response: string }>({ turn_id: turnId });
            const response = JSON.parse(calls[0].response);
            assert.equal(response.assistant.reasoning, `Thinking ${name}.`);
            assert.equal(response.assistant.content, `\`\`\`\`SEND [200]\nONLY_${name}
\`\`\`\``);
            for (const other of sessions.filter((session) => session.sessionId !== sessionId)) {
                assert.ok(!JSON.stringify(response.rawBody).includes(other.name), "forensic raw chunks belong to this request only");
            }
            const resources = await db.test_model_reasoning_resources.all<{ content: string }>({ session_id: sessionId });
            assert.deepEqual(resources.map(({ content }) => content), [`Thinking ${name}.`]);
            const accounting = await db.test_provider_requests.all<{ usage_input: number; usage_output: number }>({ turn_id: turnId });
            assert.deepEqual(accounting.map(({ usage_input, usage_output }) => [usage_input, usage_output]), [[10 + index, 20 + index]]);
        }
    } finally {
        cancellation.abort();
        await Promise.allSettled(pending);
        await db.close();
    }
});
});

describe("usage-reasoning", () => {
for (const [label, reasoning, reasoningLine] of [
    ["readable", "thought hard", "thought hard"],
    ["hidden", null, "(provider reported 37 reasoning tokens; no readable reasoning content returned)"],
] as const) test(`{§provider-request-accounting} output ${label} reasoning usage is persisted and exposed by the digest`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-usage-reasoning-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, `ur-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const resp: MockResponse = {
            assistant: { content: "", reasoning, ops: [completeStmt("done")] },
            usage: {
                inputTokens: 100,
                outputTokens: 57,
                totalTokens: 157,
                inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0 },
                outputTokenDetails: { textTokens: 20, reasoningTokens: 37 },
            },
        };
        const provider = new Mock({ contextWindow: 100000, responses: [resp] });
        const r = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const requests = await db.test_provider_requests.all<{
            usage_output: number;
            usage_output_text: number;
            usage_output_reasoning: number;
        }>({ turn_id: r.turnId });
        assert.deepEqual(requests.map(({ usage_output, usage_output_text, usage_output_reasoning }) => ({
            usage_output,
            usage_output_text,
            usage_output_reasoning,
        })), [{
            usage_output: 57,
            usage_output_text: 20,
            usage_output_reasoning: 37,
        }]);
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const reasoningMarkdown = await readFile(join(digestDir, "reasoning.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turns: Array<{ accounting: { usage: { outputTokenDetails: { reasoningTokens: number } } } }>;
        };
        assert.match(markdown, /input=100 output=57 reasoning=37 cache-read=0/);
        assert.match(reasoningMarkdown, new RegExp(reasoningLine.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal(json.turns.at(-1)?.accounting.usage.outputTokenDetails.reasoningTokens, 37,
            "the packet-bearing model turn retains reasoning usage after packetless initialization");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
});
