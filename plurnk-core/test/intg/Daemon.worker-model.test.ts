import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type ProviderAlias, type ProviderSpec } from "@plurnk/plurnk-providers";
import type { ReasoningPolicy } from "@plurnk/plurnk-contracts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Daemon from "../../src/server/Daemon.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated } from "./_helpers.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

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

type WorkerRow = { id: number; name: string; model_route_id: number | null; spawn_model_route_id: number | null; reasoning_policy: ReasoningPolicy | null };
type LoopRow = { id: number; worker_id: number; model_route_id: number | null; spawn_model_route_id: number | null; reasoning_policy: ReasoningPolicy | null; status: number };

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

test("{§worker-model-selection}: an explicit selection persists onto the worker and an omitted selector continues it", async () => {
    const spec = declaredProvider("durable", "durable-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("## SEND0 [200]\nfirst"),
            makeMockResponse("## SEND0 [200]\nsecond"),
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
            assert.equal(second.finalStatus, 200, "the omitted selector continues the worker's durable model instead of failing unconfigured");
            assert.equal(mock.remaining, 0, "both turns ran on the same selected model");

            const workers = await db.test_workers_with_model.all<WorkerRow>({});
            const modelWorker = workers.find(({ id }) => id === first.modelWorkerId);
            assert.ok(modelWorker !== undefined);
            assert.deepEqual(await routeSpec(db, modelWorker.model_route_id), spec, "the explicit selection persisted onto the worker");
            assert.equal(modelWorker.reasoning_policy, "adaptive", "the alias-scoped default seeds the worker once");
            const loops = (await db.test_all_loops.all<LoopRow>({}))
                .filter(({ worker_id: owner }) => owner === first.modelWorkerId);
            assert.equal(loops.length, 2);
            assert.deepEqual(await routeSpec(db, loops[0].model_route_id), spec);
            assert.deepEqual(await routeSpec(db, loops[1].model_route_id), spec, "the continuation snapshots the worker's durable route");
            assert.deepEqual(loops.map(({ reasoning_policy }) => reasoning_policy), ["adaptive", "adaptive"]);
        } finally {
            ws.close();
        }
    });
});

test("{§worker-model-selection}: an exact provider/model selector persists without fabricated alias provenance", async () => {
    const spec: ProviderSpec = { provider: "openai", model: `direct-${crypto.randomUUID()}` };
    const bootAlias = `boot-${crypto.randomUUID()}`;
    for (const [key, value] of Object.entries({
        PLURNK_MODEL: bootAlias,
        [`PLURNK_MODEL_${bootAlias}`]: "openai/unrelated-local-model",
        [`PLURNK_PROVIDERS_GBNF_${bootAlias}`]: "plurnk.qwen.gbnf",
    })) {
        declaredProviderEnv.set(key, process.env[key]);
        process.env[key] = value;
    }
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("## SEND0 [200]\ndirect route complete")],
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
            const workers = await db.test_workers_with_model.all<WorkerRow>({});
            const worker = workers.find(({ id }) => id === result.modelWorkerId);
            assert.ok(worker !== undefined);
            assert.deepEqual(await routeSpec(db, worker.model_route_id), spec);
            const stored = await db.model_route_by_id.get<{ alias: string | null }>({ id: worker.model_route_id });
            assert.equal(stored?.alias, null, "database identity records the absence of an alias directly");
            assert.equal(mock.remaining, 0, "the unrelated boot alias's GBNF scope did not intercept the direct route");
        } finally {
            ws.close();
        }
    });
});

test("{§worker-model-selection}: worker model actions never disclose daemon endpoint configuration", async () => {
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
        const workerId = await daemon.ensureModelWorker(envelope.workspaceId);
        const selected = await daemon.setWorkerModel({
            workspaceId: envelope.workspaceId,
            workerId,
            selector: alias,
        });
        assert.deepEqual(selected, {
            alias,
            provider: spec.provider,
            model: spec.model,
        });
        assert.equal("baseUrl" in selected, false);

        const projected = await daemon.readWorkerModel({
            workspaceId: envelope.workspaceId,
            workerId,
        });
        assert.deepEqual(projected.model, selected);
        assert.equal(projected.model !== null && "baseUrl" in projected.model, false);
    });
});

