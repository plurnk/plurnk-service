// {§provider-request-accounting}: normalized physical requests are the only
// accounting authority; every broader total is an exact derived projection.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import type { Db } from "../../src/core/Db.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const openRequest = async (
    db: Db,
    loopId: number,
    turnSequence: number,
    accounting: ProviderRequestAccounting,
): Promise<void> => {
    const turn = await db.engine_open_turn.get<{ id: number }>({
        loop_id: loopId,
        sequence: turnSequence,
    });
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        turn_id: turn!.id,
        sequence: 1,
        attributions: "[]",
        model: accounting.model,
    });
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        turn_attempt_id: attempt!.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    const settled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request!.id, accounting),
    );
    assert.equal(settled.changes, 1);
};

const fixture = async (): Promise<{
    db: Db;
    loopId: number;
}> => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `money-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "account");
    return { db, loopId };
};

test("loop accounting adds decimal strings exactly without denormalized rollups", async () => {
    const { db, loopId } = await fixture();
    try {
        await openRequest(db, loopId, 1, {
            provider: "provider:a",
            model: "a",
            outcome: "response",
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            cost: {
                kind: "estimated",
                amount: { amount: "0.1", currency: "USD" },
                source: "fixture rate",
            },
        });
        await openRequest(db, loopId, 2, {
            provider: "provider:b",
            model: "b",
            outcome: "response",
            usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
            cost: {
                kind: "charged",
                amount: { amount: "0.2", currency: "USD" },
                source: "fixture charge",
            },
        });

        const accounting = (await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, "0.3");
        assert.deepEqual(accounting.usage, {
            inputTokens: 30,
            outputTokens: 5,
            totalTokens: 35,
        });
        assert.equal(accounting.requests.length, 2);
    } finally {
        await db.close();
    }
});

test("one unknown request makes the derived USD total unknown without erasing known evidence", async () => {
    const { db, loopId } = await fixture();
    try {
        await openRequest(db, loopId, 1, {
            provider: "provider:a",
            model: "a",
            outcome: "response",
            cost: {
                kind: "charged",
                amount: { amount: "4.25", currency: "USD" },
                source: "direct charge",
            },
        });
        await openRequest(db, loopId, 2, {
            provider: "provider:b",
            model: "b",
            outcome: "error",
            cost: { kind: "unknown", reason: "provider supplied no monetary evidence" },
        });

        const accounting = (await new Engine({ db, schemes: new SchemeRegistry() }).loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, null);
        assert.equal(accounting.requests[0]?.cost.kind, "charged");
        assert.equal(accounting.requests[1]?.cost.kind, "unknown");
    } finally {
        await db.close();
    }
});

test("the baseline has no floating-point or denormalized accounting columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-money-schema-"));
    const path = join(dir, "plurnk.db");
    const db = await openMigrated(path);
    await db.close();
    try {
        const sqlite = new DatabaseSync(path, { readOnly: true });
        const tableInfo = (table: string): Array<{ name: string; type: string }> =>
            sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
        for (const table of ["workspaces", "workers", "turns", "turn_attempts"]) {
            assert.equal(
                tableInfo(table).some(({ name }) => name.startsWith("usage_") || name === "cost_usd"),
                table === "turns",
                `${table} has no accounting rollup (turns retains only usage_prompt_budget)`,
            );
        }
        assert.deepEqual(
            tableInfo("turns").filter(({ name }) => name.startsWith("usage_")).map(({ name }) => name),
            ["usage_prompt_budget"],
        );
        assert.equal(
            tableInfo("provider_requests").some(({ type }) => type === "REAL"),
            false,
            "money is stored as canonical TEXT, never REAL",
        );
        sqlite.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
