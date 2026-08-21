import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type ProviderAlias, type ProviderSpec } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import type { Db } from "../../src/core/Db.ts";
import { connect, flush, makeMockResponse, rpcCall, runLoopToTerminal, subscribeNotifications, withDaemon } from "./_rpc.ts";

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

type LoopRow = {
    id: number;
    worker_id: number;
    model_route_id: number | null;
    spawn_model_route_id: number | null;
    status: number;
};

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
    const parentSpec = declaredProvider("parent", "large-parent");
    const childSpec = declaredProvider("child", "smaller-child");
    const parent = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse("## WORK0 (worker://child)\ndelegate once\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\ntree complete"),
        ],
    });
    const child = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("## WORK0 (worker://grandchild)\ndelegate again\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\nleaf complete"),
            makeMockResponse("## SEND0 [200]\nchild complete"),
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
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
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

            const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ model_route_id }) => model_route_id !== null);
            const rootLoop = loops.find(({ worker_id: owner }) => owner === root.id);
            const childLoops = loops.filter(({ worker_id: owner }) => owner === first.id || owner === second.id);
            assert.deepEqual(await routeSpec(db, rootLoop?.model_route_id ?? null), parentSpec, "only the client-started root uses the parent provider");
            assert.deepEqual(await routeSpec(db, rootLoop?.spawn_model_route_id ?? null), childSpec, "the root persists its resolved spawn policy");
            assert.equal(childLoops.length, 2);
            for (const loop of childLoops) {
                assert.deepEqual(await routeSpec(db, loop.model_route_id), childSpec, "every descendant runs on the selected child provider");
                assert.equal(
                    loop.spawn_model_route_id,
                    null,
                    "a descendant carries the effective model by value and inherits it deeper without a redundant override",
                );
            }
        } finally {
            ws.close();
        }
    });
});

test("{§methods-loop-run-child-provider}: the configured child alias supplies an omitted run policy", async () => {
    const parentSpec = declaredProvider("configured-parent", "configured-parent-model");
    const childSpec = declaredProvider("configured-child", "configured-child-model");
    const parent = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("## WORK0 (worker://child)\nuse configured child\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\nparent complete"),
        ],
    });
    const child = new Mock({
        contextWindow: 8192,
        responses: [makeMockResponse("## SEND0 [200]\nchild complete")],
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
                    selector: parentSpec.alias,
                    flags: { auto: true },
                });
                assert.equal(result.finalStatus, 200);
                const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ model_route_id }) => model_route_id !== null);
                const root = loops.find(({ id }) => id === result.loopId);
                const descendant = loops.find(({ id }) => id !== result.loopId);
                assert.deepEqual(await routeSpec(db, root?.spawn_model_route_id ?? null), childSpec);
                assert.deepEqual(await routeSpec(db, descendant?.model_route_id ?? null), childSpec);
            } finally {
                ws.close();
            }
        });
    });
});

test("{§bare-inference}: BARE consumes the loop's durable child provider without spawning a worker", async () => {
    const parentSpec = declaredProvider("bare-parent", "bare-parent-model");
    const childSpec = declaredProvider("bare-child", "bare-child-model");
    const parent = new Mock({
        contextWindow: 16_384,
        responses: [
            makeMockResponse("# PLAN0\nAsk the isolated factual question.\n\n## BARE0 [+fact]\nWhat is the capital of Germany?\n\n## SEND0 [102]\nReview the answer."),
            makeMockResponse("## SEND0 [200]\nThe isolated answer was reviewed."),
        ],
    });
    const child = new Mock({
        contextWindow: 8_192,
        responses: [{ assistant: { content: "Berlin", reasoning: null } }],
    });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);

    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `bare-child-policy-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "answer one isolated factual question",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
                flags: { auto: true },
            });
            assert.equal(result.finalStatus, 200);
            assert.equal(parent.remaining, 0);
            assert.equal(child.remaining, 0, "the selected child provider handled BARE");
            const rows = await db.test_log_entries_by_loop.all<{ op: string | null; rx: string }>({ loop_id: result.loopId });
            const bare = rows.find(({ op }) => op === "BARE");
            assert.equal((JSON.parse(bare?.rx ?? "null") as { content?: string } | null)?.content, "Berlin");
            const workers = await db.test_workers_with_parent.all<{ parent_worker_id: number | null }>({});
            assert.equal(workers.filter(({ parent_worker_id }) => parent_worker_id !== null).length, 0, "BARE creates no child worker");
        } finally {
            ws.close();
        }
    });
});

test("{§methods-loop-run-child-provider}: explicit inherit overrides configuration and follows the spawning loop", async () => {
    const spec = declaredProvider("inherit", "same-through-tree");
    const configuredSpec = declaredProvider("ignored", "configured-child-must-not-run");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("## WORK0 (worker://child)\ndo it\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\nchild complete"),
            makeMockResponse("## SEND0 [200]\nparent complete"),
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
                    selector: spec.alias,
                    childSelector: null,
                    flags: { auto: true },
                });
                assert.equal(result.finalStatus, 200);
                const loops = (await db.test_all_loops.all<LoopRow>({})).filter(({ model_route_id }) => model_route_id !== null);
                assert.equal(loops.length, 2);
                for (const loop of loops) {
                    assert.deepEqual(await routeSpec(db, loop.model_route_id), spec);
                    assert.equal(await routeSpec(db, loop.spawn_model_route_id), null, "inherit remains absence rather than becoming a sticky explicit alias");
                }
            } finally {
                ws.close();
            }
        });
    });
});

test("{§methods-loop-run-child-provider}: an oversized FORK fails as an ordinary child loop", async () => {
    const parentSpec = declaredProvider("fork-parent", "large-parent");
    const childSpec = declaredProvider("fork-child", "tiny-child");
    const parent = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse("## FORK0 (worker://branch)\ncontinue with inherited history\n\n## SEND0 [202] <-1>\nwaiting"),
            makeMockResponse("## SEND0 [200]\nobserved child failure"),
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
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
                flags: { auto: true },
            });
            assert.equal(result.finalStatus, 200, "the parent observes the failed child and can conclude normally");
            await flush();
            const loops = await db.test_all_loops.all<LoopRow>({});
            let selectedChildLoop: LoopRow | undefined;
            for (const loop of loops) {
                const loopSpec = await routeSpec(db, loop.model_route_id);
                if (loopSpec?.alias === childSpec.alias) {
                    selectedChildLoop = loop;
                    break;
                }
            }
            assert.ok(selectedChildLoop, "FORK created a real child loop on the selected provider before admission");
            assert.equal(selectedChildLoop.status, 413, "universal packet admission, not preflight spawn logic, rejects the inherited packet");
            const event = (terminated() as Array<{ loopId: number; result: { status: number } }>).find(({ loopId }) => loopId === selectedChildLoop.id);
            assert.equal(event?.result.status, 413, "the ordinary child terminal result carries the admission failure");
        } finally {
            ws.close();
        }
    });
});
