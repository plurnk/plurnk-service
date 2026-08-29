// {§digest-requiem} — a synthetic interview carries a complete self-root identity.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mock } from "@plurnk/plurnk-providers";
import type { ChatMessage, ProviderAccounting, ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import Digest from "../../src/digest/Digest.ts";
import type { Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, testDeferredProviderCapacity } from "./_helpers.ts";

// A witness that records the identity of every generate() call the requiem makes.
class WitnessMock extends Mock {
    calls: Array<{ workerId?: string; primaryWorkerId?: string; messages: readonly ChatMessage[] }> = [];
    onGenerate?: () => void;
    override async generate(args: Parameters<Mock["generate"]>[0] & { workerId?: string; primaryWorkerId?: string }): ReturnType<Mock["generate"]> {
        this.onGenerate?.();
        this.calls.push({ workerId: args.workerId, primaryWorkerId: args.primaryWorkerId, messages: args.messages });
        return super.generate(args);
    }
}

const MODEL_PACKET = (worker: string) => JSON.stringify({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: `system for ${worker}`, weight: 1 },
        { name: "log", slot: "user", header: "Log", content: `log for ${worker}`, weight: 1 },
    ],
    attributions: [],
    assistant: { content: `last emission of ${worker}`, ops: [], reasoning: null },
    assistantRaw: null,
});

const TMP_DIR = fileURLToPath(new URL(".tmp/", import.meta.url));

const recordResponseAttempt = async (db: Db, args: {
    turnId: number;
    sequence: number;
    accepted: boolean;
    response: unknown;
    parseErrors: unknown[];
}): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number; sequence: number }>({
        turn_id: args.turnId,
        kind: "emission",
        attributions: "[]",
        model: "mock",
    });
    if (modelCall === undefined) throw new Error("requiem fixture model call did not open");
    assert.equal(modelCall.sequence, args.sequence);
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        model_call_id: modelCall.id,
    });
    if (attempt === undefined) throw new Error("requiem fixture attempt did not open");
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
        cost: {
            kind: "estimated",
            amount: { amount: "0", currency: "USD" },
            source: "requiem fixture",
        },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("requiem fixture provider request did not open");
    const settled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request.id, accounting),
    );
    assert.equal(settled.changes, 1);
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        response: JSON.stringify(args.response),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("requiem:fixture")),
        finish_reason: "stop",
        model: "mock",
    });
    await db.engine_classify_turn_attempt_response.run({
        id: attempt.id,
        accepted: args.accepted ? 1 : 0,
        parse_errors: JSON.stringify(args.parseErrors),
    });
};