test("{§worker-reasoning-policy}: reasoning controls seed the daemon-default model before the first loop", async () => {
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
            const inspectedWorker = await daemon.ensureModelWorker(workspace.workspaceId);
            assert.deepEqual(await daemon.readWorkerReasoning({
                workspaceId: workspace.workspaceId,
                workerId: inspectedWorker,
            }), {
                policy: "adaptive",
                supportedPolicies: ["off", "adaptive", "low", "medium", "high"],
            });

            const selectedWorkspace = await daemon.createWorkspace({
                name: `reasoning-selected-${crypto.randomUUID()}`,
                projectRoot: null,
            });
            const selectedWorker = await daemon.ensureModelWorker(selectedWorkspace.workspaceId);
            assert.equal((await daemon.setWorkerReasoning({
                workspaceId: selectedWorkspace.workspaceId,
                workerId: selectedWorker,
                policy: "high",
            })).policy, "high");

            const rows = await db.test_workers_with_model.all<WorkerRow>({});
            for (const workerId of [inspectedWorker, selectedWorker]) {
                const row = rows.find(({ id }) => id === workerId);
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

test("{§worker-reasoning-policy}: alias configuration seeds once, explicit policy persists, and loops snapshot it", async () => {
    const spec = declaredProvider("reasoning-durable", "reasoning-durable-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("## SEND0 [200]\nfixed reasoning")],
    });
    const aliasKnob = `PLURNK_PROVIDERS_REASONING_${spec.alias}`;
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
        const workerId = await first.ensureModelWorker(workspace.workspaceId);
        await first.setWorkerModel({
            workspaceId: workspace.workspaceId,
            workerId,
            selector: spec.alias,
        });
        assert.deepEqual(await first.readWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
        }), {
            policy: "low",
            supportedPolicies: ["off", "adaptive", "low", "medium", "high"],
        });

        process.env[aliasKnob] = "adaptive";
        const selected = await first.setWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
            policy: "high",
        });
        assert.equal(selected.policy, "high");
        const accepted = await first.runLoop({
            workspaceId: workspace.workspaceId,
            workerId,
            prompt: "snapshot the durable policy",
        });
        for (let i = 0; i < 100; i++) {
            const row = await db.test_get_loop_status.get<{ status: number }>({ id: accepted.loopId });
            if (row?.status === 200) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const loops = await db.test_all_loops.all<LoopRow>({});
        assert.equal(loops.find(({ id }) => id === accepted.loopId)?.reasoning_policy, "high");
        await first.stop();
        first = undefined;

        second = new Daemon({ db, provider: null });
        await second.start();
        assert.equal((await second.readWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
        })).policy, "high", "restart reads the worker's durable value, not the changed env seed");
    } finally {
        if (first !== undefined) await first.stop();
        if (second !== undefined) await second.stop();
        await db.close();
        if (previous === undefined) delete process.env[aliasKnob];
        else process.env[aliasKnob] = previous;
    }
});

