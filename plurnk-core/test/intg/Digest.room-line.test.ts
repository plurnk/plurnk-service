// {§digest-room-line} — the room in provider tokens, from run397's last two requests: a budget held at a
// stale conversion showed the model 124% of the provider's capacity, and the wall's estimate admitted a
// request the provider's exact count refused.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assessRequestCapacity } from "@plurnk/plurnk-providers";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { testArtifactPath } from "../../../scripts/test-artifacts.ts";
import type { Db } from "../../src/core/Db.ts";
import type { DurablePacket } from "../../src/core/StoredPacket.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertPacketTurn } from "./_db.ts";

const TMP_DIR = testArtifactPath("core");

const packetAt = (weight: number, budget: number): DurablePacket => ({
    weight,
    sections: [
        { name: "system", slot: "system", header: null, content: "system", weight: 1 },
        { name: "budget", slot: "user", header: "Context", content: JSON.stringify({ tokens: weight, budget, largest: [] }), weight: 1 },
    ],
    attributions: [],
});

// The rtx5070 lane: a 86,016-token window, a 24,576-token output budget and an 8,602-token floor.
const capacityOf = (tokens: number) => assessRequestCapacity({
    contextWindow: 86_016, maxInputTokens: null, maxOutputTokens: null,
    outputBudget: 24_576, outputFloor: 8_602, reasoningBudget: 16_384,
    measurement: { kind: "exact", tokens, source: "llama-server:/v1/chat/completions/input_tokens" },
});

const recordCall = async (db: Db, turnId: number, tokens: number, sent: boolean): Promise<void> => {
    const call = await db.engine_open_model_call.get<{ id: number }>({ turn_id: turnId, kind: "emission", attributions: "[]", model: "qwen" });
    if (call === undefined) throw new Error("room fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
    if (attempt === undefined) throw new Error("room fixture attempt did not open");
    if (sent) {
        const request = await db.engine_open_provider_request.get<{ id: number }>({ inference_call_id: call.id, sequence: 1, provider: "provider:fixture", model: "qwen" });
        if (request === undefined) throw new Error("room fixture provider request did not open");
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, {
            provider: "provider:fixture", model: "qwen", outcome: "response",
            usage: { inputTokens: tokens, outputTokens: 1, totalTokens: tokens + 1 },
            cost: { kind: "unknown", reason: "fixture" },
        }));
    }
    await db.engine_observe_model_call_response.run({
        id: call.id,
        native_inputs: "[]",
        response: sent ? JSON.stringify({ assistant: { content: "ok", reasoning: null, finishReason: "stop", model: "qwen" } }) : null,
        failure: sent ? null : JSON.stringify({ providerKind: "capacity_exceeded", providerStatus: 413 }),
        capacity: JSON.stringify(capacityOf(tokens)),
        finish_reason: sent ? "stop" : null,
        model: "qwen",
    });
    if (sent) await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
};

test("{§digest-room-line}: the worker summary measures the room the model was shown against the provider's capacity and count", async () => {
    const dbPath = join(TMP_DIR, `room-line-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "room-line");
        const worker = await insertWorker(db, workspaceId, null, "bench");
        const loopId = await insertLoop(db, worker, 1, "go");
        await recordCall(db, await insertPacketTurn(db, loopId, 20, packetAt(91_030, 91_987), 102), 75_448, true);
        await recordCall(db, await insertPacketTurn(db, loopId, 21, packetAt(95_714, 91_987), 413), 78_492, false);
        const quiet = await insertWorker(db, workspaceId, null, "quiet");
        await insertLoop(db, quiet, 1, "go");
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `room-line-out-${crypto.randomUUID()}`);
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /^Room: {7}budget up to 124% of capacity · wall estimate -19\.4% to -18\.6% of the count {2}⚠ 1 over the wall the estimate admitted$/mu);
    assert.match(markdown, /^Room: {7}\(no measured requests\)$/mu, "a worker without measured requests says so");
});
