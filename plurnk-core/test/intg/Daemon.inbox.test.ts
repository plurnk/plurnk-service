// {§methods-worker-inbox} The accepted messages a worker has not yet observed, by the daemon's word: a message accepted
// while a turn is in flight is in the inbox until the next turn boundary publishes it, and leaves it when its loop concludes.
import test from "node:test";
import assert from "node:assert/strict";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { withDaemon, waitForDb } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

const streamed = (frames: readonly object[], hold?: Promise<void>): Response => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
        const send = (frame: object): void => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)); };
        const [first, ...rest] = frames;
        if (first !== undefined) send(first);
        await hold;
        for (const frame of rest) send(frame);
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

// Turn 1 streams its reasoning, holds until released, then answers; turn 2 answers at once.
const heldProvider = (): { provider: AiSdkProvider; release: () => void; calls: () => number } => {
    const held = Promise.withResolvers<void>();
    let calls = 0;
    const frame = (delta: object, finish: string | null = null): object => ({
        id: `inbox-${calls}`, model: "inbox-witness", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
    });
    const provider = new AiSdkProvider({
        model: "inbox-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            calls++;
            if (calls === 1) {
                return streamed([frame({ reasoning_content: "Weighing A." }), frame({ content: "````SEND [200]\nAnswer A.\n````" }, "stop")], held.promise);
            }
            return streamed([frame({ content: "````SEND [200]\nAnswer B.\n````" }, "stop")]);
        },
    });
    return { provider, release: () => held.resolve(), calls: () => calls };
};

const address = (id: string): string => `agui://anonymous/threads/inbox/messages/${id}`;

test("{§methods-worker-inbox} a message accepted mid-turn is in the inbox until its arrival row lands", async () => {
    const { provider, release, calls } = heldProvider();
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "inbox" });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const first = await daemon.runLoop({ workspaceId, workerId, prompt: "A", source: address("A"), messageAddress: address("A") });
        await waitForDb(async () => calls(), (count) => count >= 1);
        assert.deepEqual(await daemon.readInbox({ workspaceId, workerId }), [], "the headline message is observed by the turn in flight");
        const second = await daemon.runLoop({ workspaceId, workerId, prompt: "B", source: address("B"), messageAddress: address("B") });
        assert.equal(second.loopId, first.loopId, "{§message-arrival} the follow-up joins the live loop");
        assert.deepEqual(await daemon.readInbox({ workspaceId, workerId }),
            [{ path: address("B"), source: address("B"), body: "B", loopId: first.loopId, lifecycle: "running" }],
            "accepted, durable, and not yet observed: in the inbox by its immutable address, source, words, loop and its lifecycle");
        assert.equal(await daemon.messageAdmission({ workspaceId, address: address("B"), body: "B" }), "accepted",
            "{§message-idempotency} the same address and words are already accepted");
        release();
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId }), (loops) => loops.some(({ id, status }) => id === first.loopId && status === 200));
        assert.equal(calls(), 2, "the next turn boundary published B and the model answered it");
        assert.deepEqual(await daemon.readInbox({ workspaceId, workerId }), [], "published: out of the inbox");
        const messages = await daemon.readMessages({ workspaceId, workerId });
        assert.deepEqual(messages.filter(({ direction }) => direction === "inbound").map(({ body }) => body), ["A", "B"], "and durable as ever");
    });
});

test("{§methods-worker-inbox} {§message-loop-containment} a loop cancelled before observing a message leaves it in the inbox with that terminal lifecycle", async () => {
    const { provider, release, calls } = heldProvider();
    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "inbox-cancel" });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const first = await daemon.runLoop({ workspaceId, workerId, prompt: "A", source: address("A"), messageAddress: address("A") });
        await waitForDb(async () => calls(), (count) => count >= 1);
        await daemon.runLoop({ workspaceId, workerId, prompt: "B", source: address("B"), messageAddress: address("B") });
        assert.equal((await daemon.readInbox({ workspaceId, workerId })).length, 1);
        await daemon.cancelWorker({ workspaceId, workerId });
        release();
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId }), (loops) => loops.some(({ id, terminatedAt }) => id === first.loopId && terminatedAt !== null));
        assert.deepEqual(await daemon.readInbox({ workspaceId, workerId }),
            [{ path: address("B"), source: address("B"), body: "B", loopId: first.loopId, lifecycle: "failed" }],
            "the loop concluded without observing it: still unobserved, and its lifecycle says nothing will");
        assert.ok((await daemon.readMessages({ workspaceId, workerId })).some(({ body }) => body === "B"), "{§message-arrival} acceptance is durable");
        assert.equal(await daemon.messageAdmission({ workspaceId, address: address("B"), body: "B" }), "accepted", "{§message-idempotency} and its address stays taken");
    });
});
