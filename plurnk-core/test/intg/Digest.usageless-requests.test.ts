// {§digest-forensic-fidelity} — settled requests without any usage are named on the
// worker's Cost line instead of silently pricing the run as if they were free.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import Digest from "../../src/digest/Digest.ts";
import type { Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, testDeferredProviderCapacity } from "./_helpers.ts";

const MODEL_PACKET = JSON.stringify({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: "system", weight: 1 },
        { name: "log", slot: "user", header: "Log", content: "log", weight: 1 },
    ],
    attributions: [],
    assistant: { content: "emission", ops: [], reasoning: null },
    assistantRaw: null,
});

const TMP_DIR = fileURLToPath(new URL(".tmp/", import.meta.url));

const recordAttempt = async (db: Db, turnId: number, accounting: ProviderRequestAccounting, failed: boolean): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turnId,
        kind: "emission",
        attributions: "[]",
        model: "mock",
    });
    if (modelCall === undefined) throw new Error("usage-less fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: modelCall.id });
    if (attempt === undefined) throw new Error("usage-less fixture attempt did not open");
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("usage-less fixture provider request did not open");
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        response: failed ? null : JSON.stringify({ assistant: { content: "ok", reasoning: null, finishReason: "stop", model: "mock" } }),
        failure: failed ? JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 400 }) : null,
        capacity: JSON.stringify(testDeferredProviderCapacity("usage-less:fixture")),
        finish_reason: failed ? null : "stop",
        model: "mock",
    });
    if (!failed) await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
};

test("{§digest-forensic-fidelity}: a settled request without usage is named on the Cost line", async () => {
    const dbPath = join(TMP_DIR, `usageless-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "usage-less");
        const worker = await insertWorker(db, workspaceId, null, "biller");
        const loopId = await insertLoop(db, worker, 1, "go");
        const turnOne = await db.test_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence: 1, status: 200, packet: MODEL_PACKET });
        assert.ok(turnOne);
        await recordAttempt(db, turnOne.id, {
            provider: "provider:mock",
            model: "mock",
            outcome: "response",
            usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0 },
                outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
            },
            cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" },
        }, false);
        const turnTwo = await db.test_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence: 2, status: 200, packet: MODEL_PACKET });
        assert.ok(turnTwo);
        // The aborted/errored exchange: settled, no usage reported at all.
        await recordAttempt(db, turnTwo.id, {
            provider: "provider:mock",
            model: "mock",
            outcome: "error",
            status: 400,
            cost: { kind: "unknown", reason: "the provider response reported no normalized usage" },
        }, true);
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `usageless-out-${crypto.randomUUID()}`);
    Digest.run({ dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(
        markdown,
        /Cost: {7}\S+ \(\+1 usage-less request — server-side spend unrecorded\)/,
        "the Cost line names the usage-less exchange",
    );
});
