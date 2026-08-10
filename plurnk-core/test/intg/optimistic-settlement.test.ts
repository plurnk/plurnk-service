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
import {
    connect,
    makeMockResponse,
    rpcCall,
    runLoopToTerminal,
    subscribeNotifications,
    waitFor,
    waitForDb,
    withDaemon,
} from "./_rpc.ts";

const response = (content: string, grammar?: string): ProviderResponse => {
    const turn = content.startsWith("<<PLAN") ? content : `<<PLAN::PLAN\n${content}`;
    return {
        assistant: {
            content: turn,
            reasoning: null,
            usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
            finishReason: "stop",
            model: "controlled-settlement",
        },
        assistantRaw: null,
        ...(grammar === undefined
            ? {}
            : { grammarEvidence: { input: turn, contentStart: 0, transported: true } }),
    };
};

class ControlledWorkerProvider implements Provider {
    readonly contextWindow = 100_000;
    readonly model = "controlled-settlement";
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

    calculateCost(): number { return 0; }

    async generate({
        messages,
        workerId,
        primaryWorkerId,
        signal,
        grammar,
    }: Parameters<Provider["generate"]>[0]): Promise<ProviderResponse> {
        signal?.throwIfAborted();
        if (workerId === primaryWorkerId) {
            const index = this.#parentCalls++;
            const content = this.#parentTurns[index];
            if (content === undefined) throw new Error(`Unexpected parent provider call ${index + 1}.`);
            this.#parentMessages[index] = messages;
            this.#parentStartedAt[index] = performance.now();
            this.#parentStarts[index]?.resolve();
            return response(content, grammar);
        }

        const index = this.#childCalls++;
        if (index >= this.#childReleases.length) throw new Error(`Unexpected child provider call ${index + 1}.`);
        if (this.#childCalls === this.#childReleases.length) this.childrenStarted.resolve();
        await this.#childReleases[index].promise;
        signal?.throwIfAborted();
        return response(`<<SEND[200]:child ${index + 1} done:SEND`, grammar);
    }

    releaseChild(index: number): void {
        this.#childReleases[index]?.resolve();
    }

    releaseAll(): void {
        for (const release of this.#childReleases) release.resolve();
    }
}

test("near-simultaneous child conclusions share one parent provider turn", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledWorkerProvider({
        childCount: 2,
        parentTurns: [
            "<<WORK(worker://first):finish first:WORK\n"
            + "<<WORK(worker://second):finish second:WORK\n"
            + "<<SEND[202]<-1>:waiting for both:SEND",
            "<<SEND[200]:both children landed:SEND",
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
                    flags: { auto: true },
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

test("a lone child conclusion resumes immediately without paying the settlement cap", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledWorkerProvider({
        childCount: 1,
        parentTurns: [
            "<<WORK(worker://only):finish the only job:WORK\n<<SEND[202]<-1>:waiting:SEND",
            "<<SEND[200]:only child landed:SEND",
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
                    flags: { auto: true },
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

test("stream conclusions coalesce across the same worker-local settlement window", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "200";
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse(
                "<<EXEC[sh]:sleep 0.25; echo first-stream:EXEC\n"
                + "<<EXEC[sh]:sleep 0.40; echo second-stream:EXEC\n"
                + "<<SEND[202]<-1>:waiting for both streams:SEND",
            ),
            makeMockResponse("<<SEND[200]:both streams landed:SEND"),
        ],
    });
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-stream-fanout" });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "run two independent streams and await both",
                    flags: { auto: true },
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

test("a child and stream conclusion share the same settlement window", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "300";
    const provider = new ControlledWorkerProvider({
        childCount: 1,
        parentTurns: [
            "<<WORK(worker://child):finish independently:WORK\n"
            + "<<EXEC[sh]:sleep 0.50; echo stream-done:EXEC\n"
            + "<<SEND[202]<-1>:waiting for child and stream:SEND",
            "<<SEND[200]:child and stream landed:SEND",
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
                    flags: { auto: true },
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

test("the settlement deadline is bounded and does not slide on later conclusions", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledWorkerProvider({
        childCount: 3,
        parentTurns: [
            "<<WORK(worker://first):finish first:WORK\n"
            + "<<WORK(worker://second):finish second:WORK\n"
            + "<<WORK(worker://third):finish third:WORK\n"
            + "<<SEND[202]<-1>:waiting for all three:SEND",
            "<<SEND[202]<-1>:two landed; still waiting:SEND",
            "<<SEND[200]:all three landed:SEND",
        ],
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-non-sliding" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate three jobs and await all three",
                    flags: { auto: true },
                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                provider.releaseChild(0);
                await delay(350);
                provider.releaseChild(1);
                const resumedOnOriginalDeadline = await Promise.race([
                    provider.waitForParentCall(2).then(() => true),
                    delay(300, false),
                ]);
                assert.equal(
                    resumedOnOriginalDeadline,
                    true,
                    "the second conclusion does not restart the first conclusion's 500ms deadline",
                );
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
