import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertSession, insertRun, insertLoop } from "./_helpers.ts";

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: { tokens: 0, prompt: "", turn: "", system_requirements: "" },
    assistant: { tokens: 0, content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

const setup = async () => {
    const db = await openMigrated();
    const loopId = insertLoop(db, insertRun(db, insertSession(db, `ws-${crypto.randomUUID()}`)), 1);
    return { db, loopId };
};

test("turns: table is STRICT", async () => {
    const { db } = await setup();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
    } finally { db.close(); }
});

test("turns: insert with required fields — defaults populate version, timestamp, usage_*", async () => {
    const { db, loopId } = await setup();
    try {
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET);
        const row = db.prepare("SELECT * FROM turns WHERE loop_id = ?").get(loopId) as {
            id: number;
            version: number;
            loop_id: number;
            sequence: number;
            timestamp: string;
            status: number;
            usage_prompt: number;
            usage_completion: number;
            usage_cached: number;
            usage_cost_pico: number;
            packet: string;
        };
        assert.ok(row.id >= 1);
        assert.equal(row.version, 0);
        assert.equal(row.sequence, 1);
        assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row.status, 200);
        assert.equal(row.usage_prompt, 0);
        assert.equal(row.usage_completion, 0);
        assert.equal(row.usage_cached, 0);
        assert.equal(row.usage_cost_pico, 0);
        assert.equal(row.packet, MIN_PACKET);
    } finally { db.close(); }
});

test("turns: status range CHECK — accepts 100, 200, 499, 599; rejects 99, 600", async () => {
    const { db, loopId } = await setup();
    try {
        for (const [seq, status] of [[1, 100], [2, 200], [3, 499], [4, 599]] as const) {
            db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, seq, status, MIN_PACKET);
        }
        for (const bad of [99, 600, 0, -1]) {
            assert.throws(
                () => db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 99, bad, MIN_PACKET),
                /CHECK constraint failed/,
                `status ${bad} should be rejected`,
            );
        }
    } finally { db.close(); }
});

test("turns: sequence < 1 rejected by CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const bad of [0, -1]) {
            assert.throws(
                () => db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, bad, 200, MIN_PACKET),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("turns: (loop_id, sequence) UNIQUE — duplicate within loop rejected", async () => {
    const { db, loopId } = await setup();
    try {
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET);
        assert.throws(
            () => db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET),
            /UNIQUE constraint failed/,
        );
    } finally { db.close(); }
});

test("turns: sequence resets per loop — same sequence numbers across different loops is fine", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-turns-crossloop");
        const runId = insertRun(db, sessionId);
        const loopA = insertLoop(db, runId, 1);
        const loopB = insertLoop(db, runId, 2);
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopA, 1, 200, MIN_PACKET);
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopB, 1, 200, MIN_PACKET);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
        assert.equal(count, 2);
    } finally { db.close(); }
});

test("turns: loop_id NOT NULL — insert without loop_id rejected", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO turns (sequence, status, packet) VALUES (?, ?, ?)").run(1, 200, MIN_PACKET),
            /NOT NULL constraint failed: turns\.loop_id/,
        );
    } finally { db.close(); }
});

test("turns: status NOT NULL — insert without status rejected", async () => {
    const { db, loopId } = await setup();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO turns (loop_id, sequence, packet) VALUES (?, ?, ?)").run(loopId, 1, MIN_PACKET),
            /NOT NULL constraint failed: turns\.status/,
        );
    } finally { db.close(); }
});

test("turns: packet NOT NULL — insert without packet rejected", async () => {
    const { db, loopId } = await setup();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO turns (loop_id, sequence, status) VALUES (?, ?, ?)").run(loopId, 1, 200),
            /NOT NULL constraint failed: turns\.packet/,
        );
    } finally { db.close(); }
});

