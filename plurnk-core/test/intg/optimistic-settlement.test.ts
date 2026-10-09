import { serverProposals } from "./_approval.ts";
// {§worker-optimistic-settlement} — terminal stream and child arrivals remain
// independent durable wake edges while one bounded worker-local opportunity
// coalesces provider dispatch over sibling obligations.

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type {
    ChatMessage,
    Provider,
    ProviderResponse,
} from "@plurnk/plurnk-providers";
import { Mock } from "@plurnk/plurnk-providers";
import type { InputModality } from "@plurnk/plurnk-providers";
import { connect, rpcCall, runLoopToTerminal, subscribeNotifications, waitFor, waitForDb, withDaemon } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { testProviderCapacity } from "./_provider.ts";
import { mountMemoryTracing } from "./_observe-memory.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";

const requestAccounting = {
    provider: "provider:controlled-settlement",
    model: "controlled-settlement",
    outcome: "response",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "controlled fixture" },
} as const;

const response = (
    content: string,
    capacity: ProviderResponse["capacity"],
    grammar?: string,
): ProviderResponse => {
    return {
        assistant: {
            content,
            reasoning: null,
            finishReason: "stop",
            model: "controlled-settlement",
        },
        assistantRaw: null,
        accounting: [requestAccounting],
        capacity,
        ...(grammar === undefined
            ? {}
            : { grammarEvidence: { input: content, contentStart: 0, transported: true } }),
    };
};

class ControlledWorkerProvider implements Provider {
    readonly contextWindow = 100_000;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1;
    readonly reasoningBudget = null;
    readonly supportedEfforts = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly outputFloor = null;
    readonly inputWall = null;
    readonly model = "controlled-settlement";
    readonly inputModalities: ReadonlySet<InputModality> = new Set();
    readonly childrenStarted = Promise.withResolvers<void>();
    readonly #parentTurns: readonly string[];
    readonly #parentStarts: Array<PromiseWithResolvers<void>>;
    readonly #childReleases: Array<PromiseWithResolvers<void>>;
    readonly #parentMessages: ChatMessage[][] = [];
    readonly #parentStartedAt: number[] = [];
    #parentCalls = 0;
    #childCalls = 0;

    constructor({ parentTurns, childCount }: { parentTurns: readonly string[]; childCount: number }) {
        this.#parentTurns = parentTurns;
        this.#parentStarts = parentTurns.map(() => Promise.withResolvers<void>());
        this.#childReleases = Array.from({ length: childCount }, () => Promise.withResolvers<void>());
        if (childCount === 0) this.childrenStarted.resolve();
    }

