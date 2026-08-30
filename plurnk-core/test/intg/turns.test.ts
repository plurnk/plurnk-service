import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import Turn from "../../src/core/Turn.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MIN_PACKET = JSON.stringify({
    weight: 0,
    sections: [],
    attributions: [],
    assistant: { content: "", ops: [], reasoning: null },
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
            producer: string; kind: string; status: number; completed_at: string | null;
            usage_curation_budget: number | null; packet: string;
        }>({ loop_id: loopId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.sequence, 1);
        assert.equal(row?.producer, "model");
        assert.equal(row?.kind, "inference");
        assert.match(row?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.match(row?.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.status, 200);
        assert.equal(row?.usage_curation_budget, null);
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

test("turns: NULL packet means no model request was assembled", async () => {
    const { db, loopId } = await setup();
    try {
        await db.test_turns_insert_missing_packet.run({ loop_id: loopId, sequence: 1, status: 200 });
        const row = await db.test_turns_get_full.get<{ packet: string | null }>({ loop_id: loopId });
        assert.equal(row?.packet, null);
    } finally { await db.close(); }
});

test("turns: packet CHECK enforces the request/admitted-response root algebra", async () => {
    const { db, loopId } = await setup();
    try {
        const invalid = [
            "{}",
            "[]",
            "null",
            JSON.stringify({ tokens: 0 }),
            JSON.stringify({ tokens: 0, sections: [], assistant: { content: "", ops: [], reasoning: null } }),
            JSON.stringify({ tokens: 0, sections: [], assistantRaw: null }),
        ];
        for (const [index, packet] of invalid.entries()) {
            await assert.rejects(
                () => db.test_turns_insert.run({ loop_id: loopId, sequence: index + 1, status: 200, packet }),
                /CHECK constraint failed/,
                `invalid packet ${packet}`,
            );
        }
    } finally { await db.close(); }
});

test("Turn: every non-model producer uses the same operation-turn lifecycle", async () => {
    const { db, loopId } = await setup();
    try {
        for (const [index, producer] of (["client", "plugin", "_plurnk"] as const).entries()) {
            const turn = await Turn.open(db, { loopId, producer, kind: "operation" });
            const open = await db.test_get_turn.get<{
                producer: string; kind: string; status: number; completed_at: string | null; packet: string | null;
            }>({ id: turn.id });
            assert.deepEqual(open, {
                id: turn.id,
                loop_id: loopId,
                sequence: index + 1,
                producer,
                kind: "operation",
                status: 102,
                completed_at: null,
                finish_reason: null,
                model: null,
                packet: null,
            });
            await Turn.complete(db, turn.id, 204);
            const completed = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: turn.id });
            assert.equal(completed?.status, 204);
            assert.match(completed?.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
    } finally { await db.close(); }
});

test("turns: producer and kind are required and reject incoherent identities", async () => {
    const { db, loopId } = await setup();
    try {
        await assert.rejects(
            () => db.test_turns_insert_missing_producer.run({ loop_id: loopId, sequence: 1 }),
            /NOT NULL constraint failed: turns\.producer/,
        );
        await assert.rejects(
            () => db.test_turns_insert_missing_kind.run({ loop_id: loopId, sequence: 1 }),
            /NOT NULL constraint failed: turns\.kind/,
        );
        for (const [sequence, producer, kind, packet] of [
            [1, "nobody", "operation", null],
            [2, "client", "mystery", null],
            [3, "client", "inference", MIN_PACKET],
            [4, "model", "operation", null],
            [5, "client", "initialization", null],
            [6, "client", "operation", MIN_PACKET],
        ] as const) {
            await assert.rejects(
                () => db.test_turns_insert_identity.run({
                    loop_id: loopId, sequence, producer, kind, status: 200, packet,
                }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("Turn: overflow is the sole producer transition and model calls require inference", async () => {
    const { db, loopId } = await setup();
    try {
        const operation = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        await assert.rejects(
            () => db.engine_open_model_call.get({
                turn_id: operation.id,
                kind: "emission",
                attributions: "[]",
                model: "mock/model",
            }),
            /inference call requires a valid owning workspace and causal context/,
        );
        await assert.rejects(
            () => Turn.becomeOverflow(db, operation.id),
            /cannot become overflow/,
        );
        await assert.rejects(
            () => db.test_turns_update_identity.run({
                id: operation.id,
                producer: "plugin",
                kind: "operation",
            }),
            /turn producer and kind are immutable/,
        );
        await assert.rejects(
            () => Turn.recordInference(db, operation.id, {
                packet: MIN_PACKET,
                usageCurationBudget: null,
                finishReason: null,
                model: "mock/model",
                meta: "{}",
            }),
            /not an open model inference turn/,
        );

        const inference = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await Turn.becomeOverflow(db, inference.id);
        const overflow = await db.test_get_turn.get<{ producer: string; kind: string }>({ id: inference.id });
        assert.deepEqual(
            { producer: overflow?.producer, kind: overflow?.kind },
            { producer: "_plurnk", kind: "overflow" },
        );
    } finally { await db.close(); }
});

test("Turn: engine-side embedding work never blocks the overflow transition; a model emission does (run67)", async () => {
    const { db, loopId } = await setup();
    try {
        const embedded = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await db.engine_open_model_call.get({ turn_id: embedded.id, kind: "embedding_documents", attributions: "[]", model: "mock/embedding" });
        await Turn.becomeOverflow(db, embedded.id);
        const overflow = await db.test_get_turn.get<{ producer: string; kind: string }>({ id: embedded.id });
        assert.deepEqual({ producer: overflow?.producer, kind: overflow?.kind }, { producer: "_plurnk", kind: "overflow" }, "semantic attachment is engine work, not model history");

        const emitted = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await db.engine_open_model_call.get({ turn_id: emitted.id, kind: "emission", attributions: "[]", model: "mock/model" });
        await assert.rejects(() => Turn.becomeOverflow(db, emitted.id), /cannot become overflow/, "a model emission is history; the producer cannot change beneath it");
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

test("turns: CASCADE chain workspace→workers→loops→turns", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-turns-fullchain");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        await db.test_turns_insert.run({ loop_id: loopId, sequence: 1, status: 200, packet: MIN_PACKET });
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_turns_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("turns: curation budget is a positive optional gauge denominator", async () => {
    const { db, loopId } = await setup();
    try {
        for (const curationBudget of [0, -1]) {
            await assert.rejects(
                () => db.test_turns_insert_with_curation_budget.run({
                    loop_id: loopId,
                    sequence: 1,
                    status: 200,
                    packet: MIN_PACKET,
                    curation_budget: curationBudget,
                }),
                /CHECK constraint failed/,
            );
        }
        await db.test_turns_insert_with_curation_budget.run({
            loop_id: loopId,
            sequence: 1,
            status: 200,
            packet: MIN_PACKET,
            curation_budget: 200_000,
        });
        const row = await db.test_turns_get_curation_budget.get<{
            usage_curation_budget: number;
        }>({ loop_id: loopId });
        assert.equal(row?.usage_curation_budget, 200_000);
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
