import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const insertAgentEntry = async (db: Db, scheme: string, pathname: string): Promise<number> => {
    const row = await (db.test_visibility_insert_agent_entry as PrepMethod).get<{ id: number }>({ scheme, pathname });
    if (row === undefined) throw new Error("agent entry insert returned no row");
    return row.id;
};

test("visibility: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_visibility_table_sql as PrepMethod).get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
        assert.match(row?.sql ?? "", /WITHOUT ROWID/);
    } finally { await db.close(); }
});

test("visibility: insert minimal — indexed defaults to 1", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-default");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await (db.test_visibility_insert_default as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "body" });
        const row = await (db.test_visibility_get_first as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: entryId });
        assert.equal(row?.indexed, 1);
    } finally { await db.close(); }
});

test("visibility: composite PK — duplicate rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-pk");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "body", indexed: 1 });
        await assert.rejects(
            () => (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "body", indexed: 0 }),
            /UNIQUE constraint failed|PRIMARY KEY/,
        );
    } finally { await db.close(); }
});

test("visibility: same channel across different runs is fine", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-crossrun");
        const runA = await insertRun(db, sessionId);
        const runB = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runA, entry_id: entryId, channel: "body", indexed: 1 });
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runB, entry_id: entryId, channel: "body", indexed: 0 });
        const count = (await (db.test_visibility_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("visibility: same entry, different channels", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-multichan");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "exec", "ls");
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "stdout", indexed: 1 });
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "stderr", indexed: 0 });
        const rows = await (db.test_visibility_by_run_entry as PrepMethod).all<{ channel: string; indexed: number }>({ run_id: runId, entry_id: entryId });
        assert.deepEqual(rows.map((r) => ({ channel: r.channel, indexed: r.indexed })), [{ channel: "stderr", indexed: 0 }, { channel: "stdout", indexed: 1 }]);
    } finally { await db.close(); }
});

test("visibility: indexed CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-indexed");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "a", indexed: 0 });
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "b", indexed: 1 });
        for (const bad of [-1, 2, 100]) {
            await assert.rejects(
                () => (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "x", indexed: bad }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("visibility: empty channel rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-emptychan");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await assert.rejects(
            () => (db.test_visibility_insert_default as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("visibility: NOT NULL on run_id, entry_id, channel", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-notnull");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await assert.rejects(
            () => (db.test_visibility_insert_missing_run_id as PrepMethod).run({ entry_id: entryId, channel: "body" }),
            /NOT NULL constraint failed: visibility\.run_id/,
        );
        await assert.rejects(
            () => (db.test_visibility_insert_missing_entry_id as PrepMethod).run({ run_id: runId, channel: "body" }),
            /NOT NULL constraint failed: visibility\.entry_id/,
        );
        await assert.rejects(
            () => (db.test_visibility_insert_missing_channel as PrepMethod).run({ run_id: runId, entry_id: entryId }),
            /NOT NULL constraint failed: visibility\.channel/,
        );
    } finally { await db.close(); }
});

test("visibility: FK rejection on bad run_id", async () => {
    const db = await openMigrated();
    try {
        const entryId = await insertAgentEntry(db, "known", "france");
        await assert.rejects(
            () => (db.test_visibility_insert_default as PrepMethod).run({ run_id: 99999, entry_id: entryId, channel: "body" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("visibility: FK rejection on bad entry_id", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-badentry");
        const runId = await insertRun(db, sessionId);
        await assert.rejects(
            () => (db.test_visibility_insert_default as PrepMethod).run({ run_id: runId, entry_id: 99999, channel: "body" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("visibility: ON DELETE CASCADE via run", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-runcasc");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await (db.test_visibility_insert_default as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "a" });
        await (db.test_visibility_insert_default as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "b" });
        await (db.test_runs_delete as PrepMethod).run({ id: runId });
        const count = (await (db.test_visibility_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("visibility: ON DELETE CASCADE via entry", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-entrycasc");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await (db.test_visibility_insert_default as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "body" });
        await (db.test_visibility_delete_entry as PrepMethod).run({ id: entryId });
        const count = (await (db.test_visibility_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("visibility: CASCADE chain via session→runs→visibility", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-sessioncasc");
        const runId = await insertRun(db, sessionId);
        const entryId = await insertAgentEntry(db, "known", "france");
        await (db.test_visibility_insert_default as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: "body" });
        await (db.test_sessions_delete as PrepMethod).run({ id: sessionId });
        const count = (await (db.test_visibility_count_all as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("visibility: 'indexed entries in run X' lookup uses PK prefix", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-vis-indlookup");
        const runId = await insertRun(db, sessionId);
        const a = await insertAgentEntry(db, "known", "a");
        const b = await insertAgentEntry(db, "known", "b");
        const c = await insertAgentEntry(db, "known", "c");
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: a, channel: "body", indexed: 1 });
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: b, channel: "body", indexed: 0 });
        await (db.test_visibility_insert_with_indexed as PrepMethod).run({ run_id: runId, entry_id: c, channel: "body", indexed: 1 });
        const rows = await (db.test_visibility_indexed_by_run as PrepMethod).all<{ entry_id: number }>({ run_id: runId });
        assert.deepEqual(rows.map((r) => r.entry_id).toSorted(), [a, c].toSorted());
    } finally { await db.close(); }
});
