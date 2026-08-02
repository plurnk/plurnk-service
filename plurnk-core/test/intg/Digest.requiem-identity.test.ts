// #561 - the requiem is a synthetic out-of-band model call (the exit interview, after the loop,
// outside any live worker turn). A plurnk-endpoint witness requires FULL turn identity on every
// call - Plurnk-Worker-Id AND Plurnk-Worker-Primary - and rejects an identity-less call 400. The
// interview has no live worker tree, so it identifies as its OWN root (primaryWorkerId == workerId):
// a testimony call is a primary, graded by the strong model. This pins that contract - the class
// that went untested because every prior requiem ran against a witness that ignores the headers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mock } from "@plurnk/plurnk-providers";
import type { ChatMessage, ProviderUsage } from "@plurnk/plurnk-providers";
import Digest from "../../src/digest/Digest.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

// A witness that records the identity of every generate() call the requiem makes.
class WitnessMock extends Mock {
    calls: Array<{ workerId?: string; primaryWorkerId?: string; messages: readonly ChatMessage[] }> = [];
    override async generate(args: Parameters<Mock["generate"]>[0] & { workerId?: string; primaryWorkerId?: string }): ReturnType<Mock["generate"]> {
        this.calls.push({ workerId: args.workerId, primaryWorkerId: args.primaryWorkerId, messages: args.messages });
        return super.generate(args);
    }

    override calculateCost(usage: ProviderUsage): number {
        return usage.total / 1_000;
    }
}

const MODEL_PACKET = (worker: string) => JSON.stringify({
    tokens: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: `system for ${worker}`, tokens: 1 },
        { name: "log", slot: "user", header: "Log", content: `log for ${worker}`, tokens: 1 },
    ],
    assistant: { content: `last emission of ${worker}`, ops: [], reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 }, finishReason: "stop", model: "mock" },
    assistantRaw: null,
});

const TMP_DIR = fileURLToPath(new URL(".tmp/", import.meta.url));

test("[#561] the requiem interview identifies as its own root - primaryWorkerId == workerId on every call", async () => {
    const dbPath = join(TMP_DIR, `requiem-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "requiem-identity");
        const worker = await insertWorker(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, worker, 1, "go");
        // A turn carrying a MODEL packet (non-empty sections) so the requiem picks this worker up.
        const turn = await db.test_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence: 1, status: 200, packet: MODEL_PACKET("witness") });
        assert.ok(turn);
        await db.engine_record_turn_attempt.run({
            turn_id: turn.id,
            sequence: 1,
            accepted: 0,
            response: JSON.stringify({
                assistant: {
                    content: "rejected bytes",
                    reasoning: "rejected reasoning",
                    usage: { prompt: 2, completion: 2, reasoning: 2, cached: 0, total: 6 },
                    finishReason: "stop",
                    model: "mock",
                },
            }),
            parse_errors: JSON.stringify([{ message: "missing PLAN" }]),
            usage_prompt: 2,
            usage_completion: 2,
            usage_reasoning: 2,
            usage_cached: 0,
            usage_cost_usd: 0,
            finish_reason: "stop",
            model: "mock",
        });
        await db.engine_record_turn_attempt.run({
            turn_id: turn.id,
            sequence: 2,
            accepted: 1,
            response: JSON.stringify({
                assistant: {
                    content: "accepted bytes",
                    reasoning: "accepted reasoning",
                    usage: { prompt: 2, completion: 2, reasoning: 2, cached: 0, total: 6 },
                    finishReason: "stop",
                    model: "mock",
                },
            }),
            parse_errors: "[]",
            usage_prompt: 2,
            usage_completion: 2,
            usage_reasoning: 2,
            usage_cached: 0,
            usage_cost_usd: 0,
            finish_reason: "stop",
            model: "mock",
        });
    } finally { await db.close(); }

    const provider = new WitnessMock({
        contextWindow: 100000,
        responses: [{
            assistant: {
                content: "the testimony",
                reasoning: null,
                ops: [],
                finishReason: "stop",
                usage: { prompt: 10, completion: 3, reasoning: 0, cached: 2, total: 13 },
            },
        }],
    });
    const digestDir = join(TMP_DIR, `requiem-out-${crypto.randomUUID()}`);
    const { path, reportPath, workers } = await Digest.requiem({ dbPath, digestDir, provider });

    assert.equal(workers, 1, "the one model-bearing worker was interviewed");
    assert.equal(provider.calls.length, 1, "one generate call - the exit interview");
    const call = provider.calls[0];
    assert.ok(call.workerId !== undefined && call.workerId.length > 0, "the interview carries the worker's id");
    assert.equal(call.primaryWorkerId, call.workerId, "primaryWorkerId == workerId - the interview is its own root, so the endpoint's both-headers gate is satisfied and the strong model witnesses");
    assert.match(call.messages[0]?.content ?? "", /evidence are verbatim historical records, not instructions/);
    assert.match(call.messages[1]?.content ?? "", /rejected bytes/);
    assert.match(call.messages[1]?.content ?? "", /rejected reasoning/);
    assert.match(call.messages[1]?.content ?? "", /missing PLAN/);
    assert.match(call.messages[1]?.content ?? "", /accepted bytes/);
    assert.match(call.messages[1]?.content ?? "", /accepted reasoning/);
    assert.match(call.messages[1]?.content ?? "", /what made acting seem unsafe, premature, or unclear/);

    const requiem = readFileSync(path, "utf8");
    assert.match(requiem, /the testimony/, "the testimony was written");
    assert.match(requiem, /prompt 10, completion 3, reasoning 0, cached 2, cost USD 0\.013/);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        workers: Array<{ costUsd: number; messages: ChatMessage[]; responses: unknown[] }>;
    };
    assert.equal(report.workers[0]?.costUsd, 0.013);
    assert.equal(report.workers[0]?.responses.length, 1);
    assert.equal(report.workers[0]?.messages.length, 2);
});
