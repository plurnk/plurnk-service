// {§methods-stream-invocation} — a stream observation names the execution it observes, so a client pairs the output
// with the operation that produced it without matching addresses.
import test from "node:test";
import assert from "node:assert/strict";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import type { LogEntryWire } from "@plurnk/plurnk-contracts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { serverProposals } from "./_approval.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

const streamed = (content: string): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
        const frame = { id: "invocation", model: "invocation-witness", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

test("{§methods-stream-invocation} a stream's observation names the execution that opened it, on readLog and log/entry alike", async (t) => {
    serverProposals(t, "accept");
    let calls = 0;
    const provider = new AiSdkProvider({
        model: "invocation-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => streamed(calls++ === 0 ? "````sh\nprintf 'hello\\n'\n````\n````WAIT\n````" : "````SEND [200]\nDone.\n````"),
    });
    await withDaemon(provider, async (db, daemon) => {
        const announced: LogEntryWire[] = [];
        daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "log/entry") announced.push((params as { entry: LogEntryWire }).entry);
        });
        const { workspaceId } = await daemon.createWorkspace({ name: `invocation-${crypto.randomUUID()}` });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Say hello." });
        const status = await waitForDb(() => new LoopLifecycle(db).status(loopId), (value) => value === 200 || value >= 400);
        assert.equal(status, 200);

        const rows = await daemon.readLog({ workspaceId, workerId, limit: 1000 });
        const execution = rows.find(({ op }) => op === "sh");
        assert.ok(execution, "the command ran");
        const observations = rows.filter(({ invocation }) => invocation !== undefined);
        assert.deepEqual(observations.map(({ origin, op, rx }) => [origin, op, (rx as { content?: unknown }).content]), [["_plurnk", "READ", "hello\n"]],
            "exactly the stream's observation names an execution");
        assert.equal(observations[0]!.invocation, `log:///${execution.loop_seq}/${execution.turn_seq}/${execution.sequence}/sh`,
            "it names the execution that opened the stream");
        assert.equal(observations[0]!.source, null, "the observation's attribution is unchanged");
        const live = announced.find(({ id }) => id === observations[0]!.id);
        assert.equal(live?.invocation, observations[0]!.invocation, "log/entry carries it as readLog does");
    });
});