test("{§digest-requiem}: every interview identifies as its own root", async () => {
    const dbPath = join(TMP_DIR, `requiem-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "requiem-identity");
        const worker = await insertWorker(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, worker, 1, "go");
        // A turn carrying a MODEL packet (non-empty sections) so the requiem picks this worker up.
        const turn = await db.test_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence: 1, status: 200, packet: MODEL_PACKET("witness") });
        assert.ok(turn);
        await recordResponseAttempt(db, {
            turnId: turn.id,
            sequence: 1,
            accepted: false,
            response: {
                assistant: {
                    content: "rejected bytes",
                    reasoning: "rejected reasoning",
                    finishReason: "stop",
                    model: "mock",
                },
                assistantRaw: {
                    digest: "rejected transport",
                    rawBody: { chunks: ["same", "body"] },
                },
                rawBody: { chunks: ["same", "body"] },
                meta: { request: "rejected" },
            },
            parseErrors: [{ message: "missing PLAN" }],
        });
        await recordResponseAttempt(db, {
            turnId: turn.id,
            sequence: 2,
            accepted: true,
            response: {
                assistant: {
                    content: "accepted bytes",
                    reasoning: "accepted reasoning",
                    finishReason: "stop",
                    model: "mock",
                },
                assistantRaw: {
                    digest: "accepted transport",
                    rawBody: { chunks: ["different", "nested"] },
                },
                rawBody: { chunks: ["canonical", "top-level"] },
                meta: { request: "accepted" },
            },
            parseErrors: [],
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
            },
            usage: {
                inputTokens: 10,
                outputTokens: 3,
                totalTokens: 13,
                inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2 },
                outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
            },
            cost: {
                kind: "estimated",
                amount: { amount: "0.013", currency: "USD" },
                source: "requiem witness",
            },
        }],
    });
    const digestDir = join(TMP_DIR, `requiem-out-${crypto.randomUUID()}`);
    Digest.run({ dbPath, digestDir });
    const durableAttempt = JSON.parse(readFileSync(
        join(digestDir, "packet000.attempt001.rejected.response.json"),
        "utf8",
    )) as { assistantRaw?: { rawBody?: unknown }; rawBody?: unknown };
    assert.deepEqual(durableAttempt.rawBody, { chunks: ["same", "body"] });
    assert.deepEqual(
        durableAttempt.assistantRaw?.rawBody,
        durableAttempt.rawBody,
        "standalone forensic evidence retains the exact stored raw-body carriers",
    );
    let observedDurableOpenCall = false;
    provider.onGenerate = () => {
        const journal = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
            workers: Array<{ calls: Array<{ state: string }> }>;
        };
        assert.equal(journal.workers[0]?.calls[0]?.state, "open");
        observedDurableOpenCall = true;
    };
    const { path, reportPath, workers } = await Digest.requiem({ dbPath, digestDir, provider });

    assert.equal(workers, 1, "the one model-bearing worker was interviewed");
    assert.equal(observedDurableOpenCall, true, "call identity is materialized before provider I/O");
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
    const evidenceText = call.messages[1]?.content
        .split("# Verbatim worker evidence\n\n")[1]
        ?.split("\n\n# Audit request")[0];
    assert.ok(evidenceText !== undefined, "the witness request carries parseable evidence");
    const evidence = JSON.parse(evidenceText) as {
        providerAttempts: Array<{
            response: {
                assistantRaw?: { digest?: string; rawBody?: unknown };
                rawBody?: unknown;
                meta?: unknown;
            };
        }>;
    };
    assert.deepEqual(
        evidence.providerAttempts[0]?.response,
        {
            assistant: {
                content: "rejected bytes",
                reasoning: "rejected reasoning",
                finishReason: "stop",
                model: "mock",
            },
            assistantRaw: { digest: "rejected transport" },
            meta: { request: "rejected" },
        },
        "raw transport is excluded without changing normalized attempt evidence",
    );
    assert.deepEqual(
        evidence.providerAttempts[1]?.response,
        {
            assistant: {
                content: "accepted bytes",
                reasoning: "accepted reasoning",
                finishReason: "stop",
                model: "mock",
            },
            assistantRaw: { digest: "accepted transport" },
            meta: { request: "accepted" },
        },
        "all raw-body carriers are excluded even when their transport records differ",
    );

    const requiem = readFileSync(path, "utf8");
    assert.match(requiem, /the testimony/, "the testimony was written");
    assert.match(requiem, /input=10 output=3 reasoning=0 cache-read=2, cost USD 0\.013/);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        workers: Array<{ accounting: ProviderAccounting; messages: ChatMessage[]; responses: unknown[] }>;
    };
    assert.equal(report.workers[0]?.accounting.costUsd, "0.013");
    assert.equal(report.workers[0]?.accounting.requests.length, 1);
    assert.equal(report.workers[0]?.responses.length, 1);
    assert.equal(report.workers[0]?.messages.length, 2);
});

test("{§digest-requiem}: a response-less failed call remains durable with unknown cost", async () => {
    const dbPath = join(TMP_DIR, `requiem-failure-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "requiem-failure");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await db.test_insert_turn.get({
            loop_id: loopId,
            sequence: 1,
            status: 500,
            packet: MODEL_PACKET("failed-witness"),
        });
    } finally {
        await db.close();
    }

    const provider = new WitnessMock({ contextWindow: 100_000, responses: [] });
    const digestDir = join(TMP_DIR, `requiem-failure-out-${crypto.randomUUID()}`);
    await assert.rejects(Digest.requiem({ dbPath, digestDir, provider }), /no more queued responses/);

    const report = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
        workers: Array<{
            calls: Array<{
                state: string;
                failure: unknown;
                requests: Array<{ state: string; accounting: ProviderRequestAccounting | null }>;
            }>;
            accounting: ProviderAccounting;
        }>;
    };
    assert.equal(report.workers[0]?.calls[0]?.state, "error");
    assert.notEqual(report.workers[0]?.calls[0]?.failure, null);
    assert.equal(report.workers[0]?.calls[0]?.requests[0]?.state, "settled");
    assert.equal(report.workers[0]?.calls[0]?.requests[0]?.accounting?.cost.kind, "unknown");
    assert.equal(report.workers[0]?.accounting.costUsd, null);
});
