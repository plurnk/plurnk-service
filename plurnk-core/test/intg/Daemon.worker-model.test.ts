import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type ProviderAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import type { Db } from "../../src/core/Db.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

const provider = (name: string, model: string): ProviderAlias => ({
    alias: `${name}-${crypto.randomUUID()}`,
    provider: "openai",
    model,
});

type WorkerRow = { id: number; name: string; model_route_id: number | null; spawn_model_route_id: number | null };
type LoopRow = { id: number; worker_id: number; model_route_id: number | null; spawn_model_route_id: number | null; status: number };

const routeSpec = async (db: Db, routeId: number | null): Promise<ProviderAlias | null> => {
    if (routeId === null) return null;
    const row = await db.model_route_by_id.get<{ alias: string; provider: string; model: string; base_url: string }>({ id: routeId });
    if (row === undefined) throw new Error(`model_route ${routeId} is missing`);
    return { alias: row.alias, provider: row.provider, model: row.model, ...(row.base_url === "" ? {} : { baseUrl: row.base_url }) };
};

test("{§worker-model-selection}: an explicit selection persists onto the worker and an omitted selector continues it", async () => {
    const spec = provider("durable", "durable-model");
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
                alias: spec.alias,
                model: `${spec.provider}/${spec.model}`,
            });
            assert.equal(first.finalStatus, 200);
            const second = await runLoopToTerminal(ws, 3, { prompt: "second turn with no selector" });
            assert.equal(second.finalStatus, 200, "the omitted selector continues the worker's durable model instead of failing unconfigured");
            assert.equal(mock.remaining, 0, "both turns ran on the same selected model");

            const workers = await db.test_workers_with_model.all<WorkerRow>({});
            const modelWorker = workers.find(({ id }) => id === first.modelWorkerId);
            assert.ok(modelWorker !== undefined);
            assert.deepEqual(await routeSpec(db, modelWorker.model_route_id), spec, "the explicit selection persisted onto the worker");
            const loops = (await db.test_all_loops.all<LoopRow>({}))
                .filter(({ worker_id: owner }) => owner === first.modelWorkerId);
            assert.equal(loops.length, 2);
            assert.deepEqual(await routeSpec(db, loops[0].model_route_id), spec);
            assert.deepEqual(await routeSpec(db, loops[1].model_route_id), spec, "the continuation snapshots the worker's durable route");
        } finally {
            ws.close();
        }
    });
});

test("{§worker-model-selection}: the spawn override persists onto the worker and supplies a later delegation", async () => {
    const parentSpec = provider("spawn-parent", "spawn-parent-model");
    const childSpec = provider("spawn-child", "spawn-child-model");
    const parent = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("## SEND0 [200]\nfirst done"),
            makeMockResponse("## WORK0 (worker://kid)\ndelegate it\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\nsecond done"),
        ],
    });
    const child = new Mock({ contextWindow: 8_192, responses: [makeMockResponse("## SEND0 [200]\nkid done")] });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `spawn-override-${crypto.randomUUID()}` });
            const first = await runLoopToTerminal(ws, 2, {
                prompt: "first turn",
                alias: parentSpec.alias,
                model: `${parentSpec.provider}/${parentSpec.model}`,
                childAlias: childSpec.alias,
                childModel: `${childSpec.provider}/${childSpec.model}`,
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
            const loops = await db.test_all_loops.all<LoopRow>({});
            const delegated = loops.find(({ worker_id: owner }) => owner === kid.id);
            assert.deepEqual(await routeSpec(db, delegated?.model_route_id ?? null), childSpec);
        } finally {
            ws.close();
        }
    });
});

test("{§worker-model-selection}: an absent spawn override inherits the worker's own model by value", async () => {
    const spec = provider("inherit-worker", "same-through-tree");
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
                alias: spec.alias,
                model: `${spec.provider}/${spec.model}`,
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
        } finally {
            ws.close();
        }
    });
});

test("{§worker-model-selection}: a redeclared alias does not rewrite the worker's durable model", async () => {
    const spec = provider("mutable", "original-model");
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
                    alias: spec.alias,
                    model: `${spec.provider}/${spec.model}`,
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
