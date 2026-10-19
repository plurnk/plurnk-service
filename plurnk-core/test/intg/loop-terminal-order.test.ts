// {§notifications-loop-terminated} A held gate's settlement is delivered before its loop's one terminal: each gate kind,
// each holder of the gate — the loop's running turn, or the loop parked with no drain — and each way that holder's loop
// ends.
import test from "node:test";
import assert from "node:assert/strict";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import type Daemon from "../../src/server/Daemon.ts";
import { ownWorker } from "./_approval.ts";
import StreamMock from "./_stream-mock.ts";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

type Ending = "cancellation" | "timeout" | "shutdown";
type Ends = { daemon: Daemon; workspaceId: number; workerId: number; expire: () => void };

// A parked loop neither executes nor ends at shutdown: cancellation is the way it ends.
const GATES = {
    proposal: {
        emission: "````sh\necho held\n````",
        op: "sh",
        holders: { turn: ["cancellation", "timeout", "shutdown"] },
    },
    interaction: {
        emission: "````question\n{\"message\":\"Which branch?\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}}}}\n````\n````WAIT\nAwaiting an answer.\n````",
        op: "question",
        holders: { turn: ["cancellation", "timeout", "shutdown"], parked: ["cancellation"] },
    },
} as const satisfies Record<string, { emission: string; op: string; holders: Partial<Record<"turn" | "parked", readonly Ending[]>> }>;

const END: Record<Ending, (ends: Ends) => Promise<void>> = {
    cancellation: ({ daemon, workspaceId, workerId }) => daemon.cancelWorker({ workspaceId, workerId, reason: "user_escape" }),
    timeout: async ({ expire }) => expire(),
    shutdown: ({ daemon }) => daemon.stop(),
};

for (const [kind, { emission, op, holders }] of Object.entries(GATES)) {
    for (const [holder, endings] of Object.entries(holders)) {
        for (const ending of endings) {
            test(`{§notifications-loop-terminated}: ${kind === "proposal" ? "a proposal" : "a client interaction"} held by ${holder === "turn" ? "a running turn" : "a parked loop"}, ended by ${ending}, settles before its loop's one terminal`, async (t) => {
                // The turn holds an interaction through its settlement window; a zero window parks the loop at once.
                const window = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
                process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = holder === "turn" ? "60000" : "0";
                t.after(() => {
                    if (window === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
                    else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = window;
                });
                // The allowance runs out on cue: the loop's own timer callback, fired once its gate is held.
                const startExecution = LoopLifecycle.prototype.startExecution;
                const timers = new Map<number, () => void>();
                t.mock.method(LoopLifecycle.prototype, "startExecution", function (this: LoopLifecycle, loopId: number, budgetMs: number, onTimeout: () => void) {
                    timers.set(loopId, onTimeout);
                    return startExecution.call(this, loopId, budgetMs, onTimeout);
                });
                const provider = new StreamMock({ contextWindow: 100_000, responses: [makeMockResponse(emission)] });
                await withDaemon(provider, async (db, daemon) => {
                    const { workspaceId } = await daemon.createWorkspace({ name: `terminal-order-${kind}-${holder}-${ending}` });
                    const workerId = await namedModelWorker(daemon, workspaceId, "main");
                    await ownWorker(db, workspaceId, workerId);
                    const order: string[] = [];
                    const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
                        const entry = (params as { entry?: { op?: string; status_rx?: number } }).entry;
                        if (method === "log/entry" && entry?.op === op && (entry.status_rx ?? 0) >= 400) order.push("settled");
                        if (method === "stream/concluded" && kind === "interaction") order.push("settled");
                        if (method === "loop/terminated") order.push(`terminated ${(params as { loopId: number }).loopId}`);
                    });
                    try {
                        const { loopId, drainPromise } = await daemon.inject({
                            workspaceId, workerId, prompt: "Go.",
                            providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                            effort: "adaptive", systemPrompt: "test system",
                        });
                        const pending = async (): Promise<number> => (kind === "proposal"
                            ? await daemon.pendingProposals(workspaceId) : await daemon.pendingClientInteractions(workspaceId)).length;
                        await waitForDb(pending, (count) => count === 1);
                        if (holder === "parked") {
                            assert.ok(drainPromise !== undefined, "the injection started the worker's drain");
                            await drainPromise;
                            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 202, "the loop is parked");
                        }
                        const expire = (): void => (timers.get(loopId) ?? assert.fail("the loop never started executing"))();
                        await END[ending]({ daemon, workspaceId, workerId, expire });
                        const terminated = `terminated ${loopId}`;
                        await waitForDb(async () => order, (events) => events.includes(terminated));
                        // Stopped, the daemon has settled every producer: a second terminal would be here by now.
                        await daemon.stop();
                        const settled = order.indexOf("settled");
                        assert.ok(settled >= 0 && settled < order.indexOf(terminated), `the gate settles before its loop's terminal: ${order.join(" > ")}`);
                        assert.equal(order.filter((event) => event === terminated).length, 1, `the loop announces one terminal: ${order.join(" > ")}`);
                    } finally {
                        off();
                    }
                });
            });
        }
    }
}
