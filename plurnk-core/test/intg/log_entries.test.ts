import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";
import LogEntry from "../../src/server/logEntry.ts";

type SqlValue = string | number | bigint | null;

const minimalLog = async (db: Db, ctx: { workerId: number; loopId: number; turnId: number }, overrides: Record<string, SqlValue> = {}): Promise<number> => {
    const params: Record<string, SqlValue> = {
        worker_id: ctx.workerId, loop_id: ctx.loopId, turn_id: ctx.turnId,
        sequence: 1, origin: "model", op: "EDIT", suffix: "",
        signal: JSON.stringify(["philosophy"]),
        scheme: "worker", pathname: "/meaning", port: null, params: null,
        lineMarker: null,
        tx: "<<EDIT[philosophy](worker:///meaning):42:EDIT", mimetype_tx: "text/x-plurnk",
        rx: "", mimetype_rx: "text/plain", status_rx: 201,
        tokens: 32,
        ...overrides,
    };
    const row = await db.test_log_entries_insert_full.get<{ id: number }>(params);
    if (row === undefined) throw new Error("log_entries insert returned no row");
    return row.id;
};

test("fetchLogEntry surfaces loop_seq/turn_seq (ordinals), not just DB ids", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 3);   // loop ordinal 3
        const turnId = await insertTurn(db, loopId, 2);  // turn ordinal 2
        const id = await minimalLog(db, { workerId, loopId, turnId }, { tx: JSON.stringify("in"), rx: JSON.stringify("out") });
        const wire = await LogEntry.fetchLogEntry(db, id);
        assert.equal(wire.loop_seq, 3, "loop ordinal on the wire");
        assert.equal(wire.turn_seq, 2, "turn ordinal on the wire");
        assert.equal(wire.loop_id, loopId, "DB loop id still present");
        assert.equal(wire.turn_id, turnId, "DB turn id still present");
    } finally { await db.close(); }
});

test("log_entries: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_log_entries_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("log_entries: minimal insert — defaults populate", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-defaults");
        const ins = await db.test_log_entries_insert_minimal.get<{ id: number }>({ worker_id: ctx.workerId, loop_id: ctx.loopId, turn_id: ctx.turnId });
        const row = await db.test_log_entries_get_by_id.get<{ version: number; at: string; suffix: string; tokens: number; signal: string | null; lineMarker: string | null }>({ id: ins?.id });
        assert.equal(row?.version, 0);
        assert.match(row?.at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.suffix, "");
        assert.equal(row?.tokens, 0);
        assert.equal(row?.signal, null);
        assert.equal(row?.lineMarker, null);
    } finally { await db.close(); }
});

test("log_entries: sequence UNIQUE within turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionuniq");
        await minimalLog(db, ctx, { sequence: 1 });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 1 }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: sequence >= 1 enforced", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 0 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: origin enum", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-origin");
        for (const [i, origin] of ["model", "client", "plurnk", "plugin"].entries()) {
            await minimalLog(db, ctx, { sequence: i + 1, origin });
        }
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 4, origin: "admin" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

// (No "op enum" test: log_entries.op no longer CHECK-enumerates the grammar op set — that was a
// hand-copy of grammar's contract that went stale on every new verb. Op validity lives at the parse
// (grammar) + type (PlurnkOp) layer; the column stores what the typed engine writes.)

