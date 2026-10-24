// {§acp-message-acceptance} {§acp-snapshot} {§acp-sync} — a client tells an accepted message from its own copy by the
// daemon's word. The official HttpAgent submits a follow-up while the worker's first inference is held: the gauge lists it
// accepted, a fresh client's snapshot carries it unpublished, a resend of it admits nothing twice, and when the next turn
// observes it the arrival folds onto the one message every client holds. A worker cancelled first keeps it listed with that
// terminal lifecycle. Real core admission; stock client.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "../../src/client.ts";
import type { Message, RunAgentInput } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

class Observer extends HttpAgent {
    override connect(input: RunAgentInput) { return super.run(input); }
}

interface InboxEntry { path: string; id: string | null; loopId: number; lifecycle: string }
interface PlurnkMetadata { message?: string; loop?: number; lifecycle?: string; coordinate?: string; published?: boolean }

const until = async (what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

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

// The gauge as the official client's state carries it: the snapshot's inbox, then each whole-gauge replacement's or delta's.
const watchInbox = (): { entries: () => InboxEntry[] | null; subscriber: Parameters<HttpAgent["runAgent"]>[1] } => {
    let current: InboxEntry[] | null = null;
    const gauge = (state: unknown): InboxEntry[] | undefined => (state as { plurnk?: { status?: { inbox?: InboxEntry[] } } }).plurnk?.status?.inbox;
    return {
        entries: () => current,
        subscriber: {
            onStateSnapshotEvent: ({ event }) => { current = gauge(event.snapshot) ?? null; },
            onStateDeltaEvent: ({ event }) => {
                for (const op of event.delta as Array<{ path: string; value?: unknown }>) {
                    if (op.path === "/plurnk/status") current = (op.value as { inbox?: InboxEntry[] }).inbox ?? null;
                    if (op.path === "/plurnk/status/inbox") current = op.value as InboxEntry[];
                }
            },
        },
    };
};

const users = (messages: readonly Message[]): Array<{ id: string; content: unknown; plurnk: PlurnkMetadata | undefined }> =>
    messages.filter(({ role }) => role === "user").map((message) => ({
        id: message.id, content: "content" in message ? message.content : undefined,
        plurnk: ("metadata" in message ? message.metadata : undefined) as { plurnk?: PlurnkMetadata } | undefined
            ? (message as { metadata?: { plurnk?: PlurnkMetadata } }).metadata?.plurnk : undefined,
    }));
const speech = (messages: readonly Message[]): unknown[] => messages.filter(({ role }) => role === "assistant").map((message) => "content" in message ? message.content : undefined).filter((content) => typeof content === "string");

// Turn 1 streams its reasoning, holds until released, then answers A; the next turn answers whatever arrived.
const heldProvider = async (): Promise<{ provider: unknown; release: () => void; reasoned: Promise<void>; calls: () => number }> => {
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    const held = Promise.withResolvers<void>();
    const reasoned = Promise.withResolvers<void>();
    let calls = 0;
    const frame = (delta: object, finish: string | null = null): object => ({
        id: `acceptance-${calls}`, model: "acceptance-witness", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
    });
    const provider = new AiSdkProvider({
        model: "acceptance-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            calls++;
            if (calls === 1) {
                queueMicrotask(() => reasoned.resolve());
                return streamed([frame({ reasoning_content: "Weighing A." }), frame({ content: "````SEND [200]\nAnswer A.\n````" }, "stop")], held.promise);
            }
            return streamed([frame({ content: "````SEND [200]\nAnswer B.\n````" }, "stop")]);
        },
    });
    return { provider, release: () => held.resolve(), reasoned: reasoned.promise, calls: () => calls };
};

const A: Message = { id: "A", role: "user", content: "First question." };
const B: Message = { id: "B", role: "user", content: "Second question." };
const addressOf = (id: string): string => `acp://operator/threads/main/messages/${id}`;

