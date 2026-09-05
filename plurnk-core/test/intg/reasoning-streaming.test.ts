import assert from "node:assert/strict";
import test from "node:test";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { Translator } from "@plurnk/plurnk-agui";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§notifications-reasoning-event}: provider SSE reaches standard AG-UI before the reasoning copy exists", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "streaming-reasoning");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const translator = new Translator({ threadId: "streaming", runId: "streaming", modelWorkerId: workerId });
        const events: ReturnType<Translator["reasoning"]> = [];
        const ready = Promise.withResolvers<void>();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), reasoningEventNotify(_workspace, payload) {
            const translated = translator.reasoning(payload);
            events.push(...translated);
            if (translated.some((event) => event.type === "REASONING_MESSAGE_CONTENT" && event.delta === "Visible now.")) ready.resolve();
        } });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const send = (content: string, finish: string | null = null): void => controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ id: "streaming", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`,
        ));
        const provider = new AiSdkProvider({
            model: "m", url: "https://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000, firstContentTimeoutMs: 0,
            temperature: 0.2, repeatPenalty: null, retryAttempts: 0, reasoning: { mode: "adaptive", budget: null }, reasoningResponseStyle: "think-tags",
            fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(stream) {
                controller = stream;
                send("<think>Visible now.");
            } }), { headers: { "Content-Type": "text/event-stream" } }),
        });
        const run = engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const timer = setTimeout(() => ready.reject(new Error("AG-UI reasoning was withheld until completion")), 2000);
        try {
            await ready.promise;
            assert.deepEqual(await db.test_reasoning_resources.all({ worker_id: workerId }), [], "the live signal cannot originate from a not-yet-created copy");
            assert.ok(!events.some(({ type }) => type === "REASONING_MESSAGE_END"));
        } finally {
            clearTimeout(timer);
            send("</think>## PLAN0\n[]\n### SEND0 (TERM)\nDone.", "stop");
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
            assert.equal((await run).status, 200);
        }
        assert.deepEqual(events.filter((event) => event.type === "REASONING_MESSAGE_CONTENT").map((event) => event.delta), ["Visible now."]);
        assert.equal(events.filter(({ type }) => type === "REASONING_MESSAGE_END").length, 1);
        const rows = await db.test_reasoning_resources.all<{ content: string }>({ worker_id: workerId });
        assert.equal(rows[0]!.content, "Visible now.");
    } finally {
        await db.close();
    }
});
