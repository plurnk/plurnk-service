import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

type SqlValue = string | number | bigint | null;

const minimalLog = (db: DatabaseSync, ctx: { runId: number; loopId: number; turnId: number }, overrides: Record<string, SqlValue> = {}): number => {
    const base: Record<string, SqlValue> = {
        run_id: ctx.runId, loop_id: ctx.loopId, turn_id: ctx.turnId,
        action_index: 0, origin: "model", op: "EDIT", suffix: "",
        signal: JSON.stringify(["philosophy"]),
        target_scheme: "known", target_pathname: "/meaning",
        tx: "<<EDIT[philosophy](known://meaning):42:EDIT", mimetype_tx: "text/x-plurnk",
        rx: "", mimetype_rx: "text/plain", status_rx: 201,
        tokens: 32,
        ...overrides,
    };
    const cols = Object.keys(base);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO log_entries (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`;
    return (db.prepare(sql).get(...cols.map((c) => base[c]!)) as { id: number }).id;
};

test("log_entries: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'log_entries'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
    } finally { db.close(); }
});

test("log_entries: minimal insert — defaults populate version, at, suffix='', tokens=0", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-defaults");
        const id = (db.prepare("INSERT INTO log_entries (run_id, loop_id, turn_id, action_index, origin, op, target_pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx) VALUES (?, ?, ?, 0, 'model', 'READ', '/x', '', 'text/x-plurnk', '', 'text/plain', 200) RETURNING id")
            .get(ctx.runId, ctx.loopId, ctx.turnId) as { id: number }).id;
        const row = db.prepare("SELECT * FROM log_entries WHERE id = ?").get(id) as {
            version: number; at: string; suffix: string; tokens: number; signal: string | null; lineMarker: string | null;
        };
        assert.equal(row.version, 0);
        assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row.suffix, "");
        assert.equal(row.tokens, 0);
        assert.equal(row.signal, null);
        assert.equal(row.lineMarker, null);
    } finally { db.close(); }
});

test("log_entries: action_index UNIQUE within turn — duplicate rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionuniq");
        minimalLog(db, ctx, { action_index: 0 });
        assert.throws(
            () => minimalLog(db, ctx, { action_index: 0 }),
            /UNIQUE constraint failed/,
        );
    } finally { db.close(); }
});

test("log_entries: action_index >= 0 enforced — negative rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionneg");
        assert.throws(
            () => minimalLog(db, ctx, { action_index: -1 }),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("log_entries: origin enum — all four accepted, others rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-origin");
        for (const [i, origin] of ["model", "client", "system", "plugin"].entries()) {
            minimalLog(db, ctx, { action_index: i, origin });
        }
        assert.throws(
            () => minimalLog(db, ctx, { action_index: 4, origin: "admin" }),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("log_entries: op enum — all nine accepted, others rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-op");
        const ops = ["FIND", "READ", "EDIT", "COPY", "MOVE", "SHOW", "HIDE", "SEND", "EXEC"];
        for (const [i, op] of ops.entries()) {
            minimalLog(db, ctx, { action_index: i, op });
        }
        assert.throws(
            () => minimalLog(db, ctx, { action_index: ops.length, op: "DROP" }),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("log_entries: status_rx range 100..599 — boundaries accepted, out-of-range rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-statusrx");
        for (const [i, s] of [100, 200, 499, 599].entries()) {
            minimalLog(db, ctx, { action_index: i, status_rx: s });
        }
        for (const bad of [99, 600, 0, -1]) {
            assert.throws(
                () => minimalLog(db, ctx, { action_index: 999, status_rx: bad }),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("log_entries: mimetype_tx + mimetype_rx NOT NULL + length CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-mimetypes");
        assert.throws(() => minimalLog(db, ctx, { mimetype_tx: "" }), /CHECK constraint failed/);
        assert.throws(() => minimalLog(db, ctx, { mimetype_rx: "" }), /CHECK constraint failed/);
    } finally { db.close(); }
});

test("log_entries: target_scheme nullable; non-empty CHECK when not null", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tscheme");
        minimalLog(db, ctx, { action_index: 0, target_scheme: null });
        assert.throws(
            () => minimalLog(db, ctx, { action_index: 1, target_scheme: "" }),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("log_entries: target_port range — 0..65535 accepted, out-of-range rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tport");
        minimalLog(db, ctx, { action_index: 0, target_port: 443 });
        minimalLog(db, ctx, { action_index: 1, target_port: 0 });
        minimalLog(db, ctx, { action_index: 2, target_port: 65535 });
        minimalLog(db, ctx, { action_index: 3, target_port: null });
        assert.throws(() => minimalLog(db, ctx, { action_index: 4, target_port: 65536 }), /CHECK constraint failed/);
        assert.throws(() => minimalLog(db, ctx, { action_index: 5, target_port: -1 }), /CHECK constraint failed/);
    } finally { db.close(); }
});

test("log_entries: target_params + signal + lineMarker — null accepted; JSON-valid accepted; invalid rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-json");
        minimalLog(db, ctx, { action_index: 0, target_params: null, signal: null, lineMarker: null });
        minimalLog(db, ctx, { action_index: 1, target_params: '{"q":["x"]}', signal: '["a","b"]', lineMarker: '{"first":1,"last":10}' });
        assert.throws(() => minimalLog(db, ctx, { action_index: 2, target_params: "{not json" }), /CHECK constraint failed/);
        assert.throws(() => minimalLog(db, ctx, { action_index: 3, signal: "{bad" }), /CHECK constraint failed/);
        assert.throws(() => minimalLog(db, ctx, { action_index: 4, lineMarker: "broken" }), /CHECK constraint failed/);
    } finally { db.close(); }
});

test("log_entries: signal polymorphism — array, number, string, null all storable as JSON", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-sigpoly");
        minimalLog(db, ctx, { action_index: 0, op: "EDIT",  signal: JSON.stringify(["philosophy"]) });
        minimalLog(db, ctx, { action_index: 1, op: "SEND",  signal: JSON.stringify(200) });
        minimalLog(db, ctx, { action_index: 2, op: "EXEC",  signal: JSON.stringify("node") });
        minimalLog(db, ctx, { action_index: 3, op: "READ",  signal: null });
        const rows = db.prepare("SELECT op, signal FROM log_entries WHERE turn_id = ? ORDER BY action_index").all(ctx.turnId) as { op: string; signal: string | null }[];
        assert.deepEqual(rows.map((r) => r.signal), ['["philosophy"]', '200', '"node"', null]);
    } finally { db.close(); }
});

test("log_entries: run_id NOT NULL — insert without run_id rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-norun");
        assert.throws(
            () => db.prepare("INSERT INTO log_entries (loop_id, turn_id, action_index, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx) VALUES (?, ?, 0, 'model', 'READ', '', 'text/x-plurnk', '', 'text/plain', 200)").run(ctx.loopId, ctx.turnId),
            /NOT NULL constraint failed: log_entries\.run_id/,
        );
    } finally { db.close(); }
});

test("log_entries: each FK rejection path", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fkpaths");
        assert.throws(() => minimalLog(db, ctx, { run_id: 99999 }),  /FOREIGN KEY constraint failed/);
        assert.throws(() => minimalLog(db, ctx, { loop_id: 99999 }), /FOREIGN KEY constraint failed/);
        assert.throws(() => minimalLog(db, ctx, { turn_id: 99999 }), /FOREIGN KEY constraint failed/);
    } finally { db.close(); }
});

test("log_entries: ON DELETE CASCADE via turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-turncasc");
        minimalLog(db, ctx, { action_index: 0 });
        minimalLog(db, ctx, { action_index: 1 });
        db.prepare("DELETE FROM turns WHERE id = ?").run(ctx.turnId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM log_entries").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("log_entries: full CASCADE chain session→runs→loops→turns→log_entries (5 hops)", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fullchain");
        minimalLog(db, ctx);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(ctx.sessionId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM log_entries").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("log_entries: immutability trigger — UPDATE rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-immut");
        const id = minimalLog(db, ctx);
        assert.throws(
            () => db.prepare("UPDATE log_entries SET tx = 'tampered' WHERE id = ?").run(id),
            /log_entries are append-only/,
        );
        const tx = (db.prepare("SELECT tx FROM log_entries WHERE id = ?").get(id) as { tx: string }).tx;
        assert.match(tx, /^<<EDIT/, "tx field must remain unchanged");
    } finally { db.close(); }
});

test("log_entries: DELETE is allowed (FK cascade depends on it)", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-delok");
        const id = minimalLog(db, ctx);
        db.prepare("DELETE FROM log_entries WHERE id = ?").run(id);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM log_entries").get() as { n: number }).n;
        assert.equal(count, 0);
    } finally { db.close(); }
});

test("log_entries: tokens negative rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-toksneg");
        assert.throws(
            () => minimalLog(db, ctx, { tokens: -1 }),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("log_entries: indexes exist — (turn_id, action_index) UNIQUE plus run_id, loop_id, at", async () => {
    const db = await openMigrated();
    try {
        const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'log_entries_%'").all() as { name: string; sql: string }[];
        const names = rows.map((r) => r.name).sort();
        assert.deepEqual(names, [
            "log_entries_at",
            "log_entries_loop_id",
            "log_entries_run_id",
            "log_entries_turn_id_action_index",
        ]);
        const uniq = rows.find((r) => r.name === "log_entries_turn_id_action_index");
        assert.match(uniq?.sql ?? "", /UNIQUE/);
    } finally { db.close(); }
});

test("log_entries: query log://<L>/<T>/<A> address pattern — JOIN through sequences", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-address");
        minimalLog(db, ctx, { action_index: 0 });
        minimalLog(db, ctx, { action_index: 1, op: "SEND" });
        const row = db.prepare(`
            SELECT le.op, l.sequence AS loop_seq, t.sequence AS turn_seq, le.action_index
            FROM log_entries le
            JOIN loops l ON l.id = le.loop_id
            JOIN turns t ON t.id = le.turn_id
            WHERE l.sequence = 1 AND t.sequence = 1 AND le.action_index = 1
        `).get() as { op: string; loop_seq: number; turn_seq: number; action_index: number };
        assert.equal(row.op, "SEND");
        assert.equal(row.loop_seq, 1);
        assert.equal(row.turn_seq, 1);
        assert.equal(row.action_index, 1);
    } finally { db.close(); }
});