test("{§acp-message-acceptance} {§acp-snapshot} {§acp-sync} an accepted follow-up is on the gauge and in every snapshot before its turn, and its arrival folds onto the one message each client holds", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { provider, release, reasoned, calls } = await heldProvider();
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: provider as never, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        release();
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "acceptance" });
    await daemon.createWorker({ workspaceId, name: "main" });
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/acp`;
    const forwardedProps = { plurnk: { workspace: "acceptance", maxTurns: 4 } };
    const agent = (): HttpAgent => { const made = new HttpAgent({ url, threadId: "main" }); agents.push(made); return made; };

    const submitter = agent();
    submitter.messages = [A];
    const submitted = submitter.runAgent({ forwardedProps });
    await reasoned;
    await until("A's held first turn to reach its client", () => submitter.messages.some((message) => message.role === "reasoning" && message.content.length > 0));

    // The follow-up, submitted while A's first turn is held: its Run learns the acceptance from the gauge.
    const follower = agent();
    follower.messages = [A, B];
    const followerInbox = watchInbox();
    const followed = follower.runAgent({ forwardedProps }, followerInbox.subscriber);
    await until("the follow-up to be accepted", () => (followerInbox.entries() ?? []).some(({ id }) => id === "B"));
    const accepted = followerInbox.entries()!.find(({ id }) => id === "B")!;
    assert.equal(accepted.path, addressOf("B"), "the gauge names the accepted message by its immutable address and the client's id");
    assert.equal(accepted.lifecycle, "running", "and the lifecycle of the loop holding it");
    assert.equal(calls(), 1, "no turn has observed it: A's inference is still held");
    assert.deepEqual(users(follower.messages).map(({ id, content }) => ({ id, content })), [{ id: "A", content: A.content }, { id: "B", content: B.content }],
        "the submitting client holds its own copy once, never an echo beside it");

    // A fresh client: its snapshot carries B as accepted, after every row, unpublished and without a coordinate.
    const fresh = new Observer({ url: `${url}/connect`, threadId: "main" });
    agents.push(fresh);
    const freshInbox = watchInbox();
    const connected = fresh.connectAgent({ forwardedProps }, freshInbox.subscriber);
    await until("the fresh client's snapshot", () => fresh.messages.some(({ id }) => id === "B"));
    const pending = users(fresh.messages).find(({ id }) => id === "B")!;
    assert.equal(pending.content, B.content, "with its words");
    assert.equal(pending.plurnk?.published, false, "{§acp-plurnk-metadata} its acceptance rides its metadata");
    assert.equal(pending.plurnk?.message, addressOf("B"));
    assert.equal(pending.plurnk?.coordinate, undefined, "and no coordinate is fabricated for a row that does not exist");
    assert.deepEqual(fresh.messages.at(-1)?.id, "B", "after every row the log holds");
    assert.ok((freshInbox.entries() ?? []).some(({ id }) => id === "B"), "the fresh client's gauge lists it too");

    // Resending B: already accepted, so the Run synchronizes; nothing is admitted twice and nothing is echoed.
    const resend = agent();
    resend.messages = [A, B];
    let resent = false;
    const resending = resend.runAgent({ forwardedProps: { plurnk: { workspace: "acceptance" } } }, { onMessagesSnapshotEvent: () => { resent = true; } });
    await until("the resend's snapshot", () => resent);
    assert.equal(calls(), 1, "{§message-idempotency} the resend started no inference");
    assert.deepEqual(users(resend.messages).map(({ id }) => id), ["A", "B"], "and the snapshot holds B once");

    // The next turn observes B: the arrival folds its facts onto the message every client holds, and leaves the inbox.
    release();
    await submitted;
    await followed;
    await connected;
    await resending;
    for (const [name, client] of [["submitter", submitter], ["follower", follower], ["fresh", fresh], ["resend", resend]] as const) {
        const held = users(client.messages).filter(({ id }) => id === "B");
        assert.equal(held.length, 1, `${name} holds B once`);
        assert.equal(held[0].content, B.content, `${name} holds B's words once`);
        assert.ok(typeof held[0].plurnk?.coordinate === "string", `${name}: the arrival folded its coordinate onto B`);
        assert.equal(held[0].plurnk?.published, undefined, `${name}: the row's facts replaced the acceptance facts`);
        assert.deepEqual(speech(client.messages), ["Answer A.", "Answer B."], `${name} heard both answers`);
    }
    assert.deepEqual(followerInbox.entries(), [], "observed: out of the inbox");
    assert.equal(calls(), 2);
});

