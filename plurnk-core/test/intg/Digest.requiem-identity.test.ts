// {§digest-requiem} — a synthetic interview carries a complete self-root identity.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mock } from "@plurnk/plurnk-providers";
import type { ChatMessage, ProviderAccountingScope, ProviderCallAccounting, ProviderUsage } from "@plurnk/plurnk-providers";
import Digest from "../../src/digest/Digest.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

// A witness that records the identity of every generate() call the requiem makes.
class WitnessMock extends Mock {
    calls: Array<{ workerId?: string; primaryWorkerId?: string; messages: readonly ChatMessage[]; accounting?: ProviderCallAccounting }> = [];
    onGenerate?: (accounting: ProviderCallAccounting | undefined) => void;
    override async generate(args: Parameters<Mock["generate"]>[0] & { workerId?: string; primaryWorkerId?: string }): ReturnType<Mock["generate"]> {
        this.onGenerate?.(args.accounting);
        this.calls.push({ workerId: args.workerId, primaryWorkerId: args.primaryWorkerId, messages: args.messages, accounting: args.accounting });
        return super.generate(args);
    }

    override calculateCost(usage: ProviderUsage): number {
        return usage.total / 1_000;
    }

    override calculateCharge(usage: ProviderUsage) {
        return { kind: "estimated" as const, usd: String(this.calculateCost(usage)), source: "requiem witness" };
    }
}

class ScopedWitnessMock extends WitnessMock {
    readonly accountingScopes: ProviderAccountingScope[] = [];

    async reconcileAccounting(scope: ProviderAccountingScope) {
        this.accountingScopes.push(scope);
        return {
            status: "settled" as const,
            charge: {
                kind: "authoritative" as const,
                amount: { amount: "0.0042", currency: "USD" },
                usdEquivalent: "0.0042",
                source: "requiem accounting fixture",
            },
            evaluatedAt: "2026-08-08T12:00:00.000Z",
        };
    }
}

const MODEL_PACKET = (worker: string) => JSON.stringify({
    tokens: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: `system for ${worker}`, tokens: 1 },
        { name: "log", slot: "user", header: "Log", content: `log for ${worker}`, tokens: 1 },
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
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        turn_id: args.turnId,
        sequence: args.sequence,
        attributions: "[]",
        model: "mock",
    });
    if (attempt === undefined) throw new Error("requiem fixture attempt did not open");
    await db.engine_observe_turn_attempt_response.run({
        id: attempt.id,
        response: JSON.stringify(args.response),
        usage_prompt: 2,
        usage_completion: 2,
        usage_reasoning: 2,
        usage_cached: 0,
        usage_cost: JSON.stringify({ kind: "free", source: "requiem fixture" }),
        finish_reason: "stop",
        model: "mock",
    });
    await db.engine_classify_turn_attempt_response.run({
        id: attempt.id,
        accepted: args.accepted ? 1 : 0,
        parse_errors: JSON.stringify(args.parseErrors),
        failure: null,
        usage_cost: JSON.stringify({ kind: "free", source: "requiem fixture" }),
        usage_cost_usd: 0,
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
                    usage: { prompt: 2, completion: 2, reasoning: 2, cached: 0, total: 6 },
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
                    usage: { prompt: 2, completion: 2, reasoning: 2, cached: 0, total: 6 },
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

    const provider = new ScopedWitnessMock({
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
    provider.onGenerate = (accounting) => {
        const journal = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
            workers: Array<{ calls: Array<{ callId: string; state: string }> }>;
        };
        assert.equal(journal.workers[0]?.calls[0]?.callId, accounting?.callId);
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
    assert.notEqual(call.accounting, undefined, "the requiem call carries a correlated accounting identity");
    assert.equal(provider.accountingScopes.length, 1);
    assert.equal(provider.accountingScopes[0]!.id, call.accounting!.scopeId);
    assert.equal(provider.accountingScopes[0]!.attempts, 1);
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
                usage: { prompt: 2, completion: 2, reasoning: 2, cached: 0, total: 6 },
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
                usage: { prompt: 2, completion: 2, reasoning: 2, cached: 0, total: 6 },
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
    assert.match(requiem, /prompt 10, completion 3, reasoning 0, cached 2, cost USD 0\.0042/);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        workers: Array<{ costs: import("@plurnk/plurnk-contracts").ProviderCost[]; costUsd: number | null; projectedCostUsd: number | null; accounting: { scopeId: string; status: string }; messages: ChatMessage[]; responses: unknown[] }>;
    };
    assert.equal(report.workers[0]?.costUsd, 0.0042);
    assert.equal(report.workers[0]?.projectedCostUsd, 0.013);
    assert.deepEqual(report.workers[0]?.accounting, {
        scopeId: call.accounting!.scopeId,
        startedAt: provider.accountingScopes[0]!.startedAt,
        endedAt: provider.accountingScopes[0]!.endedAt,
        model: provider.model,
        status: "settled",
        charge: {
            kind: "authoritative",
            amount: { amount: "0.0042", currency: "USD" },
            usdEquivalent: "0.0042",
            source: "requiem accounting fixture",
        },
        evaluatedAt: "2026-08-08T12:00:00.000Z",
    });
    assert.equal(report.workers[0]?.responses.length, 1);
    assert.equal(report.workers[0]?.messages.length, 2);
});

test("{§digest-requiem}: a failed call remains durable and still reconciles its scoped charge", async () => {
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

    const provider = new ScopedWitnessMock({ contextWindow: 100_000, responses: [] });
    const digestDir = join(TMP_DIR, `requiem-failure-out-${crypto.randomUUID()}`);
    await assert.rejects(Digest.requiem({ dbPath, digestDir, provider }), /no more queued responses/);

    const report = JSON.parse(readFileSync(join(digestDir, "requiem.json"), "utf8")) as {
        workers: Array<{
            calls: Array<{ state: string; failure: unknown }>;
            costUsd: number | null;
            accounting: { status: string };
        }>;
    };
    assert.equal(report.workers[0]?.calls[0]?.state, "error");
    assert.notEqual(report.workers[0]?.calls[0]?.failure, null);
    assert.equal(report.workers[0]?.costUsd, 0.0042);
    assert.equal(report.workers[0]?.accounting.status, "settled");
    assert.equal(provider.accountingScopes[0]?.attempts, 1);
});
