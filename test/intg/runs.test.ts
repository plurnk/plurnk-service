import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod, ExecMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession } from "./_helpers.ts";

let nameCounter = 0;
const n = (suffix: string): string => `run-${suffix}-${++nameCounter}`;

test("runs: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_runs_table_sql as PrepMethod).get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("runs: trunk run insert — null parent_run_id, defaults populate", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-trunk");
        await (db.test_runs_insert as PrepMethod).run({ session_id: sessionId, name: n("trunk") });
        const row = await (db.test_runs_get_by_session as PrepMethod).get<{
            id: number; version: number; session_id: number; name: string; created_at: string;
            parent_run_id: number | null; cost_pico: number;
        }>({ session_id: sessionId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.session_id, sessionId);
        assert.match(row?.name ?? "", /^run-trunk-\d+$/);
        assert.match(row?.created_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.parent_run_id, null);
        assert.equal(row?.cost_pico, 0);
    } finally { await db.close(); }
});

test("runs: fork insert — non-null parent_run_id pointing at trunk run", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-fork");
        const trunk = await (db.test_runs_insert_returning as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: n("trunk") });
        const fork = await (db.test_runs_insert_with_parent_returning as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: n("fork"), parent_run_id: trunk?.id });
        const forkRow = await (db.test_runs_get_parent as PrepMethod).get<{ parent_run_id: number }>({ id: fork?.id });
        assert.equal(forkRow?.parent_run_id, trunk?.id);
    } finally { await db.close(); }
});

test("runs: session_id NOT NULL — insert without session_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_runs_insert_default_values as ExecMethod)(),
            /NOT NULL constraint failed: runs\.session_id/,
        );
    } finally { await db.close(); }
});

test("runs: session_id FK — insert against non-existent session rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_runs_insert as PrepMethod).run({ session_id: 99999, name: n("fk-fail") }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: parent_run_id FK — insert against non-existent parent rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-badparent");
        await assert.rejects(
            () => (db.test_runs_insert_with_parent as PrepMethod).run({ session_id: sessionId, name: n("badparent"), parent_run_id: 99999 }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: parent_run_id self-reference CHECK — parent != id rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-self");
        const run = await (db.test_runs_insert_returning as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: n("self") });
        await assert.rejects(
            () => (db.test_runs_set_parent as PrepMethod).run({ parent_run_id: run?.id, id: run?.id }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: ON DELETE CASCADE via session — deleting session removes all its runs", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-cascade");
        const otherSessionId = await insertSession(db, "ws-untouched");
        await (db.test_runs_insert as PrepMethod).run({ session_id: sessionId, name: n("c1") });
        await (db.test_runs_insert as PrepMethod).run({ session_id: sessionId, name: n("c2") });
        await (db.test_runs_insert as PrepMethod).run({ session_id: otherSessionId, name: n("c3") });
        const before = await (db.test_runs_count as PrepMethod).get<{ n: number }>();
        assert.equal(before?.n, 3);
        await (db.test_sessions_delete as PrepMethod).run({ id: sessionId });
        const after = await (db.test_runs_count as PrepMethod).get<{ n: number }>();
        assert.equal(after?.n, 1);
        const survivor = await (db.test_runs_get_one_session_id as PrepMethod).get<{ session_id: number }>();
        assert.equal(survivor?.session_id, otherSessionId);
    } finally { await db.close(); }
});

test("runs: ON DELETE CASCADE via parent_run_id — deleting a parent run removes its forks", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-forkcascade");
        const trunk = await (db.test_runs_insert_returning as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: n("fc-trunk") });
        const trunkId = trunk!.id;
        const forkA = await (db.test_runs_insert_with_parent_returning as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: n("fc-fA"), parent_run_id: trunkId });
        await (db.test_runs_insert_with_parent as PrepMethod).run({ session_id: sessionId, name: n("fc-fB"), parent_run_id: trunkId });
        await (db.test_runs_insert_with_parent as PrepMethod).run({ session_id: sessionId, name: n("fc-fC"), parent_run_id: forkA?.id });
        const before = await (db.test_runs_count as PrepMethod).get<{ n: number }>();
        assert.equal(before?.n, 4);
        await (db.test_runs_delete as PrepMethod).run({ id: trunkId });
        const after = await (db.test_runs_count as PrepMethod).get<{ n: number }>();
        assert.equal(after?.n, 0);
    } finally { await db.close(); }
});

test("runs: negative cost_pico rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-negcost");
        await assert.rejects(
            () => (db.test_runs_insert_cost as PrepMethod).run({ session_id: sessionId, name: n("negcost"), cost_pico: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-negversion");
        await assert.rejects(
            () => (db.test_runs_insert_version as PrepMethod).run({ session_id: sessionId, name: n("negversion"), version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("runs: index runs_session_id_created_at exists", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_runs_index_exists as PrepMethod).get<{ name: string }>({ name: "runs_session_id_created_at" });
        assert.equal(row?.name, "runs_session_id_created_at");
    } finally { await db.close(); }
});

test("runs: index runs_parent_run_id exists", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_runs_index_exists as PrepMethod).get<{ name: string }>({ name: "runs_parent_run_id" });
        assert.equal(row?.name, "runs_parent_run_id");
    } finally { await db.close(); }
});

test("runs: unique (session_id, name) — duplicate name within session rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-uniqname");
        await (db.test_runs_insert as PrepMethod).run({ session_id: sessionId, name: "same-name" });
        await assert.rejects(
            () => (db.test_runs_insert as PrepMethod).run({ session_id: sessionId, name: "same-name" }),
            /UNIQUE constraint failed/,
        );
        // Same name in different session is fine.
        const otherSessionId = await insertSession(db, "ws-uniqname-other");
        await (db.test_runs_insert as PrepMethod).run({ session_id: otherSessionId, name: "same-name" });
    } finally { await db.close(); }
});

test("runs: id auto-assigns on insert", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-autoid");
        await (db.test_runs_insert as PrepMethod).run({ session_id: sessionId, name: n("auto-a") });
        await (db.test_runs_insert as PrepMethod).run({ session_id: sessionId, name: n("auto-b") });
        const rows = await (db.test_runs_list_by_session as PrepMethod).all<{ id: number }>({ session_id: sessionId });
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});

test("runs: trunk-run lookup uses the (session_id, created_at) index", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-trunklookup");
        const trunk = await (db.test_runs_insert_returning as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: n("tl-trunk") });
        await (db.test_runs_insert_with_parent as PrepMethod).run({ session_id: sessionId, name: n("tl-fA"), parent_run_id: trunk?.id });
        await (db.test_runs_insert_with_parent as PrepMethod).run({ session_id: sessionId, name: n("tl-fB"), parent_run_id: trunk?.id });
        const found = await (db.test_runs_trunk_lookup as PrepMethod).get<{ id: number }>({ session_id: sessionId });
        assert.equal(found?.id, trunk?.id);
    } finally { await db.close(); }
});
