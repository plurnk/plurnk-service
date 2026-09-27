// {§validation-topology} — one settled-result corpus, three enforcers: the gate a scheme's result
// crosses (`Results.assertChannelProducerResult`), chapter 5's `entry_channel_producer_result_contract`
// and chapter 7's `subscriptions_result_contract_update` (`011_settled`). They agree on every row.
import test from "node:test";
import assert from "node:assert/strict";
import { InvalidOperationResultError, Results, type ChannelProducerResult, type ProblemDetails } from "@plurnk/plurnk-schemes";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import type { Db } from "../../src/core/Db.ts";
import { insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const problem = (status: number, overrides: Partial<Record<keyof ProblemDetails, string | undefined>> = {}): Record<string, unknown> => {
    const complete: Record<string, unknown> = {
        type: "https://problems.plurnk.xyz/test/settled",
        title: "Settled",
        status,
        detail: "The witness problem.",
        ...overrides,
    };
    return Object.fromEntries(Object.entries(complete).filter(([, value]) => value !== undefined));
};

const CORPUS: ReadonlyArray<readonly [label: string, result: Record<string, unknown>, settled: boolean]> = [
    ["200 without a Problem", { status: 200 }, true],
    ["302 without a Problem", { status: 302 }, true],
    ["404 with a complete Problem", { status: 404, problem: problem(404) }, true],
    ["500 with a complete Problem", { status: 500, problem: problem(500) }, true],
    ["202 is a proposal, not a settlement", { status: 202 }, false],
    ["199 is below the settled range", { status: 199 }, false],
    ["600 is above the status range", { status: 600 }, false],
    ["404 without a Problem", { status: 404 }, false],
    ["200 with a Problem", { status: 200, problem: problem(200) }, false],
    ["404 whose Problem carries another status", { status: 404, problem: problem(500) }, false],
    ["404 with no type", { status: 404, problem: problem(404, { type: undefined }) }, false],
    ["404 with an empty type", { status: 404, problem: problem(404, { type: "" }) }, false],
    ["404 with no title", { status: 404, problem: problem(404, { title: undefined }) }, false],
    ["404 with an empty title", { status: 404, problem: problem(404, { title: "" }) }, false],
    ["404 with no detail", { status: 404, problem: problem(404, { detail: undefined }) }, false],
    ["404 with an empty detail", { status: 404, problem: problem(404, { detail: "" }) }, false],
];

const seed = async (db: Db): Promise<{ entryId: number; workerId: number }> => {
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
        workspace_id: workspaceId, scheme: "worker", authority: "", pathname: `/${crypto.randomUUID()}`,
    });
    if (entry === undefined) throw new Error("seed entry failed");
    await db.test_seed_channel.run({ entry_id: entry.id, name: "body", content: "", mimetype: "text/plain", state: "active" });
    return { entryId: entry.id, workerId };
};

const gate = (result: Record<string, unknown>): boolean => {
    try {
        Results.assertChannelProducerResult(structuredClone(result) as ChannelProducerResult);
        return true;
    } catch (error) {
        if (!(error instanceof InvalidOperationResultError)) throw error;
        return false;
    }
};

const chapterFive = async (db: Db, entryId: number, result: Record<string, unknown>): Promise<boolean> => {
    try {
        await db.test_seed_channel_hashed.run({
            entry_id: entryId, name: crypto.randomUUID(), content: "x", mimetype: "text/plain",
            weight: null, content_hash: null, state: "static", producer_result: JSON.stringify(result),
        });
        return true;
    } catch (error) {
        assert.match((error as Error).message, /entry_channel_producer_result_contract/);
        return false;
    }
};

const chapterSeven = async (db: Db, { entryId, workerId }: { entryId: number; workerId: number }, result: Record<string, unknown>): Promise<boolean> => {
    const subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId, scheme: "sse", handle: "/settled" });
    try {
        await db.test_topology_settle_subscription.run({ subscription_id: subscriptionId, status: result.status as number, result: JSON.stringify(result) });
    } catch (error) {
        assert.match((error as Error).message, /subscription terminal result violates the operation-result contract/);
        return false;
    }
    const closed = await db.test_topology_subscription_closed.get<{ close_status: number }>({ subscription_id: subscriptionId });
    assert.equal(closed?.close_status, result.status);
    return true;
};

test("{§validation-topology}: the gate, chapter 5 and chapter 7 settle the same results and refuse the same results", async () => {
    const db = await openMigrated();
    try {
        for (const [label, result, settled] of CORPUS) {
            const seeded = await seed(db);
            assert.equal(gate(result), settled, `${label}: Results.assertChannelProducerResult`);
            assert.equal(await chapterFive(db, seeded.entryId, result), settled, `${label}: entry_channel_producer_result_contract`);
            assert.equal(await chapterSeven(db, seeded, result), settled, `${label}: subscriptions_result_contract_update`);
        }
    } finally { await db.close(); }
});
