import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

test("loops: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'loops'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
    } finally { db.close(); }
});

test("loops: insert with required fields — status defaults to 102 (continuing)", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-default"));
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 1, "decompose the prompt");
        const row = db.prepare("SELECT * FROM loops WHERE run_id = ?").get(runId) as {
            id: number;
            version: number;
            run_id: number;
            sequence: number;
            status: number;
            prompt: string;
        };
        assert.ok(row.id >= 1);
        assert.equal(row.version, 0);
        assert.equal(row.run_id, runId);
        assert.equal(row.sequence, 1);
        assert.equal(row.status, 102);
        assert.equal(row.prompt, "decompose the prompt");
    } finally { db.close(); }
});

test("loops: status enum — 102, 200, 499 all accepted", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-enum"));
        db.prepare("INSERT INTO loops (run_id, sequence, status, prompt) VALUES (?, ?, ?, ?)").run(runId, 1, 102, "a");
        db.prepare("INSERT INTO loops (run_id, sequence, status, prompt) VALUES (?, ?, ?, ?)").run(runId, 2, 200, "b");
        db.prepare("INSERT INTO loops (run_id, sequence, status, prompt) VALUES (?, ?, ?, ?)").run(runId, 3, 499, "c");
        const rows = db.prepare("SELECT status FROM loops WHERE run_id = ? ORDER BY sequence").all(runId) as { status: number }[];
        assert.deepEqual(rows.map((r) => r.status), [102, 200, 499]);
    } finally { db.close(); }
});

test("loops: status enum rejects other values (e.g. 100, 201, 500)", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-badenum"));
        for (const bad of [100, 201, 500, 0, -1]) {
            assert.throws(
                () => db.prepare("INSERT INTO loops (run_id, sequence, status, prompt) VALUES (?, ?, ?, ?)").run(runId, 1, bad, "x"),
                /CHECK constraint failed/,
                `status ${bad} should be rejected`,
            );
        }
    } finally { db.close(); }
});

test("loops: sequence < 1 rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-seqzero"));
        assert.throws(
            () => db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 0, "x"),
            /CHECK constraint failed/,
        );
        assert.throws(
            () => db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, -1, "x"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("loops: (run_id, sequence) UNIQUE — duplicate within run rejected", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-uniq"));
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 1, "a");
        assert.throws(
            () => db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 1, "b"),
            /UNIQUE constraint failed/,
        );
    } finally { db.close(); }
});

test("loops: same sequence number across different runs is fine", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-loops-crossrun");
        const runA = insertRun(db, sessionId);
        const runB = insertRun(db, sessionId);
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runA, 1, "a-1");
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runB, 1, "b-1");
        const count = (db.prepare("SELECT COUNT(*) AS n FROM loops").get() as { n: number }).n;
        assert.equal(count, 2);
    } finally { db.close(); }
});

test("loops: run_id NOT NULL — insert without run_id rejected", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.exec("INSERT INTO loops (sequence, prompt) VALUES (1, 'x')"),
            /NOT NULL constraint failed: loops\.run_id/,
        );
    } finally { db.close(); }
});

test("loops: prompt NOT NULL — insert without prompt rejected", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-noprompt"));
        assert.throws(
            () => db.exec(`INSERT INTO loops (run_id, sequence) VALUES (${runId}, 1)`),
            /NOT NULL constraint failed: loops\.prompt/,
        );
    } finally { db.close(); }
});

test("loops: empty prompt is allowed (grammar imposes no minLength)", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-emptyprompt"));
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 1, "");
        const row = db.prepare("SELECT prompt FROM loops WHERE run_id = ?").get(runId) as { prompt: string };
        assert.equal(row.prompt, "");
    } finally { db.close(); }
});

test("loops: run_id FK — insert against non-existent run rejected", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(99999, 1, "x"),
            /FOREIGN KEY constraint failed/,
        );
    } finally { db.close(); }
});

test("loops: ON DELETE CASCADE via run — deleting run removes its loops", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-runcascade"));
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 1, "a");
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 2, "b");
        db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM loops").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("loops: CASCADE chain via session→runs→loops — deleting session sweeps loops", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-loops-sessioncascade");
        const runId = insertRun(db, sessionId);
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 1, "a");
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM loops").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("loops: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-negver"));
        assert.throws(
            () => db.prepare("INSERT INTO loops (run_id, sequence, version, prompt) VALUES (?, ?, ?, ?)").run(runId, 1, -1, "x"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("loops: unique index loops_run_id_sequence exists", async () => {
    const db = await openMigrated();
    try {
        const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'loops_run_id_sequence'").get() as { name: string; sql: string } | undefined;
        assert.equal(row?.name, "loops_run_id_sequence");
        assert.match(row?.sql ?? "", /UNIQUE/);
    } finally { db.close(); }
});

test("loops: id auto-assigns on insert (INTEGER PRIMARY KEY rowid alias)", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-loops-autoid"));
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 1, "a");
        db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, ?, ?)").run(runId, 2, "b");
        const rows = db.prepare("SELECT id FROM loops WHERE run_id = ? ORDER BY id").all(runId) as { id: number }[];
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { db.close(); }
});
