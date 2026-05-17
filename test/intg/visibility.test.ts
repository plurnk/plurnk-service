import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const insertAgentEntry = (db: DatabaseSync, scheme: string, pathname: string): number => {
    const row = db.prepare("INSERT INTO entries (scope, scheme, pathname) VALUES ('agent', ?, ?) RETURNING id").get(scheme, pathname) as { id: number };
    return row.id;
};

test("visibility: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'visibility'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
        assert.match(sql, /WITHOUT ROWID/);
    } finally { db.close(); }
});

test("visibility: insert minimal — indexed defaults to 1", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-default"));
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, 'body')").run(runId, entryId);
        const row = db.prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ?").get(runId, entryId) as { indexed: number };
        assert.equal(row.indexed, 1);
    } finally { db.close(); }
});

test("visibility: composite PK (run_id, entry_id, channel) — duplicate rejected", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-pk"));
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 1)").run(runId, entryId);
        assert.throws(
            () => db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 0)").run(runId, entryId),
            /UNIQUE constraint failed|PRIMARY KEY/,
        );
    } finally { db.close(); }
});

test("visibility: same channel across different runs is fine — run-scoped state", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-vis-crossrun");
        const runA = insertRun(db, sessionId);
        const runB = insertRun(db, sessionId);
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 1)").run(runA, entryId);
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 0)").run(runB, entryId);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM visibility").get() as { n: number }).n;
        assert.equal(count, 2);
    } finally { db.close(); }
});

test("visibility: same entry, different channels — both can have visibility rows", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-multichan"));
        const entryId = insertAgentEntry(db, "exec", "ls");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'stdout', 1)").run(runId, entryId);
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'stderr', 0)").run(runId, entryId);
        const rows = db.prepare("SELECT channel, indexed FROM visibility WHERE run_id = ? AND entry_id = ? ORDER BY channel").all(runId, entryId) as { channel: string; indexed: number }[];
        const shape = rows.map((r) => ({ channel: r.channel, indexed: r.indexed }));
        assert.deepEqual(shape, [{ channel: "stderr", indexed: 0 }, { channel: "stdout", indexed: 1 }]);
    } finally { db.close(); }
});

test("visibility: indexed CHECK — only 0 and 1 accepted; other values rejected", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-indexed"));
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'a', 0)").run(runId, entryId);
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'b', 1)").run(runId, entryId);
        for (const bad of [-1, 2, 100]) {
            assert.throws(
                () => db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'x', ?)").run(runId, entryId, bad),
                /CHECK constraint failed/,
            );
        }
    } finally { db.close(); }
});

test("visibility: empty channel rejected by CHECK length > 0", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-emptychan"));
        const entryId = insertAgentEntry(db, "known", "france");
        assert.throws(
            () => db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, '')").run(runId, entryId),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("visibility: NOT NULL on run_id, entry_id, channel", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-notnull"));
        const entryId = insertAgentEntry(db, "known", "france");
        assert.throws(() => db.exec(`INSERT INTO visibility (entry_id, channel) VALUES (${entryId}, 'body')`), /NOT NULL constraint failed: visibility\.run_id/);
        assert.throws(() => db.exec(`INSERT INTO visibility (run_id, channel) VALUES (${runId}, 'body')`), /NOT NULL constraint failed: visibility\.entry_id/);
        assert.throws(() => db.exec(`INSERT INTO visibility (run_id, entry_id) VALUES (${runId}, ${entryId})`), /NOT NULL constraint failed: visibility\.channel/);
    } finally { db.close(); }
});

test("visibility: FK rejection on bad run_id", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "france");
        assert.throws(
            () => db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, 'body')").run(99999, entryId),
            /FOREIGN KEY constraint failed/,
        );
    } finally { db.close(); }
});

test("visibility: FK rejection on bad entry_id", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-badentry"));
        assert.throws(
            () => db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, 'body')").run(runId, 99999),
            /FOREIGN KEY constraint failed/,
        );
    } finally { db.close(); }
});

test("visibility: ON DELETE CASCADE via run", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-runcasc"));
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, 'a')").run(runId, entryId);
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, 'b')").run(runId, entryId);
        db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM visibility").get() as { n: number }).n;
        assert.equal(count, 0);
    } finally { db.close(); }
});

test("visibility: ON DELETE CASCADE via entry", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-entrycasc"));
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, 'body')").run(runId, entryId);
        db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM visibility").get() as { n: number }).n;
        assert.equal(count, 0);
    } finally { db.close(); }
});

test("visibility: CASCADE chain via session→runs→visibility", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-vis-sessioncasc");
        const runId = insertRun(db, sessionId);
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel) VALUES (?, ?, 'body')").run(runId, entryId);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM visibility").get() as { n: number }).n;
        assert.equal(count, 0);
    } finally { db.close(); }
});

test("visibility: 'indexed entries in run X' lookup uses PK prefix", async () => {
    const db = await openMigrated();
    try {
        const runId = insertRun(db, insertSession(db, "ws-vis-indlookup"));
        const a = insertAgentEntry(db, "known", "a");
        const b = insertAgentEntry(db, "known", "b");
        const c = insertAgentEntry(db, "known", "c");
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 1)").run(runId, a);
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 0)").run(runId, b);
        db.prepare("INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, 'body', 1)").run(runId, c);
        const rows = db.prepare("SELECT entry_id FROM visibility WHERE run_id = ? AND indexed = 1 ORDER BY entry_id").all(runId) as { entry_id: number }[];
        assert.deepEqual(rows.map((r) => r.entry_id).toSorted(), [a, c].toSorted());
    } finally { db.close(); }
});
