import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type ProviderAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { connect, flush, makeMockResponse, rpcCall, runLoopToTerminal, subscribeNotifications, withDaemon } from "./_rpc.ts";

const provider = (name: string, model: string): ProviderAlias => ({
    alias: `${name}-${crypto.randomUUID()}`,
    provider: "openai",
    model,
});

type LoopRow = {
    id: number;
    worker_id: number;
    provider_spec: string;
    child_provider_spec: string;
    status: number;
};

const withConfiguredChild = async <T>(spec: ProviderAlias, run: () => Promise<T>): Promise<T> => {
    const declaration = `PLURNK_MODEL_${spec.alias}`;
    const priorDeclaration = process.env[declaration];
    const priorSelection = process.env.PLURNK_MODEL_CHILD;
    process.env[declaration] = `${spec.provider}/${spec.model}`;
    process.env.PLURNK_MODEL_CHILD = spec.alias;
    try {
        return await run();
    } finally {
        if (priorDeclaration === undefined) delete process.env[declaration];
        else process.env[declaration] = priorDeclaration;
        if (priorSelection === undefined) delete process.env.PLURNK_MODEL_CHILD;
        else process.env.PLURNK_MODEL_CHILD = priorSelection;
    }
};

test("{§methods-loop-run-child-provider}: a smaller WORK provider carries through every descendant", async () => {
    const parentSpec = provider("parent", "large-parent");
    const childSpec = provider("child", "smaller-child");
    const parent = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse("<|WORK(worker://child)>delegate once<WORK|>\n<|SEND[202]<-1>>waiting<SEND|>"),
            makeMockResponse("<|SEND[200]>tree complete<SEND|>"),
        ],
    });
    const child = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("<|WORK(worker://grandchild)>delegate again<WORK|>\n<|SEND[202]<-1>>waiting<SEND|>"),
            makeMockResponse("<|SEND[200]>leaf complete<SEND|>"),
            makeMockResponse("<|SEND[200]>child complete<SEND|>"),
        ],
    });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `child-policy-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "build a two-level worker tree",
                alias: parentSpec.alias,
                model: `${parentSpec.provider}/${parentSpec.model}`,
                childAlias: childSpec.alias,
                childModel: `${childSpec.provider}/${childSpec.model}`,
                flags: { auto: true },
            });
            assert.equal(result.finalStatus, 200);
            const workerId = result.modelWorkerId;
            assert.ok(workerId !== undefined);
            const workers = await db.test_workers_with_parent.all<{ id: number; parent_worker_id: number | null; origin: string }>({});
            const root = workers.find(({ id }) => id === workerId);
            const first = workers.find(({ parent_worker_id: parentId }) => parentId === root?.id);
            const second = workers.find(({ parent_worker_id: parentId }) => parentId === first?.id);
            assert.ok(root && first && second, "WORK created the complete root → child → grandchild topology");

            const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ provider_spec }) => provider_spec !== "null");
            const rootLoop = loops.find(({ worker_id: owner }) => owner === root.id);
            const childLoops = loops.filter(({ worker_id: owner }) => owner === first.id || owner === second.id);
            assert.deepEqual(JSON.parse(rootLoop?.provider_spec ?? "null"), parentSpec, "only the client-started root uses the parent provider");
            assert.deepEqual(JSON.parse(rootLoop?.child_provider_spec ?? "null"), childSpec, "the root persists its resolved spawn policy");
            assert.equal(childLoops.length, 2);
            for (const loop of childLoops) {
                assert.deepEqual(JSON.parse(loop.provider_spec), childSpec, "every descendant runs on the selected child provider");
                assert.deepEqual(JSON.parse(loop.child_provider_spec), childSpec, "every descendant carries the same policy deeper");
            }
        } finally {
            ws.close();
        }
    });
});

test("{§methods-loop-run-child-provider}: the configured child alias supplies an omitted run policy", async () => {
    const parentSpec = provider("configured-parent", "configured-parent-model");
    const childSpec = provider("configured-child", "configured-child-model");
    const parent = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("<|WORK(worker://child)>use configured child<WORK|>\n<|SEND[202]<-1>>waiting<SEND|>"),
            makeMockResponse("<|SEND[200]>parent complete<SEND|>"),
        ],
    });
    const child = new Mock({
        contextWindow: 8192,
        responses: [makeMockResponse("<|SEND[200]>child complete<SEND|>")],
    });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withConfiguredChild(childSpec, async () => {
        await withDaemon(null, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `configured-child-${crypto.randomUUID()}` });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "use the configured child provider",
                    alias: parentSpec.alias,
                    model: `${parentSpec.provider}/${parentSpec.model}`,
                    flags: { auto: true },
                });
                assert.equal(result.finalStatus, 200);
                const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ provider_spec }) => provider_spec !== "null");
                const root = loops.find(({ id }) => id === result.loopId);
                const descendant = loops.find(({ id }) => id !== result.loopId);
                assert.deepEqual(JSON.parse(root?.child_provider_spec ?? "null"), childSpec);
                assert.deepEqual(JSON.parse(descendant?.provider_spec ?? "null"), childSpec);
            } finally {
                ws.close();
            }
        });
    });
});

test("{§methods-loop-run-child-provider}: explicit inherit overrides configuration and follows the spawning loop", async () => {
    const spec = provider("inherit", "same-through-tree");
    const configuredSpec = provider("ignored", "configured-child-must-not-run");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("<|WORK(worker://child)>do it<WORK|>\n<|SEND[202]<-1>>waiting<SEND|>"),
            makeMockResponse("<|SEND[200]>child complete<SEND|>"),
            makeMockResponse("<|SEND[200]>parent complete<SEND|>"),
        ],
    });
    ProviderInstantiate.registerInstance(mock, spec);

    await withConfiguredChild(configuredSpec, async () => {
        await withDaemon(null, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `inherit-policy-${crypto.randomUUID()}` });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "spawn one inherited child",
                    alias: spec.alias,
                    model: `${spec.provider}/${spec.model}`,
                    childAlias: null,
                    flags: { auto: true },
                });
                assert.equal(result.finalStatus, 200);
                const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ provider_spec }) => provider_spec !== "null");
                assert.equal(loops.length, 2);
                for (const loop of loops) {
                    assert.deepEqual(JSON.parse(loop.provider_spec), spec);
                    assert.equal(JSON.parse(loop.child_provider_spec), null, "inherit remains absence rather than becoming a sticky explicit alias");
                }
            } finally {
                ws.close();
            }
        });
    });
});

test("{§methods-loop-run-child-provider}: an oversized FORK fails as an ordinary child loop", async () => {
    const parentSpec = provider("fork-parent", "large-parent");
    const childSpec = provider("fork-child", "tiny-child");
    const parent = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse("<|FORK(worker://branch)>continue with inherited history<FORK|>\n<|SEND[202]<-1>>waiting<SEND|>"),
            makeMockResponse("<|SEND[200]>observed child failure<SEND|>"),
        ],
    });
    const child = new Mock({ contextWindow: 4096, responses: [] });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `fork-capacity-${crypto.randomUUID()}` });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "fork work to a much smaller child",
                alias: parentSpec.alias,
                model: `${parentSpec.provider}/${parentSpec.model}`,
                childAlias: childSpec.alias,
                childModel: `${childSpec.provider}/${childSpec.model}`,
                flags: { auto: true },
            });
            assert.equal(result.finalStatus, 200, "the parent observes the failed child and can conclude normally");
            await flush();
            const loops = await db.test_all_loops.all<LoopRow>({});
            const selectedChildLoop = loops.find(({ provider_spec }) => provider_spec === JSON.stringify(childSpec));
            assert.ok(selectedChildLoop, "FORK created a real child loop on the selected provider before admission");
            assert.equal(selectedChildLoop.status, 413, "universal packet admission, not preflight spawn logic, rejects the inherited packet");
            const event = (terminated() as Array<{ loopId: number; result: { status: number } }>).find(({ loopId }) => loopId === selectedChildLoop.id);
            assert.equal(event?.result.status, 413, "the ordinary child terminal result carries the admission failure");
        } finally {
            ws.close();
        }
    });
});
