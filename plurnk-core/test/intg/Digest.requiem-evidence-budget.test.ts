// {§digest-requiem-evidence-budget} — quoted evidence is budgeted to the witness window;
// overflow elides the oldest attempts behind an explicit marker and the interview succeeds.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mock } from "@plurnk/plurnk-providers";
import type { ChatMessage, ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import Digest from "../../src/digest/Digest.ts";
import type { Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, testDeferredProviderCapacity } from "./_helpers.ts";

class WitnessMock extends Mock {
    calls: Array<{ messages: readonly ChatMessage[] }> = [];
    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        this.calls.push({ messages: args.messages });
        return super.generate(args);
    }
}

const MODEL_PACKET = JSON.stringify({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: "system for budget", weight: 1 },
        { name: "log", slot: "user", header: "Log", content: "log for budget", weight: 1 },
    ],
    attributions: [],
    assistant: { content: "final emission", ops: [], reasoning: null },
    assistantRaw: null,
});

const TMP_DIR = fileURLToPath(new URL(".tmp/", import.meta.url));

const recordFatAttempt = async (db: Db, turnId: number, marker: string): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turnId,
        kind: "emission",
        attributions: "[]",
        model: "mock",
    });
    if (modelCall === undefined) throw new Error("budget fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: modelCall.id });
    if (attempt === undefined) throw new Error("budget fixture attempt did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:mock",
        model: "mock",
        outcome: "response",
        usage: {
            inputTokens: 2,
            outputTokens: 4,
            totalTokens: 6,
            inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0 },
            outputTokenDetails: { textTokens: 2, reasoningTokens: 2 },
        },
        cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "budget fixture" },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("budget fixture provider request did not open");
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        response: JSON.stringify({
            assistant: { content: `${marker} ${"x".repeat(2600)}`, reasoning: null, finishReason: "stop", model: "mock" },
        }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("requiem:budget")),
        finish_reason: "stop",
        model: "mock",
    });
    await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
};

test("{§digest-requiem-evidence-budget}: overflowing evidence elides oldest attempts behind a marker and the interview lands", async () => {
    const savedMax = process.env.PLURNK_SERVICE_REQUIEM_MAX_TOKENS;
    const savedRetry = process.env.PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS;
    process.env.PLURNK_SERVICE_REQUIEM_MAX_TOKENS = "256";
    process.env.PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS = "512";
    try {
        const dbPath = join(TMP_DIR, `requiem-budget-${crypto.randomUUID()}.db`);
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "requiem-budget");
            const worker = await insertWorker(db, workspaceId, null, "budgeted");
            const loopId = await insertLoop(db, worker, 1, "go");
            for (let sequence = 1; sequence <= 6; sequence += 1) {
                const turn = await db.test_insert_turn.get<{ id: number }>({
                    loop_id: loopId,
                    sequence,
                    status: 200,
                    packet: MODEL_PACKET,
                });
                assert.ok(turn);
                await recordFatAttempt(db, turn.id, `attempt-marker-${sequence}`);
            }
        } finally { await db.close(); }

        const provider = new WitnessMock({
            contextWindow: 4096,
            responses: [{
                assistant: { content: "budgeted testimony", reasoning: null, ops: [], finishReason: "stop" },
                usage: {
                    inputTokens: 10,
                    outputTokens: 3,
                    totalTokens: 13,
                    inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2 },
                    outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
                },
                cost: { kind: "estimated", amount: { amount: "0.001", currency: "USD" }, source: "budget witness" },
            }],
        });
        const digestDir = join(TMP_DIR, `requiem-budget-out-${crypto.randomUUID()}`);
        const { workers } = await Digest.requiem({ dbPath, digestDir, provider });

        assert.equal(workers, 1, "the worker was interviewed despite overflowing evidence");
        assert.equal(provider.calls.length, 1, "one interview call");
        const user = provider.calls[0].messages[1];
        assert.equal(user.role, "user");
        const content = user.content;
        // Window 4096 − retry 512 − system estimate − margin 1024 bounds the message.
        assert.ok(content.length <= (4096 - 512 - 1024) * 2, `budgeted user message; got ${content.length} chars`);
        assert.match(content, /elidedOldestAttempts/, "the elision is an explicit marker");
        assert.match(content, /quoted evidence exceeded the witness interview window/);
        assert.match(content, /attempt-marker-6/, "the newest attempt testifies");
        assert.doesNotMatch(content, /attempt-marker-1 /, "the oldest attempt elided");
        const report = provider.calls[0].messages;
        assert.equal(report.length, 2, "system + budgeted user evidence only");
    } finally {
        if (savedMax === undefined) delete process.env.PLURNK_SERVICE_REQUIEM_MAX_TOKENS;
        else process.env.PLURNK_SERVICE_REQUIEM_MAX_TOKENS = savedMax;
        if (savedRetry === undefined) delete process.env.PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS;
        else process.env.PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS = savedRetry;
    }
});
