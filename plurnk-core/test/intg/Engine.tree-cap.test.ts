// {§turn-cap-counts-the-tree} — the ceiling is the worker tree's budget of model calls: BARE
// calls and a child's turns spend it, and a batch stops opening calls at the ceiling.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type ProviderAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { connect, flush, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

const declaredProviderEnv = new Map<string, string | undefined>();
test.afterEach(() => {
    for (const [key, value] of declaredProviderEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    declaredProviderEnv.clear();
});
const declaredProvider = (name: string, model: string): ProviderAlias => {
    const spec = { alias: `${name}-${crypto.randomUUID()}`, provider: "openai", model };
    const key = `PLURNK_MODEL_${spec.alias}`;
    declaredProviderEnv.set(key, process.env[key]);
    process.env[key] = `${spec.provider}/${spec.model}`;
    return spec;
};

test("{§turn-cap-counts-the-tree}: BARE calls spend the loop's budget, and a batch is refused past the ceiling", async () => {
    const parentSpec = declaredProvider("tree-cap-parent", "tree-cap-parent-model");
    const childSpec = declaredProvider("tree-cap-child", "tree-cap-child-model");
    const parent = new Mock({ contextWindow: 16_384, responses: [
        makeMockResponse("````BARE\nfirst\n````\n\n````BARE\nsecond\n````\n\n````BARE\nthird\n````\n\n````NOTE\nthree isolated calls\n````"),
        makeMockResponse("````NOTE\nstill going\n````"),
        makeMockResponse("````NOTE\nstill going\n````"),
    ] });
    const child = new Mock({ contextWindow: 8_192, responses: [
        { assistant: { content: "one", reasoning: null } },
        { assistant: { content: "two", reasoning: null } },
        { assistant: { content: "three", reasoning: null } },
    ] });
    ProviderInstantiate.registerInstance(parent, parentSpec);
    ProviderInstantiate.registerInstance(child, childSpec);
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tree-cap-bare-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "spend the budget on isolated calls",
                selector: parentSpec.alias,
                childSelector: childSpec.alias,
                maxTurns: 3,
                policy: { proposals: "accept" },
            }, { timeoutMs: 20_000 });
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429, "the tree's ceiling ends the loop at 429 {§loop-terminals}");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
            const bares = rows.filter((row) => row.op === "BARE" && row.origin === "model");
            assert.deepEqual(bares.map((row) => row.status_rx), [200, 200, 429],
                "turn 1 is call one; the first two BAREs are calls two and three; the third meets the ceiling and makes no call");
            const refused = JSON.parse(bares[2]!.rx) as { problem: { type: string; treeModelCalls: number; maximumTurns: number } };
            assert.match(refused.problem.type, /\/max-turns$/u);
            assert.deepEqual([refused.problem.treeModelCalls, refused.problem.maximumTurns], [3, 3]);
            assert.equal(child.received.length, 2, "the refused BARE never reached the child provider");
            assert.equal(parent.remaining, 2, "the parent's second turn was never requested: the ceiling was met before it");
        } finally { ws.close(); }
    });
});

test("{§turn-cap-counts-the-tree}: a child's turns spend the parent's budget", async () => {
    const mock = new Mock({ contextWindow: 16_384, responses: [
        makeMockResponse("````WORK (worker://helper)\nDo one small thing.\n````\n\n````WAIT\ndelegated\n````", 10),
        makeMockResponse("````NOTE\nchild working\n````", 10),
        makeMockResponse("````KILL\nchild done\n````", 10),
        makeMockResponse("````NOTE\nparent continues\n````", 10),
        makeMockResponse("````NOTE\nnever requested: the tree's ceiling is met first\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tree-cap-child-${crypto.randomUUID()}` });
            const result = await runLoopToTerminal(ws, 2, { prompt: "delegate", maxTurns: 4, policy: { proposals: "accept" } }, { timeoutMs: 20_000 });
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 429);
            const problem = (result.result as { problem?: { treeModelCalls?: number; maximumTurns?: number } }).problem;
            assert.deepEqual([problem?.treeModelCalls, problem?.maximumTurns], [4, 4], "two parent turns and two child turns met a ceiling of four");
            const parentTurns = await db.lifecycle_loop_model_turn_count.get<{ count: number }>({ loop_id: result.loopId });
            assert.equal(parentTurns?.count, 2, "the parent itself ran two turns; the child's two were counted against the same budget");
            assert.equal(mock.remaining, 1, "the fifth response was never requested");
        } finally { ws.close(); }
    });
});