test("{§worker-reasoning-policy}: unsupported policy fails precisely and leaves durable state unchanged", async () => {
    const spec = declaredProvider("reasoning-limited", "reasoning-limited-model");
    const limited = new Mock({ contextWindow: 16_384, responses: [] });
    Object.defineProperty(limited, "supportedReasoningPolicies", {
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
        const workerId = await daemon.ensureModelWorker(workspace.workspaceId);
        await daemon.setWorkerModel({
            workspaceId: workspace.workspaceId,
            workerId,
            selector: spec.alias,
        });
        const refused = await daemon.setWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
            policy: "medium",
        }).then(
            () => null,
            (error: unknown) => error as { result?: { problem?: { type?: string; status?: number }; supportedReasoningPolicies?: unknown } },
        );
        assert.equal(refused?.result?.problem?.status, 409);
        assert.equal(
            refused?.result?.problem?.type,
            "https://problems.plurnk.dev/daemon/provider/reasoning-policy-unsupported",
        );
        assert.equal((await daemon.readWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
        })).policy, "adaptive", "a rejected selection does not mutate the worker");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§worker-model-selection}: a client-created branch copies durable generation policy by value", async () => {
    const spec = declaredProvider("branch-parent", "branch-parent-model");
    const childSpec = declaredProvider("branch-child", "branch-child-model");
    const parent = new Mock({ contextWindow: 16_384, responses: [] });
    const child = new Mock({ contextWindow: 16_384, responses: [] });
    Object.defineProperty(child, "supportedReasoningPolicies", {
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
        const workerId = await daemon.ensureModelWorker(workspace.workspaceId);
        await daemon.setWorkerModel({
            workspaceId: workspace.workspaceId,
            workerId,
            selector: spec.alias,
        });
        await daemon.setWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
            policy: "high",
        });
        await daemon.setWorkerSpawnModel({
            workspaceId: workspace.workspaceId,
            workerId,
            selector: childSpec.alias,
        });
        assert.deepEqual((await daemon.readWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
        })).supportedPolicies, ["adaptive", "high"], "worker choices are the root/spawn intersection");

        const branch = await daemon.forkWorker({
            workspaceId: workspace.workspaceId,
            workerId,
            name: "policy-branch",
        });
        const rows = await db.test_workers_with_model.all<WorkerRow>({});
        const source = rows.find(({ id }) => id === workerId);
        const copied = rows.find(({ id }) => id === branch.workerId);
        assert.ok(source !== undefined && copied !== undefined);
        assert.equal(copied.model_route_id, source.model_route_id);
        assert.equal(copied.spawn_model_route_id, source.spawn_model_route_id);
        assert.equal(copied.reasoning_policy, "high");

        await daemon.setWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId,
            policy: "adaptive",
        });
        assert.equal((await daemon.readWorkerReasoning({
            workspaceId: workspace.workspaceId,
            workerId: branch.workerId,
        })).policy, "high", "the branch does not retain a live link to later source changes");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§worker-model-selection}: the spawn override persists onto the worker and supplies a later delegation", async () => {
    const parentSpec = declaredProvider("spawn-parent", "spawn-parent-model");
    const childSpec = declaredProvider("spawn-child", "spawn-child-model");
    const parent = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("## SEND0 [200]\nfirst done"),
            makeMockResponse("## WORK0 (worker://kid)\ndelegate it\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\nsecond done"),
        ],
    });
    const child = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("## SEND0 [200]\nkid done")] });
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
            assert.equal(child.remaining, 0, "the later delegation ran on the worker's durable spawn override");

            const workers = await db.test_workers_with_model.all<WorkerRow>({});
            const root = workers.find(({ id }) => id === first.modelWorkerId);
            const kid = workers.find(({ name }) => name === "kid");
            assert.ok(root !== undefined && kid !== undefined, "the delegation created a child worker");
            assert.deepEqual(await routeSpec(db, root.spawn_model_route_id), childSpec, "the explicit spawn override persisted onto the worker");
            assert.deepEqual(await routeSpec(db, kid.model_route_id), childSpec, "the child begins with the spawning loop's effective spawn model");
            assert.equal(kid.spawn_model_route_id, null, "the inherited child carries no override of its own");
            assert.equal(kid.reasoning_policy, "adaptive", "the child inherits the spawning loop's reasoning policy by value");
            const delegatedPrompt = (await daemon.readLog({
                workspaceId,
                workerId: kid.id,
            })).find((entry) => entry.op === "prompt");
            assert.equal(
                delegatedPrompt?.source,
                `worker://${root.name}`,
                "the child prompt retains its delegating worker's causal identity",
            );
            const loops = await db.test_all_loops.all<LoopRow>({});
            const delegated = loops.find(({ worker_id: owner }) => owner === kid.id);
            assert.deepEqual(await routeSpec(db, delegated?.model_route_id ?? null), childSpec);
        } finally {
            ws.close();
        }
    });
});