test("log_entries: status_rx range 100..599", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-statusrx");
        for (const [i, s] of [100, 200, 499, 599].entries()) {
            await minimalLog(db, ctx, { sequence: i + 1, status_rx: s });
        }
        for (const bad of [99, 600, 0, -1]) {
            await assert.rejects(
                () => minimalLog(db, ctx, { sequence: 999, status_rx: bad }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("log_entries: mimetype CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-mimetypes");
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_tx: "" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_rx: "" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: scheme nullable; non-empty CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tscheme");
        await minimalLog(db, ctx, { sequence: 1, scheme: null });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 2, scheme: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: port range", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tport");
        await minimalLog(db, ctx, { sequence: 1, port: 443 });
        await minimalLog(db, ctx, { sequence: 2, port: 0 });
        await minimalLog(db, ctx, { sequence: 3, port: 65535 });
        await minimalLog(db, ctx, { sequence: 4, port: null });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, port: 65536 }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 6, port: -1 }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: params + signal + lineMarker JSON validation", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-json");
        await minimalLog(db, ctx, { sequence: 1, params: null, signal: null, lineMarker: null });
        await minimalLog(db, ctx, { sequence: 2, params: '{"q":["x"]}', signal: '["a","b"]', lineMarker: '{"first":1,"last":10}' });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 3, params: "{not json" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 4, signal: "{bad" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, lineMarker: "broken" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: signal polymorphism", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-sigpoly");
        await minimalLog(db, ctx, { sequence: 1, op: "EDIT",  signal: JSON.stringify(["philosophy"]) });
        await minimalLog(db, ctx, { sequence: 2, op: "SEND",  signal: JSON.stringify(200) });
        await minimalLog(db, ctx, { sequence: 3, op: "EXEC",  signal: JSON.stringify("node") });
        await minimalLog(db, ctx, { sequence: 4, op: "READ",  signal: null });
        const rows = await db.test_log_entries_signals_by_turn.all<{ op: string; signal: string | null }>({ turn_id: ctx.turnId });
        assert.deepEqual(rows.map((r) => r.signal), ['["philosophy"]', '200', '"node"', null]);
    } finally { await db.close(); }
});

test("log_entries: worker_id NOT NULL", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-norun");
        await assert.rejects(
            () => db.test_log_entries_insert_no_worker_id.run({ loop_id: ctx.loopId, turn_id: ctx.turnId }),
            /NOT NULL constraint failed: log_entries\.worker_id/,
        );
    } finally { await db.close(); }
});

test("log_entries: each FK rejection path", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fkpaths");
        await assert.rejects(() => minimalLog(db, ctx, { worker_id: 99999 }),  /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { loop_id: 99999 }), /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { turn_id: 99999 }), /FOREIGN KEY constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: ON DELETE CASCADE via turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-turncasc");
        await minimalLog(db, ctx, { sequence: 1 });
        await minimalLog(db, ctx, { sequence: 2 });
        await db.test_log_entries_delete_turns.run({ id: ctx.turnId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("log_entries: full CASCADE chain", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fullchain");
        await minimalLog(db, ctx);
        await db.test_workspaces_delete.run({ id: ctx.workspaceId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("log_entries: immutability trigger — UPDATE of core fields rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-immut");
        const id = await minimalLog(db, ctx);
        // Lifecycle columns (state/outcome/status_rx/rx) are updateable for
        // the proposal lifecycle, but the original action's identity stays
        // pinned forever.
        await assert.rejects(
            () => db.test_log_entries_update_tx.run({ tx: "tampered", id }),
            /log_entries core fields are immutable/,
        );
        const tx = (await db.test_log_entries_get_tx_by_id.get<{ tx: string }>({ id }))?.tx;
        assert.match(tx ?? "", /^<<EDIT/);
    } finally { await db.close(); }
});

test("log_entries: DELETE is allowed", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-delok");
        const id = await minimalLog(db, ctx);
        await db.test_log_entries_delete.run({ id });
        const count = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("log_entries: tokens negative rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-toksneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { tokens: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: indexes exist", async () => {
    const db = await openMigrated();
    try {
        const rows = await db.test_log_entries_indexes.all<{ name: string; sql: string }>();
        const names = rows.map((r) => r.name).sort();
        assert.deepEqual(names, [
            "log_entries_at",
            "log_entries_loop_id",
            "log_entries_turn_id_sequence",
            "log_entries_worker_id",
        ]);
        const uniq = rows.find((r) => r.name === "log_entries_turn_id_sequence");
        assert.match(uniq?.sql ?? "", /UNIQUE/);
    } finally { await db.close(); }
});

test("log_entries: query log:///<L>/<T>/<A> address pattern", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-address");
        await minimalLog(db, ctx, { sequence: 1 });
        await minimalLog(db, ctx, { sequence: 2, op: "SEND" });
        const row = await db.test_log_entries_address_join.get<{ op: string; loop_seq: number; turn_seq: number; sequence: number }>({ loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(row?.op, "SEND");
        assert.equal(row?.loop_seq, 1);
        assert.equal(row?.turn_seq, 1);
        assert.equal(row?.sequence, 2);
    } finally { await db.close(); }
});
