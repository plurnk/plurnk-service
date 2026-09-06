import assert from "node:assert/strict";
import test from "node:test";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { Translator } from "@plurnk/plurnk-agui";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { waitFor } from "./_rpc.ts";

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

for (const style of ["structured", "think-tags"] as const) test(`{§notifications-reasoning-event}: interleaved ${style} responses retain their worker, packet and accounting owners`, async () => {
    const db = await openMigrated();
    const cancellation = new AbortController();
    const pending: Array<Promise<unknown>> = [];
    try {
        const workspaceId = await insertWorkspace(db, `concurrent-reasoning-${style}`);
        const workers: Array<{ name: string; workerId: number; loopId: number }> = [];
        for (const name of ["alpha", "bravo", "charlie"]) {
            const workerId = await insertWorker(db, workspaceId, null, name);
            const loopId = await insertLoop(db, workerId, 1, `Report ONLY_${name}.`);
            workers.push({ name, workerId, loopId });
        }
        const observed = new Map<number, string[]>();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), reasoningEventNotify(_workspace, event) {
            if (event.phase !== "content") return;
            const deltas = observed.get(event.workerId) ?? [];
            deltas.push(event.delta);
            observed.set(event.workerId, deltas);
        } });
        const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
        const requests = new Map<string, Record<string, unknown>>();
        const provider = new AiSdkProvider({
            model: "m", url: "https://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000, firstContentTimeoutMs: 0,
            temperature: 0.2, repeatPenalty: null, retryAttempts: 0,
            reasoning: { mode: "adaptive", budget: null }, rawBody: true,
            reasoningResponseStyle: style === "think-tags" ? "think-tags" : "verbatim",
            supportsSlotPinning: true, slotCount: 2,
            fetch: async (_url, init) => {
                const body = JSON.parse(String(init?.body));
                const input = JSON.stringify(body.messages);
                const owners = workers.filter(({ name }) => input.includes(`ONLY_${name}`));
                assert.equal(owners.length, 1, "each request carries exactly its own prompt");
                const { name } = owners[0]!;
                requests.set(name, body);
                return new Response(new ReadableStream<Uint8Array>({ start(stream) {
                    streams.set(name, stream);
                } }), { headers: { "Content-Type": "text/event-stream" } });
            },
        });
        const running = workers.map(({ workerId, loopId }) => engine.runTurn({
            provider, workspaceId, workerId, loopId, messages: [], signal: cancellation.signal,
        }));
        pending.push(...running);
        const emit = (name: string, delta: object, finish: string | null = null, usage?: object): void => {
            streams.get(name)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                id: "shared-server-id", object: "chat.completion.chunk", created: 1, model: "m",
                choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
            })}\n\n`));
        };
        await waitFor(() => [...streams.keys()], (names) => names.length === workers.length);
        assert.equal(new Set([...requests.values()].map(({ id_slot }) => id_slot)).size, 2,
            "shared backend affinity does not become a response ownership key");
        for (const { name } of workers.toReversed()) emit(name, style === "structured"
            ? { reasoning_content: `Thinking ${name}.` } : { content: `<think>Thinking ${name}.` });
        await waitFor(() => [...observed.keys()], (ids) => ids.length === workers.length);
        for (const { name, workerId } of workers) assert.equal(observed.get(workerId)!.join(""), `Thinking ${name}.`);
        // Finish in a different order from admission while all three streams overlap.
        for (const index of [1, 2, 0]) {
            const { name } = workers[index]!;
            emit(name, { content: `${style === "think-tags" ? "</think>" : ""}## PLAN0\n[]\n### SEND0 (TERM)\nONLY_${name}` }, "stop", {
                prompt_tokens: 10 + index, completion_tokens: 20 + index, total_tokens: 30 + 2 * index,
            });
            streams.get(name)!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            streams.get(name)!.close();
        }
        const results = await Promise.all(running);
        for (const [index, { turnId, status }] of results.entries()) {
            const { name, workerId } = workers[index]!;
            assert.equal(status, 200);
            const calls = await db.test_model_calls.all<{ response: string }>({ turn_id: turnId });
            const response = JSON.parse(calls[0]!.response);
            assert.equal(response.assistant.reasoning, `Thinking ${name}.`);
            assert.match(response.assistant.content, new RegExp(`ONLY_${name}$`));
            for (const other of workers.filter((worker) => worker.workerId !== workerId)) {
                assert.ok(!JSON.stringify(response.rawBody).includes(other.name), "forensic raw chunks belong to this request only");
            }
            const resources = await db.test_reasoning_resources.all<{ content: string }>({ worker_id: workerId });
            assert.deepEqual(resources.map(({ content }) => content), [`Thinking ${name}.`]);
            const accounting = await db.test_provider_requests.all<{ usage_input: number; usage_output: number }>({ turn_id: turnId });
            assert.deepEqual(accounting.map(({ usage_input, usage_output }) => [usage_input, usage_output]), [[10 + index, 20 + index]]);
        }
    } finally {
        cancellation.abort();
        await Promise.allSettled(pending);
        await db.close();
    }
});
