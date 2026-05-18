import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod, ExecMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun } from "./_helpers.ts";

const seedRun = async (db: Db, label: string): Promise<number> => {
    const sessionId = await insertSession(db, label);
    return insertRun(db, sessionId);
};

test("loops: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_loops_table_sql as PrepMethod).get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("loops: insert with required fields — status defaults to 102", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-default");
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 1, prompt: "decompose the prompt" });
        const row = await (db.test_loops_get_by_run as PrepMethod).get<{ id: number; version: number; run_id: number; sequence: number; status: number; prompt: string }>({ run_id: runId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.run_id, runId);
        assert.equal(row?.sequence, 1);
        assert.equal(row?.status, 102);
        assert.equal(row?.prompt, "decompose the prompt");
    } finally { await db.close(); }
});

test("loops: status enum — 102, 200, 499 all accepted", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-enum");
        await (db.test_loops_insert_with_status as PrepMethod).run({ run_id: runId, sequence: 1, status: 102, prompt: "a" });
        await (db.test_loops_insert_with_status as PrepMethod).run({ run_id: runId, sequence: 2, status: 200, prompt: "b" });
        await (db.test_loops_insert_with_status as PrepMethod).run({ run_id: runId, sequence: 3, status: 499, prompt: "c" });
        const rows = await (db.test_loops_statuses_by_run as PrepMethod).all<{ status: number }>({ run_id: runId });
        assert.deepEqual(rows.map((r) => r.status), [102, 200, 499]);
    } finally { await db.close(); }
});

test("loops: status enum rejects other values (e.g. 100, 201, 500)", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-badenum");
        for (const bad of [100, 201, 500, 0, -1]) {
            await assert.rejects(
                () => (db.test_loops_insert_with_status as PrepMethod).run({ run_id: runId, sequence: 1, status: bad, prompt: "x" }),
                /CHECK constraint failed/,
                `status ${bad} should be rejected`,
            );
        }
    } finally { await db.close(); }
});

test("loops: sequence < 1 rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-seqzero");
        await assert.rejects(
            () => (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 0, prompt: "x" }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: (run_id, sequence) UNIQUE — duplicate within run rejected", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-uniq");
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 1, prompt: "a" });
        await assert.rejects(
            () => (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 1, prompt: "b" }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: same sequence number across different runs is fine", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-loops-crossrun");
        const runA = await insertRun(db, sessionId);
        const runB = await insertRun(db, sessionId);
        await (db.test_loops_insert as PrepMethod).run({ run_id: runA, sequence: 1, prompt: "a-1" });
        await (db.test_loops_insert as PrepMethod).run({ run_id: runB, sequence: 1, prompt: "b-1" });
        const count = (await (db.test_loops_count as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("loops: run_id NOT NULL — insert without run_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_loops_insert_no_run_id as ExecMethod)(),
            /NOT NULL constraint failed: loops\.run_id/,
        );
    } finally { await db.close(); }
});

test("loops: empty prompt is allowed", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-emptyprompt");
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 1, prompt: "" });
        const row = await (db.test_loops_get_prompt as PrepMethod).get<{ prompt: string }>({ run_id: runId });
        assert.equal(row?.prompt, "");
    } finally { await db.close(); }
});

test("loops: run_id FK — insert against non-existent run rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => (db.test_loops_insert as PrepMethod).run({ run_id: 99999, sequence: 1, prompt: "x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: ON DELETE CASCADE via run — deleting run removes its loops", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-runcascade");
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 1, prompt: "a" });
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 2, prompt: "b" });
        await (db.test_runs_delete as PrepMethod).run({ id: runId });
        const remaining = (await (db.test_loops_count as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("loops: CASCADE chain via session→runs→loops", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, "ws-loops-sessioncascade");
        const runId = await insertRun(db, sessionId);
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 1, prompt: "a" });
        await (db.test_sessions_delete as PrepMethod).run({ id: sessionId });
        const remaining = (await (db.test_loops_count as PrepMethod).get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("loops: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-negver");
        await assert.rejects(
            () => (db.test_loops_insert_with_version as PrepMethod).run({ run_id: runId, sequence: 1, version: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: unique index loops_run_id_sequence exists", async () => {
    const db = await openMigrated();
    try {
        const row = await (db.test_loops_index_meta as PrepMethod).get<{ name: string; sql: string }>();
        assert.equal(row?.name, "loops_run_id_sequence");
        assert.match(row?.sql ?? "", /UNIQUE/);
    } finally { await db.close(); }
});

test("loops: id auto-assigns on insert", async () => {
    const db = await openMigrated();
    try {
        const runId = await seedRun(db, "ws-loops-autoid");
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 1, prompt: "a" });
        await (db.test_loops_insert as PrepMethod).run({ run_id: runId, sequence: 2, prompt: "b" });
        const rows = await (db.test_loops_list_ids as PrepMethod).all<{ id: number }>({ run_id: runId });
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});
