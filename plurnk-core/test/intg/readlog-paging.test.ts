// {§methods-log-read} {§methods-readable-reasoning} — a reader pages back through the whole log, and the row carrying a
// turn's reasoning names the request that streamed it, so a client can match what it watched stream.
import test from "node:test";
import assert from "node:assert/strict";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import type { LogEntryWire } from "@plurnk/plurnk-contracts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { serverProposals } from "./_approval.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";

const work = "````NOTE\nPlan the notes.\n````\n````EDIT (workspace:///a.md)\nfirst\n````\n````READ (workspace:///a.md)\n````";
const done = "````SEND [200]\nDone.\n````";

const streamed = (frames: readonly object[]): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

test("{§methods-log-read} {§methods-readable-reasoning} beforeId pages newest first through the whole log, and the reasoning row names its streaming request", async (t) => {
    serverProposals(t, "accept");
    let calls = 0;
    const provider = new AiSdkProvider({
        model: "paging-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            const frames: object[] = [];
            if (calls++ === 0) {
                frames.push({ id: "paging", model: "paging-witness", choices: [{ index: 0, delta: { reasoning_content: "Weighing the plan." }, finish_reason: null }] });
            }
            frames.push({ id: "paging", model: "paging-witness", choices: [{ index: 0, delta: { content: calls === 1 ? work : done }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
            return streamed(frames);
        },
    });
    await withDaemon(provider, async (db, daemon) => {
        const streams: Array<{ modelCallId: number; requestSequence: number }> = [];
        daemon.subscribeToEvents((_workspaceId, method, params) => {
            const event = params as { phase?: string; modelCallId: number; requestSequence: number };
            if (method === "reasoning/event" && event.phase === "start") streams.push(event);
        });
        const { workspaceId } = await daemon.createWorkspace({ name: `paging-${crypto.randomUUID()}` });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Note a." });
        const status = await waitForDb(() => new LoopLifecycle(db).status(loopId), (value) => value === 200 || value >= 400);
        if (status !== 200) {
            const rows = await daemon.readLog({ workspaceId, sessionId, limit: 50 });
            assert.fail(`loop ${status}: ${JSON.stringify(rows.map(({ loop_seq, turn_seq, sequence, origin, op, status_rx, rx }) => [loop_seq, turn_seq, sequence, origin, op, status_rx, JSON.stringify(rx).slice(0, 160)]))}`);
        }

        const whole = await daemon.readLog({ workspaceId, sessionId, limit: 1000 });
        assert.ok(whole.length >= 4, `the loop wrote its rows: ${whole.length}`);
        assert.deepEqual(whole.map(({ id }) => id), whole.map(({ id }) => id).toSorted((left, right) => right - left), "newest first");
        const paged: LogEntryWire[] = [];
        for (let beforeId: number | undefined; ;) {
            const page = await daemon.readLog({ workspaceId, sessionId, limit: 2, ...(beforeId === undefined ? {} : { beforeId }) });
            if (page.length === 0) break;
            paged.push(...page);
            beforeId = page.at(-1)!.id;
        }
        assert.deepEqual(paged.map(({ id }) => id), whole.map(({ id }) => id), "the pages are the whole log, nothing skipped or repeated");

        const carriers = whole.filter(({ reasoning }) => typeof reasoning === "string");
        assert.equal(carriers.length, 1, "one row carries the turn's reasoning");
        assert.equal(carriers[0].reasoning, "Weighing the plan.");
        assert.equal(streams.length, 1, "the turn's one request streamed its reasoning");
        assert.deepEqual(
            { call: carriers[0].reasoning_model_call_id, request: carriers[0].reasoning_request_sequence },
            { call: streams[0].modelCallId, request: streams[0].requestSequence },
            "the row names the request that streamed it",
        );
        assert.ok(whole.filter(({ reasoning }) => reasoning === undefined).every((row) => row.reasoning_model_call_id === undefined),
            "a row without reasoning names no request");
    });
});
