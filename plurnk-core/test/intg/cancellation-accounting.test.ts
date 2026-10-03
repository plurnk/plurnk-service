import test from "node:test";
import assert from "node:assert/strict";
import { AiSdkProvider, type ProviderCost } from "@plurnk/plurnk-providers";
import { insertLoop, insertWorker } from "./_db.ts";
import Dsl from "./dsl.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";

for (const reported of [false, true]) {
    for (const stop of ["KILL", "shutdown"] as const) {
        test(`{§tokenomics-provider-usage} ${stop} retains cancelled child accounting; reported=${reported} (#971)`, async () => {
            const charge: ProviderCost = {
                kind: "charged", amount: { amount: "0.0123", currency: "USD" }, source: "fixture response",
            };
            let calls = 0;
            const provider = new AiSdkProvider({
                model: "cancellation-witness", url: "https://example.test/v1/chat/completions",
                contextWindow: 100_000, streaming: true,
                fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
                temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 3,
                normalizeCost: (evidence) => evidence.charge as ProviderCost | undefined,
                fetch: async (_url, init) => {
                    calls++;
                    return new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                                id: "cancelled-child", model: "cancellation-witness",
                                choices: [{ index: 0, delta: {
                                    reasoning_content: "Still reasoning.",
                                    content: "````EDIT (worker:///must-not-exist.txt)\nnot authorized after cancellation\n````",
                                }, finish_reason: null }],
                                ...(reported ? {
                                    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, charge,
                                } : {}),
                            })}\n\n`));
                            init?.signal?.addEventListener("abort", () => {
                                controller.error(new DOMException("Request aborted", "AbortError"));
                            }, { once: true });
                        },
                    }), { headers: { "content-type": "text/event-stream" } });
                },
            });
            await withDaemon(provider, async (db, daemon) => {
                const { workspaceId } = await daemon.createWorkspace({ name: `cancellation-${stop}-${reported}` });
                const parent = await daemon.ensureModelWorker(workspaceId);
                const parentLoop = await insertLoop(db, parent, 1, "parent delegation");
                const child = await insertWorker(db, workspaceId, parent, "child", "model");
                const observed = Promise.withResolvers<void>();
                const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
                    const event = params as { workerId?: number; phase?: string };
                    if (method === "reasoning/event" && event.workerId === child && event.phase === "content") observed.resolve();
                });
                try {
                    const task = await daemon.runLoop({ workspaceId, workerId: child, prompt: "Think about the task." });
                    await observed.promise;
                    if (stop === "KILL") {
                        const result = await daemon.dispatchAsClient({
                            workspaceId, workerId: parent,
                            statement: Dsl.parseSingleStatement("````KILL (worker://child)\n````"),
                        });
                        assert.equal(result.status, 200);
                    } else {
                        await daemon.stop();
                    }
                    const turns = await waitForDb(
                        () => db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; completed_at: string | null }>({ loop_id: task.loopId }),
                        (rows) => rows.some(({ kind }) => kind === "inference") && rows.every(({ completed_at }) => completed_at !== null),
                    );
                    const turn = turns.find(({ kind }) => kind === "inference")!;
                    assert.equal(turn.status, 499);
                    const requests = await db.test_provider_requests.all<{
                        state: string; outcome: string; usage_input: number | null; usage_output: number | null;
                        cost_kind: string; cost_amount: string | null; evidence: string;
                    }>({ turn_id: turn.id });
                    assert.equal(requests.length, 1);
                    assert.equal(requests[0]!.state, "settled");
                    assert.equal(requests[0]!.outcome, "error");
                    assert.equal(requests[0]!.usage_input, reported ? 100 : null);
                    assert.equal(requests[0]!.usage_output, reported ? 10 : null);
                    assert.equal(requests[0]!.cost_kind, reported ? "charged" : "unknown");
                    assert.equal(requests[0]!.cost_amount, reported ? "0.0123" : null);
                    const evidence = JSON.parse(requests[0]!.evidence);
                    assert.equal(evidence.reasoning, "Still reasoning.");
                    assert.match(evidence.content, /must-not-exist.txt/);
                    assert.equal(evidence.rawBody[0].id, "cancelled-child");
                    assert.match(JSON.stringify(evidence.error), /cancel|abort|shutdown/i);
                    const descendants = await daemon.descendantAccounting({ workspaceId, workerId: parent, loopId: parentLoop });
                    assert.equal(descendants.requests.length, 1);
                    assert.equal(descendants.costUsd, reported ? "0.0123" : null);
                    assert.equal(descendants.usage?.inputTokens, reported ? 100 : undefined);
                    assert.deepEqual(descendants, await daemon.engine.descendantAccounting(parent, parentLoop));
                    assert.equal(calls, 1, "cancellation never starts a replacement request");
                    assert.equal(await db.test_get_entry_by_pathname_scheme.get({ pathname: "/must-not-exist.txt", scheme: "worker" }), undefined,
                        "a cancelled partial emission never executes");
                    assert.deepEqual(await db.test_error_rows_for_worker.all({ worker_id: child }), [],
                        "cancellation is lifecycle truth, not a new model-facing provider error");
                } finally {
                    unsubscribe();
                    if (stop === "KILL") await daemon.cancelWorker({ workspaceId, workerId: parent });
                }
            });
        });
    }
}
