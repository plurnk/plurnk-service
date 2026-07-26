import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    sections: [],
    telemetryErrors: [],
    assistant: {
        content: "", ops: [], reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
        finishReason: null, model: "mock",
    },
    assistantRaw: null,
});

const seedLoop = async (db: Db): Promise<number> => {
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return insertLoop(db, workerId, 1);
};

const setup = async () => {
    const db = await openMigrated();
    const loopId = await seedLoop(db);
    return { db, loopId };
};

test("turns: table is STRICT", async () => {
    const { db } = await setup();
    try {
        const row = await db.test_turns_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("turns: insert with required fields — defaults populate", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        const row = await db.test_turns_get_full.get<{
            id: number; version: number; loop_id: number; sequence: number; timestamp: string;
            status: number; usage_prompt: number; usage_completion: number; usage_cached: number;
            usage_cost_usd: number; packet: string;
        }>({ loop_id: loopId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.sequence, 1);
        assert.match(row?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.status, 200);
        assert.equal(row?.usage_prompt, 0);
        assert.equal(row?.usage_completion, 0);
        assert.equal(row?.usage_cached, 0);
        assert.equal(row?.usage_cost_usd, 0);
        assert.equal(row?.packet, MIN_PACKET);
    } finally { await db.close(); }
});

test("turns: status range CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const [seq, status] of [[1, 100], [2, 200], [3, 499], [4, 599]] as const) {
            await db.test_turns_insert.run({ loop_id: loopId, sequence: seq, status, packet: MIN_PACKET });
        }
        for (const bad of [99, 600, 0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: 99, status: bad, packet: MIN_PACKET }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("turns: sequence < 1 rejected by CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const bad of [0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: bad, status: 200, packet: MIN_PACKET }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("turns: (loop_id, sequence) UNIQUE", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("turns: sequence resets per loop", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-turns-crossloop");
        const workerId = await insertWorker(db, workspaceId);
        const loopA = await insertLoop(db, workerId, 1);
        const loopB = await insertLoop(db, workerId, 2);
        await db.test_turns_insert.run({ loop_id: loopA, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopB, sequence: 1, status: 200, packet: MIN_PACKET });
        const count = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("turns: loop_id NOT NULL", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_loop_id.run({ sequence: 1, status: 200, packet: MIN_PACKET }),
            /NOT NULL constraint failed: turns\.loop_id/,
        );
    } finally { await db.close(); }
});

test("turns: status NOT NULL", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_status.run({ loop_id: loopId, sequence: 1, packet: MIN_PACKET }),
            /NOT NULL constraint failed: turns\.status/,
        );
    } finally { await db.close(); }
});

test("turns: packet NOT NULL", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_packet.run({ loop_id: loopId, sequence: 1, status: 200 }),
            /NOT NULL constraint failed: turns\.packet/,
        );
    } finally { await db.close(); }
});

test("turns: malformed JSON in packet rejected", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: "{not json" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("turns: loop_id FK", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_turns_insert.run({ loop_id: 99999, sequence: 1, status: 200, packet: MIN_PACKET }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("turns: ON DELETE CASCADE via loop", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 2, status: 200, packet: MIN_PACKET });
        await db.test_turns_loops_delete.run({ id: loopId });
        const remaining = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("turns: CASCADE chain workspace→runs→loops→turns", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-turns-fullchain");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_sessions_delete.run({ id: workspaceId });
        const remaining = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("turns: usage_* negative values rejected", async () => {
    const { db, loopId } = await setup();
    try {
        const inserts = [
            "test_turns_insert_with_usage_prompt",
            "test_turns_insert_with_usage_completion",
            "test_turns_insert_with_usage_cached",
            "test_turns_insert_with_usage_cost_usd",
        ] as const;
        for (const name of inserts) {
            await assert.rejects(
                () => db[name].run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET, val: -1 }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("turns: usage_* large positive integers stored and read back", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert_all_usage.run({
            loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET,
            usage_prompt: 50000, usage_completion: 12345, usage_cached: 200, usage_cost_usd: 9876543210,
        });
        const row = await db.test_turns_get_usage.get<{
            usage_prompt: number; usage_completion: number; usage_cached: number; usage_cost_usd: number;
        }>({ loop_id: loopId });
        assert.equal(row?.usage_prompt, 50000);
        assert.equal(row?.usage_completion, 12345);
        assert.equal(row?.usage_cached, 200);
        assert.equal(row?.usage_cost_usd, 9876543210);
    } finally { await db.close(); }
});

test("turns: aggregation — SUM(usage_cost_usd)", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert_with_usage_cost_usd.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET, val: 100 });
        await db.test_turns_insert_with_usage_cost_usd.run({ loop_id: loopId, sequence: 2, status: 200, packet: MIN_PACKET, val: 250 });
        await db.test_turns_insert_with_usage_cost_usd.run({ loop_id: loopId, sequence: 3, status: 200, packet: MIN_PACKET, val: 75 });
        const row = await db.test_turns_sum_cost.get<{ total: number }>({ loop_id: loopId });
        assert.equal(row?.total, 425);
    } finally { await db.close(); }
});

test("turns: negative version rejected", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_with_version.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET, version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("turns: unique index turns_loop_id_sequence exists", async () => {
    const { db } = await setup();
    try {
        const row = await db.test_turns_index_meta.get<{ name: string; sql: string }>({ name: "turns_loop_id_sequence" });
        assert.equal(row?.name, "turns_loop_id_sequence");
        assert.match(row?.sql ?? "", /UNIQUE/);
    } finally { await db.close(); }
});

test("turns: index turns_timestamp exists", async () => {
    const { db } = await setup();
    try {
        const row = await db.test_turns_index_meta.get<{ name: string }>({ name: "turns_timestamp" });
        assert.equal(row?.name, "turns_timestamp");
    } finally { await db.close(); }
});

test("turns: id auto-assigns on insert", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 2, status: 200, packet: MIN_PACKET });
        const rows = await db.test_turns_list_ids.all<{ id: number }>({ loop_id: loopId });
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});
