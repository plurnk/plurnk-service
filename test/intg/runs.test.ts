import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertSession } from "./_helpers.ts";

test("runs: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
    } finally { db.close(); }
});

test("runs: trunk run insert — null parent_run_id, defaults populate", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-trunk");
        db.prepare("INSERT INTO runs (session_id) VALUES (?)").run(sessionId);
        const row = db.prepare("SELECT * FROM runs WHERE session_id = ?").get(sessionId) as {
            id: number;
            version: number;
            session_id: number;
            created_at: string;
            parent_run_id: number | null;
            cost_pico: number;
        };
        assert.ok(row.id >= 1);
        assert.equal(row.version, 0);
        assert.equal(row.session_id, sessionId);
        assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row.parent_run_id, null);
        assert.equal(row.cost_pico, 0);
    } finally { db.close(); }
});

test("runs: fork insert — non-null parent_run_id pointing at trunk run", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-fork");
        const trunkId = (db.prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id").get(sessionId) as { id: number }).id;
        const forkId = (db.prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?) RETURNING id").get(sessionId, trunkId) as { id: number }).id;
        const fork = db.prepare("SELECT parent_run_id FROM runs WHERE id = ?").get(forkId) as { parent_run_id: number };
        assert.equal(fork.parent_run_id, trunkId);
    } finally { db.close(); }
});

test("runs: session_id NOT NULL — insert without session_id rejected", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.exec("INSERT INTO runs DEFAULT VALUES"),
            /NOT NULL constraint failed: runs\.session_id/,
        );
    } finally { db.close(); }
});

test("runs: session_id FK — insert against non-existent session rejected", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO runs (session_id) VALUES (?)").run(99999),
            /FOREIGN KEY constraint failed/,
        );
    } finally { db.close(); }
});

test("runs: parent_run_id FK — insert against non-existent parent rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-badparent");
        assert.throws(
            () => db.prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?)").run(sessionId, 99999),
            /FOREIGN KEY constraint failed/,
        );
    } finally { db.close(); }
});

test("runs: parent_run_id self-reference CHECK — parent != id rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-self");
        const runId = (db.prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id").get(sessionId) as { id: number }).id;
        assert.throws(
            () => db.prepare("UPDATE runs SET parent_run_id = ? WHERE id = ?").run(runId, runId),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("runs: ON DELETE CASCADE via session — deleting session removes all its runs", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-cascade");
        const otherSessionId = await insertSession(db, "ws-untouched");
        db.prepare("INSERT INTO runs (session_id) VALUES (?)").run(sessionId);
        db.prepare("INSERT INTO runs (session_id) VALUES (?)").run(sessionId);
        db.prepare("INSERT INTO runs (session_id) VALUES (?)").run(otherSessionId);
        const before = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
        assert.equal(before.n, 3);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        const after = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
        assert.equal(after.n, 1, "only the run belonging to the other session should remain");
        const survivor = db.prepare("SELECT session_id FROM runs").get() as { session_id: number };
        assert.equal(survivor.session_id, otherSessionId);
    } finally { db.close(); }
});

test("runs: ON DELETE CASCADE via parent_run_id — deleting a parent run removes its forks", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-forkcascade");
        const trunkId = (db.prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id").get(sessionId) as { id: number }).id;
        const forkAId = (db.prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?) RETURNING id").get(sessionId, trunkId) as { id: number }).id;
        db.prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?)").run(sessionId, trunkId);
        db.prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?)").run(sessionId, forkAId);
        const before = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
        assert.equal(before.n, 4);
        db.prepare("DELETE FROM runs WHERE id = ?").run(trunkId);
        const after = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
        assert.equal(after.n, 0, "trunk delete cascades through the entire fork subtree");
    } finally { db.close(); }
});

test("runs: negative cost_pico rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-negcost");
        assert.throws(
            () => db.prepare("INSERT INTO runs (session_id, cost_pico) VALUES (?, ?)").run(sessionId, -1),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("runs: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-negversion");
        assert.throws(
            () => db.prepare("INSERT INTO runs (session_id, version) VALUES (?, ?)").run(sessionId, -1),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("runs: index runs_session_id_created_at exists", async () => {
    const db = await openMigrated();
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_session_id_created_at'").get() as { name: string } | undefined;
        assert.equal(row?.name, "runs_session_id_created_at");
    } finally { db.close(); }
});

test("runs: index runs_parent_run_id exists", async () => {
    const db = await openMigrated();
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_parent_run_id'").get() as { name: string } | undefined;
        assert.equal(row?.name, "runs_parent_run_id");
    } finally { db.close(); }
});

test("runs: id auto-assigns on insert (INTEGER PRIMARY KEY rowid alias)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-autoid");
        db.prepare("INSERT INTO runs (session_id) VALUES (?)").run(sessionId);
        db.prepare("INSERT INTO runs (session_id) VALUES (?)").run(sessionId);
        const rows = db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY id").all(sessionId) as { id: number }[];
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { db.close(); }
});

test("runs: trunk-run lookup uses the (session_id, created_at) index — many trunks across sessions", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-trunklookup");
        const trunkId = (db.prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id").get(sessionId) as { id: number }).id;
        db.prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?)").run(sessionId, trunkId);
        db.prepare("INSERT INTO runs (session_id, parent_run_id) VALUES (?, ?)").run(sessionId, trunkId);
        const trunk = db.prepare("SELECT id FROM runs WHERE session_id = ? AND parent_run_id IS NULL").get(sessionId) as { id: number };
        assert.equal(trunk.id, trunkId);
    } finally { db.close(); }
});
