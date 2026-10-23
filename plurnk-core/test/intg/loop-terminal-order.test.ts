// {§notifications-loop-terminated} A held gate's settlement is delivered before its loop's one terminal: each gate kind,
// each holder of the gate — the loop's running turn, the loop parked with no drain, or an interaction left open while
// the loop works on — and each way that holder's loop ends.
import test from "node:test";
import assert from "node:assert/strict";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import type Daemon from "../../src/server/Daemon.ts";
import { ownWorker } from "./_approval.ts";
import StreamMock from "./_stream-mock.ts";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

type Ending = "cancellation" | "timeout" | "shutdown" | "turn ceiling";
type Holder = "turn" | "parked" | "stream";
type Ends = { daemon: Daemon; workspaceId: number; workerId: number; expire: () => void };

const QUESTION = "````question\n{\"message\":\"Which branch?\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}}}}\n````";
const WAIT = "````WAIT\nAwaiting an answer.\n````";

// A parked loop neither executes nor ends at shutdown: cancellation is the way it ends. A loop that left its interaction
// open works on, so its next call is held while it ends; the turn ceiling ends it before that call.
const CASES: ReadonlyArray<{ gate: "proposal" | "interaction"; op: string; holder: Holder; emission: string; endings: readonly Ending[] }> = [
    { gate: "proposal", op: "sh", holder: "turn", emission: "````sh\necho held\n````", endings: ["cancellation", "timeout", "shutdown"] },
    { gate: "interaction", op: "question", holder: "turn", emission: `${QUESTION}\n${WAIT}`, endings: ["cancellation", "timeout", "shutdown"] },
    { gate: "interaction", op: "question", holder: "parked", emission: `${QUESTION}\n${WAIT}`, endings: ["cancellation"] },
    { gate: "interaction", op: "question", holder: "stream", emission: QUESTION, endings: ["cancellation", "timeout", "shutdown", "turn ceiling"] },
];

const HOLDERS: Record<Holder, string> = { turn: "a running turn", parked: "a parked loop", stream: "a loop working on" };

const END: Record<Ending, (ends: Ends) => Promise<void>> = {
    cancellation: ({ daemon, workspaceId, workerId }) => daemon.cancelWorker({ workspaceId, workerId, reason: "user_escape" }),
    timeout: async ({ expire }) => expire(),
    shutdown: ({ daemon }) => daemon.stop(),
    "turn ceiling": async () => {},
};

for (const { gate, op, holder, emission, endings } of CASES) {
    for (const ending of endings) {
        test(`{§notifications-loop-terminated}: ${gate === "proposal" ? "a proposal" : "a client interaction"} held by ${HOLDERS[holder]}, ended by ${ending}, settles before its loop's one terminal`, async (t) => {
            // The turn holds an interaction through its settlement window; a zero window parks the loop at once, or, with
            // no WAIT, leaves the interaction open while the loop works on.
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
            const provider = new StreamMock({ contextWindow: 100_000, responses: [
                makeMockResponse(emission), makeMockResponse("````NOTE\nWorking on.\n````"),
            ] });
            // The working loop's next call is held until its ending is under way.
            const generate = provider.generate.bind(provider);
            const held = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            let calls = 0;
            t.mock.method(provider, "generate", async (...args: Parameters<StreamMock["generate"]>) => {
                if (holder === "stream" && ++calls === 2) {
                    held.resolve();
                    await release.promise;
                }
                return generate(...args);
            });
            t.after(() => release.resolve());
            await withDaemon(provider, async (db, daemon) => {
                const { workspaceId } = await daemon.createWorkspace({ name: `terminal-order-${gate}-${holder}-${ending}` });
                const workerId = await namedModelWorker(daemon, workspaceId, "main");
                await ownWorker(db, workspaceId, workerId);
                const order: string[] = [];
                const delayedAnnouncement = gate === "interaction" && ending === "timeout";
                const announcing = Promise.withResolvers<void>();
                const deliver = Promise.withResolvers<void>();
                const terminalReady = Promise.withResolvers<void>();
                if (delayedAnnouncement) {
                    const findSlept = db.drain_find_slept_loop.get.bind(db.drain_find_slept_loop);
                    t.mock.method(db.drain_find_slept_loop, "get", async (...args: Parameters<typeof findSlept>) => {
                        announcing.resolve();
                        await deliver.promise;
                        return findSlept(...args);
                    });
                    const observation = LoopLifecycle.prototype.observation;
                    t.mock.method(LoopLifecycle.prototype, "observation", async function (this: LoopLifecycle, id: number) {
                        const result = await observation.call(this, id);
                        if (result.terminatedAt !== null) {
                            await announcing.promise;
                            terminalReady.resolve();
                        }
                        return result;
                    });
                }
                const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
                    if (method === (gate === "proposal" ? "loop/proposal" : "loop/interaction")) order.push("held");
                    const entry = (params as { entry?: { op?: string; status_rx?: number } }).entry;
                    if (method === "log/entry" && entry?.op === op && (entry.status_rx ?? 0) >= 400) order.push("settled");
                    if (method === "stream/concluded" && gate === "interaction") order.push("settled");
                    if (method === "loop/terminated") order.push(`terminated ${(params as { loopId: number }).loopId}`);
                });
                try {
                    const { loopId, drainPromise } = await daemon.inject({
                        workspaceId, workerId, prompt: "Go.",
                        providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                        effort: "adaptive", systemPrompt: "test system",
                        ...(ending === "turn ceiling" ? { turnCeiling: { effective: 1, source: "explicit" as const } } : {}),
                    });
                    await waitForDb(async () => order, (events) => events.includes("held"));
                    if (holder === "parked") {
                        assert.ok(drainPromise !== undefined, "the injection started the worker's drain");
                        await drainPromise;
                        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 202, "the loop is parked");
                    }
                    if (holder === "stream" && ending !== "turn ceiling") await held.promise;
                    const expire = (): void => (timers.get(loopId) ?? assert.fail("the loop never started executing"))();
                    const ended = END[ending]({ daemon, workspaceId, workerId, expire });
                    release.resolve();
                    await ended;
                    const terminated = `terminated ${loopId}`;
                    if (delayedAnnouncement) {
                        await terminalReady.promise;
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        assert.equal(order.includes(terminated), false, "a committed stream close still owes its announcement before the terminal");
                        deliver.resolve();
                    }
                    await waitForDb(async () => order, (events) => events.includes(terminated));
                    // Stopped, the daemon has settled every producer: a second terminal would be here by now.
                    await daemon.stop();
                    const settled = order.indexOf("settled");
                    assert.ok(order.indexOf("held") < settled && settled < order.indexOf(terminated), `the gate settles before its loop's terminal: ${order.join(" > ")}`);
                    assert.equal(order.filter((event) => event === terminated).length, 1, `the loop announces one terminal: ${order.join(" > ")}`);
                } finally {
                    deliver.resolve();
                    off();
                }
            });
        });
    }
}