test("turns: malformed JSON in packet rejected by json_valid() CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 1, 200, "{not json"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("turns: loop_id FK — insert against non-existent loop rejected", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(99999, 1, 200, MIN_PACKET),
            /FOREIGN KEY constraint failed/,
        );
    } finally { db.close(); }
});

test("turns: ON DELETE CASCADE via loop — deleting loop removes its turns", async () => {
    const { db, loopId } = await setup();
    try {
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET);
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 2, 200, MIN_PACKET);
        db.prepare("DELETE FROM loops WHERE id = ?").run(loopId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("turns: CASCADE chain session→runs→loops→turns — deleting session sweeps turns 3 hops away", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-turns-fullchain");
        const runId = insertRun(db, sessionId);
        const loopId = insertLoop(db, runId, 1);
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("turns: usage_* negative values rejected by CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        for (const field of ["usage_prompt", "usage_completion", "usage_cached", "usage_cost_pico"]) {
            assert.throws(
                () => db.prepare(`INSERT INTO turns (loop_id, sequence, status, packet, ${field}) VALUES (?, ?, ?, ?, ?)`).run(loopId, 1, 200, MIN_PACKET, -1),
                /CHECK constraint failed/,
                `${field} negative should be rejected`,
            );
        }
    } finally { db.close(); }
});

test("turns: usage_* large positive integers stored and read back", async () => {
    const { db, loopId } = await setup();
    try {
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet, usage_prompt, usage_completion, usage_cached, usage_cost_pico) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(loopId, 1, 200, MIN_PACKET, 50000, 12345, 200, 9876543210);
        const row = db.prepare("SELECT usage_prompt, usage_completion, usage_cached, usage_cost_pico FROM turns WHERE loop_id = ?").get(loopId) as {
            usage_prompt: number; usage_completion: number; usage_cached: number; usage_cost_pico: number;
        };
        assert.equal(row.usage_prompt, 50000);
        assert.equal(row.usage_completion, 12345);
        assert.equal(row.usage_cached, 200);
        assert.equal(row.usage_cost_pico, 9876543210);
    } finally { db.close(); }
});

test("turns: aggregation query — SUM(usage_cost_pico) over a loop's turns", async () => {
    const { db, loopId } = await setup();
    try {
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet, usage_cost_pico) VALUES (?, ?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET, 100);
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet, usage_cost_pico) VALUES (?, ?, ?, ?, ?)").run(loopId, 2, 200, MIN_PACKET, 250);
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet, usage_cost_pico) VALUES (?, ?, ?, ?, ?)").run(loopId, 3, 200, MIN_PACKET, 75);
        const row = db.prepare("SELECT SUM(usage_cost_pico) AS total FROM turns WHERE loop_id = ?").get(loopId) as { total: number };
        assert.equal(row.total, 425);
    } finally { db.close(); }
});

test("turns: negative version rejected by CHECK", async () => {
    const { db, loopId } = await setup();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO turns (loop_id, sequence, status, packet, version) VALUES (?, ?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET, -1),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("turns: unique index turns_loop_id_sequence exists with UNIQUE marker", async () => {
    const { db } = await setup();
    try {
        const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'turns_loop_id_sequence'").get() as { name: string; sql: string } | undefined;
        assert.equal(row?.name, "turns_loop_id_sequence");
        assert.match(row?.sql ?? "", /UNIQUE/);
    } finally { db.close(); }
});

test("turns: index turns_timestamp exists", async () => {
    const { db } = await setup();
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'turns_timestamp'").get() as { name: string } | undefined;
        assert.equal(row?.name, "turns_timestamp");
    } finally { db.close(); }
});

test("turns: id auto-assigns on insert (INTEGER PRIMARY KEY rowid alias)", async () => {
    const { db, loopId } = await setup();
    try {
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 1, 200, MIN_PACKET);
        db.prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, ?, ?)").run(loopId, 2, 200, MIN_PACKET);
        const rows = db.prepare("SELECT id FROM turns WHERE loop_id = ? ORDER BY id").all(loopId) as { id: number }[];
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { db.close(); }
});