test("{§worker-model-selection}: an absent spawn override inherits the worker's own model by value", async () => {
    const spec = declaredProvider("inherit-worker", "same-through-tree");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("## WORK0 (worker://kid)\ndelegate it\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\ndone"),
            makeMockResponse("## SEND0 [200]\nkid done"),
        ],
    });
    ProviderInstantiate.registerInstance(mock, spec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `inherit-worker-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "spawn one kid",
                selector: spec.alias,
                flags: { auto: true },
            });
            assert.equal(result.finalStatus, 200);
            assert.equal(mock.remaining, 0);

            const workers = await db.test_workers_with_model.all<WorkerRow>({});
            const root = workers.find(({ id }) => id === result.modelWorkerId);
            const kid = workers.find(({ name }) => name === "kid");
            assert.ok(root !== undefined && kid !== undefined, "the delegation created a child worker");
            assert.deepEqual(await routeSpec(db, root.model_route_id), spec, "the explicit selection persisted onto the root worker");
            assert.equal(root.spawn_model_route_id, null, "no override: inherit remains absence");
            assert.deepEqual(await routeSpec(db, kid.model_route_id), spec, "the child inherits the parent's model by value");
            assert.equal(kid.spawn_model_route_id, null, "inherit does not become a sticky alias on the child");
            assert.equal(kid.reasoning_policy, "adaptive", "reasoning policy follows the model through the tree");
        } finally {
            ws.close();
        }
    });
});

test("{§worker-model-selection}: a redeclared alias does not rewrite the worker's durable model", async () => {
    const spec = declaredProvider("mutable", "original-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("## SEND0 [200]\nfirst"),
            makeMockResponse("## SEND0 [200]\nsecond"),
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
                assert.equal(second.finalStatus, 200, "the continuation keeps the worker's durable route despite the redeclared alias");
                assert.equal(mock.remaining, 0, "the redeclared alias never resolved into a different model");
                const loops = (await db.test_all_loops.all<LoopRow>({}))
                    .filter(({ worker_id: owner }) => owner === first.modelWorkerId);
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

test("{§worker-model-selection}: the worker's durable model and spawn override survive daemon restart", async () => {
    const spec = declaredProvider("restart-durable", "restart-durable-model");
    const childSpec = declaredProvider("restart-child", "restart-child-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("## SEND0 [200]\nbefore restart"),
            makeMockResponse("## WORK0 (worker://kid)\ndelegate\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\nafter restart"),
        ],
    });
    const child = new Mock({ contextWindow: 16_384, responses: [makeMockResponse("## SEND0 [200]\nkid done")] });
    ProviderInstantiate.registerInstance(mock, spec);
    ProviderInstantiate.registerInstance(child, childSpec);

    const db = await openMigrated();
    let first: Daemon | undefined;
    let second: Daemon | undefined;
    try {
        first = new Daemon({ db, provider: null });
        await first.start();
        const envelope = await first.createWorkspace({ name: `worker-model-restart-${crypto.randomUUID()}`, projectRoot: null });
        const workerId = await first.ensureModelWorker(envelope.workspaceId);
        await first.setWorkerModel({ workspaceId: envelope.workspaceId, workerId, selector: spec.alias });
        await first.setWorkerSpawnModel({ workspaceId: envelope.workspaceId, workerId, selector: childSpec.alias });
        const before = await first.runLoop({ workspaceId: envelope.workspaceId, workerId, prompt: "before restart", flags: { auto: true } });
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
        const after = await second.runLoop({ workspaceId: envelope.workspaceId, workerId, prompt: "after restart, no selector" });
        const settled: Array<{ loopId: number; result: { status: number } }> = [];
        second.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") settled.push(params as { loopId: number; result: { status: number } });
        });
        for (let i = 0; i < 100 && !settled.some((t) => t.loopId === after.loopId); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(settled.some((t) => t.loopId === after.loopId && t.result.status === 200), true, "the selector-less post-restart loop completed");
        assert.equal(mock.remaining, 0, "every turn ran on the worker's durable model");
        assert.equal(child.remaining, 0, "the post-restart delegation ran on the worker's durable spawn override");
        const workers = await db.test_workers_with_model.all<WorkerRow>({});
        const root = workers.find(({ id }) => id === workerId);
        const kid = workers.find(({ name }) => name === "kid");
        assert.deepEqual(await routeSpec(db, root?.model_route_id ?? null), spec, "the durable model survived restart");
        assert.deepEqual(await routeSpec(db, root?.spawn_model_route_id ?? null), childSpec, "the durable spawn override survived restart");
        assert.deepEqual(await routeSpec(db, kid?.model_route_id ?? null), childSpec, "the child began with the effective spawn model after restart");
    } finally {
        if (first !== undefined) await first.stop();
        if (second !== undefined) await second.stop();
        await db.close();
    }
});

test("{§worker-model-selection}: a selection while the worker holds a parked loop is a precise 409", async () => {
    const spec = declaredProvider("parked", "parked-model");
    const otherSpec = declaredProvider("switcheroo", "other-model");
    const mock = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("## EXEC0 [sh]\nsleep 30\n\n## SEND0 [202] <-1>\ndone"),
            makeMockResponse("## SEND0 [200]\nresumed"),
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
            const workerId = await daemon.ensureModelWorker(workspace.id);
            const started = await daemon.runLoop({
                workspaceId: workspace.id,
                workerId,
                prompt: "park",
                selector: spec.alias,
                flags: { auto: true },
            });
            // The EXEC stream keeps the loop parked (202); wait for that state.
            for (let i = 0; i < 100; i++) {
                const loops = await db.test_all_loops.all<{ status: number }>({});
                if (loops.some(({ status }) => status === 202)) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const loops = await db.test_all_loops.all<{ status: number }>({});
            assert.ok(loops.some(({ status }) => status === 202), "the loop parked on its live stream");

            const refused = await daemon.setWorkerModel({
                workspaceId: workspace.id,
                workerId,
                selector: otherSpec.alias,
            }).then(
                () => null,
                (error: unknown) => error as { result?: { problem?: { type?: string; status?: number } } },
            );
            const refusedProblem = refused?.result?.problem;
            assert.equal(refusedProblem?.status, 409, "a selection under a parked loop is refused precisely");
            assert.equal(refusedProblem?.type, "https://problems.plurnk.dev/daemon/worker/worker-loop-active");

            const reasoningRefused = await daemon.setWorkerReasoning({
                workspaceId: workspace.id,
                workerId,
                policy: "high",
            }).then(
                () => null,
                (error: unknown) => error as { result?: { problem?: { type?: string; status?: number } } },
            );
            assert.equal(reasoningRefused?.result?.problem?.status, 409);
            assert.equal(
                reasoningRefused?.result?.problem?.type,
                "https://problems.plurnk.dev/daemon/worker/worker-loop-active",
                "reasoning policy cannot mutate under a parked loop either",
            );

            await daemon.cancelDrain(workerId, "test");
            await new Promise((resolve) => setTimeout(resolve, 200));
            const selected = await daemon.setWorkerModel({
                workspaceId: workspace.id,
                workerId,
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
