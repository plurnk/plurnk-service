// {§agui-readable-reasoning} {§agui-reasoning-link} — the official client receives reasoning as AG-UI defines it: its text,
// live and on replay, with nothing negotiated. A client that negotiates reasoning by link receives each turn's reasoning
// as its link instead: the live text a preview no message holds, the message empty, the text one fetch at its address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

type Reasoning = Extract<Message, { role: "reasoning" }>;
const reasoningOf = (messages: readonly Message[]): Reasoning[] => messages.filter((message): message is Reasoning => message.role === "reasoning");

// A provider's stream as a real one sends it: the reasoning as it is thought, then the answer.
const streamed = (frames: readonly object[]): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

test("{§agui-reasoning-link}: a stock client receives reasoning's text, live and on replay; a client that negotiated links receives each turn's link", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const thought = "Weighing the count.\nIt is three.";
    const provider = new AiSdkProvider({
        model: "reasoning-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => streamed([
            { id: "reasoning", model: "reasoning-witness", choices: [{ index: 0, delta: { reasoning_content: "Weighing the count.\n" }, finish_reason: null }] },
            { id: "reasoning", model: "reasoning-witness", choices: [{ index: 0, delta: { reasoning_content: "It is three." }, finish_reason: null }] },
            { id: "reasoning", model: "reasoning-witness", choices: [{ index: 0, delta: { content: "````SEND [200]\nThree.\n````" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
        ]),
    });
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    t.after(async () => {
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/agui`;

    // A stock client: an opaque thread and nothing plurnk forwarded.
    const stock = new HttpAgent({ url, threadId: "stock" });
    stock.messages = [{ id: "s1", role: "user", content: "Count." }];
    const deltas: string[] = [];
    await stock.runAgent({}, { onReasoningMessageContentEvent: ({ event }) => { deltas.push(event.delta); } });
    assert.equal(deltas.join(""), thought, "the live text arrives on AG-UI's reasoning channel, once");
    assert.deepEqual(reasoningOf(stock.messages).map(({ content }) => content), [thought], "the client holds the reasoning it streamed, once");
    const stockReplay = new HttpAgent({ url, threadId: "stock" });
    await stockReplay.runAgent({});
    assert.deepEqual(reasoningOf(stockReplay.messages).map(({ id, content }) => [id, content]), reasoningOf(stock.messages).map(({ id }) => [id, thought]),
        "the replay holds the text under the identity the live stream gave it");

    // A client that negotiated reasoning by link.
    const negotiate = { forwardedProps: { plurnk: { reasoning: "link" } } };
    const linked = new HttpAgent({ url, threadId: "linked" });
    linked.messages = [{ id: "l1", role: "user", content: "Count." }];
    const previewed: string[] = [];
    await linked.runAgent(negotiate, {
        onCustomEvent: ({ event }) => { if (event.name === "plurnk.reasoning") previewed.push((event.value as { delta: string }).delta); },
        onReasoningMessageContentEvent: () => assert.fail("a Run that negotiated links receives no reasoning text on the message"),
    });
    assert.equal(previewed.join(""), thought, "the live text arrives as a preview");
    const [message] = reasoningOf(linked.messages);
    assert.equal(message?.content, "", "the message holds no text");
    const link = (message?.metadata as { plurnk?: { body?: { url?: string; mimeType?: string } } } | undefined)?.plurnk?.body;
    assert.equal(link?.mimeType, "text/plain");
    const fetched = await fetch(link?.url ?? "");
    assert.equal(fetched.status, 200);
    assert.equal(await fetched.text(), thought, "the text is one fetch at the message's link");
    assert.ok(!JSON.stringify(linked.messages).includes("Weighing"), "the client holds no reasoning text, so it uploads none");
    const linkedReplay = new HttpAgent({ url, threadId: "linked" });
    await linkedReplay.runAgent(negotiate);
    assert.deepEqual(reasoningOf(linkedReplay.messages).map(({ id, content, metadata }) => [id, content, metadata]),
        [[message?.id, "", { plurnk: { body: link } }]], "the replay holds the link under the live identity");
});