test("{§acp-message-acceptance} a worker cancelled before observing an accepted follow-up keeps it listed with that terminal lifecycle", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { provider, release, reasoned, calls } = await heldProvider();
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: provider as never, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        release();
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "acceptance-cancel" });
    const { workerId } = await daemon.createWorker({ workspaceId, name: "main" });
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/acp`;
    const forwardedProps = { plurnk: { workspace: "acceptance-cancel", maxTurns: 4 } };
    const agent = (): HttpAgent => { const made = new HttpAgent({ url, threadId: "main" }); agents.push(made); return made; };

    const submitter = agent();
    submitter.messages = [A];
    const submitted = submitter.runAgent({ forwardedProps }).catch(() => undefined);
    await reasoned;
    const follower = agent();
    follower.messages = [A, B];
    const inbox = watchInbox();
    const followed = follower.runAgent({ forwardedProps }, inbox.subscriber).catch(() => undefined);
    await until("the follow-up to be accepted", () => (inbox.entries() ?? []).some(({ id }) => id === "B"));

    await daemon.cancelWorker({ workspaceId, workerId });
    release();
    await submitted;
    await followed;
    assert.equal(calls(), 1, "no turn observed B");

    const later = agent();
    later.messages = [A, B];
    const laterInbox = watchInbox();
    await later.runAgent({ forwardedProps: { plurnk: { workspace: "acceptance-cancel" } } }, laterInbox.subscriber);
    const listed = (laterInbox.entries() ?? []).find(({ id }) => id === "B");
    assert.ok(listed !== undefined, "still accepted and unobserved: listed");
    assert.equal(listed.lifecycle, "cancelled", "{§message-loop-containment} with the lifecycle of the loop that ended without observing it");
    const held = users(later.messages).filter(({ id }) => id === "B");
    assert.equal(held.length, 1, "and the snapshot carries it once");
    assert.equal(held[0].plurnk?.published, false);
    assert.equal(held[0].plurnk?.lifecycle, "cancelled");

    // Subsequent loops place their messages after B, and once PLURNK_ACP_HISTORY_LOOPS newer loops run, B ages into loop 1's history page.
    const C: Message = { id: "C", role: "user", content: "Third question." };
    const D: Message = { id: "D", role: "user", content: "Fourth question." };
    const second = agent();
    second.messages = [...later.messages, C];
    await second.runAgent({ forwardedProps });
    const afterSecond = agent();
    await afterSecond.runAgent({ forwardedProps: { plurnk: { workspace: "acceptance-cancel" } } });
    assert.deepEqual(users(afterSecond.messages).map(({ id }) => id), ["A", "B", "C"], "B stays at the end of loop 1, before loop 2's prompt");

    const third = agent();
    third.messages = [...afterSecond.messages, D];
    await third.runAgent({ forwardedProps });
    let olderUrl: string | null = null;
    const afterThird = agent();
    await afterThird.runAgent({ forwardedProps: { plurnk: { workspace: "acceptance-cancel" } } }, {
        onMessagesSnapshotEvent: ({ event }) => {
            olderUrl = (event as { metadata?: { plurnk?: { history?: { older?: string | null } } } }).metadata?.plurnk?.history?.older ?? null;
        },
    });
    assert.deepEqual(users(afterThird.messages).map(({ id }) => id), ["C", "D"], "{§acp-history-window} loop 1 and B aged out of the 2-loop window together");
    assert.ok(typeof olderUrl === "string", "the snapshot links to the history page before loop 2");
    const page1 = await (await fetch(olderUrl)).json() as { final: boolean; messages: Message[]; older: string | null };
    assert.equal(page1.final, true);
    assert.equal(page1.older, null);
    assert.deepEqual(users(page1.messages).map(({ id }) => id), ["A", "B"], "{§acp-history-page} loop 1's history page carries A and the cancelled follow-up B");
    const byLoop = new URL(olderUrl);
    byLoop.searchParams.delete("before");
    byLoop.searchParams.set("loop", "1");
    const loop1 = await (await fetch(byLoop)).json() as { final: boolean; messages: Message[]; older: string | null };
    assert.deepEqual(users(loop1.messages).map(({ id }) => id), ["A", "B"], "{§acp-loop-page} loop 1 by number carries A and the cancelled follow-up B");
});