    get parentCalls(): number { return this.#parentCalls; }
    get childCalls(): number { return this.#childCalls; }
    parentMessages(call: number): readonly ChatMessage[] { return this.#parentMessages[call - 1] ?? []; }
    parentStartedAt(call: number): number | undefined { return this.#parentStartedAt[call - 1]; }
    waitForParentCall(call: number): Promise<void> {
        const started = this.#parentStarts[call - 1];
        if (started === undefined) throw new RangeError(`No parent turn ${call} is configured.`);
        return started.promise;
    }

    countPromptTokens(messages: readonly ChatMessage[]) {
        return Promise.resolve({
            kind: "exact" as const,
            tokens: messages.reduce((sum, { content }) => sum + Math.ceil(content.length / 2), 0),
            source: "controlled-settlement:chars2",
        });
    }

    async assessRequestCapacity(messages: readonly ChatMessage[]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    #parentIdentity: string | undefined;

    async generate({
        messages,
        workerId,
        signal,
        grammar,
        observeRequest,
    }: Parameters<Provider["generate"]>[0]): Promise<ProviderResponse> {
        signal?.throwIfAborted();
        const capacity = await this.assessRequestCapacity(messages);
        const settle = await observeRequest?.({
            provider: requestAccounting.provider,
            model: requestAccounting.model,
        });
        // The parent worker is whoever calls first; children spawn from its turn.
        this.#parentIdentity ??= workerId;
        if (workerId === this.#parentIdentity) {
            const index = this.#parentCalls++;
            const content = this.#parentTurns[index];
            if (content === undefined) throw new Error(`Unexpected parent provider call ${index + 1}.`);
            this.#parentMessages[index] = messages;
            this.#parentStartedAt[index] = performance.now();
            this.#parentStarts[index]?.resolve();
            await settle?.(requestAccounting);
            return response(content, capacity, grammar);
        }

        const index = this.#childCalls++;
        if (index >= this.#childReleases.length) throw new Error(`Unexpected child provider call ${index + 1}.`);
        if (this.#childCalls === this.#childReleases.length) this.childrenStarted.resolve();
        await this.#childReleases[index].promise;
        signal?.throwIfAborted();
        await settle?.(requestAccounting);
        return response(`\`\`\`\`KILL
child ${index + 1} done
\`\`\`\``, capacity, grammar);
    }

    releaseChild(index: number): void {
        this.#childReleases[index]?.resolve();
    }

    releaseAll(): void {
        for (const release of this.#childReleases) release.resolve();
    }
}

test("near-simultaneous child conclusions share one parent provider turn", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledWorkerProvider({
        childCount: 2,
        parentTurns: [
            "````WORK (worker://first)\nfinish first\n\n````\n"
            + "````WORK (worker://second)\nfinish second\n\n````\n"
            + "````WAIT\nwaiting for both\n````",
            "````KILL\nboth children landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-child-fanout" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate two independent jobs and await both",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;

                provider.releaseChild(0);
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId }) => loopId !== parentLoopId),
                );
                const resumedBeforeSibling = await Promise.race([
                    provider.waitForParentCall(2).then(() => true),
                    delay(200, false),
                ]);
                assert.equal(
                    resumedBeforeSibling,
                    false,
                    "the first child conclusion holds provider dispatch while its sibling remains in flight",
                );

                provider.releaseChild(1);
                const events = await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (items) => items.some(({ loopId }) => loopId === parentLoopId),
                    { timeoutMs: 5_000 },
                );
                const parent = events.find(({ loopId }) => loopId === parentLoopId);
                assert.equal(parent?.result.status, 200);
                assert.equal(provider.childCalls, 2);
                assert.equal(provider.parentCalls, 2, "both child returns cost one resumed parent turn");
                const resumedPacket = provider.parentMessages(2).map(({ content }) => content).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /child 2 done/);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("a lone child conclusion resumes immediately without paying the settlement cap", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledWorkerProvider({
        childCount: 1,
        parentTurns: [
            "````WORK (worker://only)\nfinish the only job\n````\n\n````WAIT\nwaiting\n````",
            "````KILL\nonly child landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-child-single" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate one job and await it",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                const releasedAt = performance.now();
                provider.releaseChild(0);
                await provider.waitForParentCall(2);
                assert.ok(
                    performance.now() - releasedAt < 350,
                    "without a sibling obligation, the completion wake bypasses the 500ms hold",
                );
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                );
                assert.equal(provider.parentCalls, 2);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("stream conclusions coalesce across the same worker-local settlement window", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "200";
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse(
                "````sh\nsleep 0.25; echo first-stream\n\n````\n"
                + "````sh\nsleep 0.40; echo second-stream\n\n````\n"
                + "````WAIT\nwaiting for both streams\n````",
            ),
            makeMockResponse("````KILL\nboth streams landed\n````"),
        ],
    });
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-stream-fanout" });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "run two independent streams and await both",

                });
                assert.equal(result.finalStatus, 200);
                assert.equal(provider.remaining, 0, "two stream conclusions cost one resumed provider turn");
            } finally {
                ws.close();
            }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("a child and stream conclusion share the same settlement window", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "300";
    const provider = new ControlledWorkerProvider({
        childCount: 1,
        parentTurns: [
            "````WORK (worker://child)\nfinish independently\n\n````\n"
            + "````sh\nsleep 0.50; echo stream-done\n\n````\n"
            + "````WAIT\nwaiting for child and stream\n````",
            "````KILL\nchild and stream landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-mixed-fanout" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "run one child and one stream and await both",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );
                provider.releaseChild(0);

                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                    { timeoutMs: 5_000 },
                );
                assert.equal(provider.parentCalls, 2, "mixed asynchronous returns cost one resumed parent turn");
                const resumedPacket = provider.parentMessages(2).map(({ content }) => content).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /stream-done/);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("the settlement deadline is bounded and does not slide on later conclusions", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledWorkerProvider({
        childCount: 3,
        parentTurns: [
            "````WORK (worker://first)\nfinish first\n\n````\n"
            + "````WORK (worker://second)\nfinish second\n\n````\n"
            + "````WORK (worker://third)\nfinish third\n\n````\n"
            + "````WAIT\nwaiting for all three\n````",
            "````WAIT\ntwo landed; still waiting\n````",
            "````KILL\nall three landed\n````",
        ],
    });
    const windowOpened = Promise.withResolvers<void>();
    const secondArrival = Promise.withResolvers<void>();
    const settle = DrainSupervisor.prototype.settleCompletionWake;
    let arrivals = 0;
    approvalContext.mock.method(DrainSupervisor.prototype, "settleCompletionWake", function (
        this: DrainSupervisor, ...args: Parameters<typeof settle>
    ) {
        const pending = settle.apply(this, args);
        if (++arrivals === 2) secondArrival.resolve();
        return pending;
    });
    const tracing = await mountMemoryTracing((span) => {
        if (span.name !== "worker.wake.settlement") return;
        approvalContext.mock.timers.enable({ apis: ["setTimeout"] });
        windowOpened.resolve();
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-non-sliding" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate three jobs and await all three",

                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                provider.releaseChild(0);
                await windowOpened.promise;
                approvalContext.mock.timers.tick(350);
                provider.releaseChild(1);
                await secondArrival.promise;
                approvalContext.mock.timers.tick(149);
                assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status, 202,
                    "the parent remains parked before the original deadline while one child is still live");
                assert.equal(provider.parentCalls, 1);
                assert.equal(tracing.spans().some(({ name }) => name === "worker.wake.settlement"), false,
                    "the opportunity has not expired at 499ms");
                approvalContext.mock.timers.tick(1);
                approvalContext.mock.timers.reset();
                await provider.waitForParentCall(2);
                const window = tracing.spans().find(({ name }) => name === "worker.wake.settlement");
                assert.equal(window?.attributes.release, "deadline");
                assert.equal(window?.attributes.conclusions, 2,
                    "the second arrival shares the first deadline, rather than starting a new opportunity");
                const resumedPacket = provider.parentMessages(2).map(({ content }) => content).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /child 2 done/);
                assert.doesNotMatch(resumedPacket, /child 3 done/);
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                provider.releaseChild(2);
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                    { timeoutMs: 5_000 },
                );
                assert.equal(provider.parentCalls, 3, "deadline wake plus final lone-child wake are the only resumptions");
            } finally {
                approvalContext.mock.timers.reset();
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        approvalContext.mock.timers.reset();
        provider.releaseAll();
        await tracing.shutdown();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});
