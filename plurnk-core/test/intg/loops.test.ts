import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker } from "./_helpers.ts";

const seedWorker = async (db: Db, label: string): Promise<number> => {
    const workspaceId = await insertWorkspace(db, label);
    return insertWorker(db, workspaceId);
};

const terminalResult = (status: number, sequence: number): string | null => {
    if ([100, 102, 202].includes(status)) return null;
    if (status < 400) return JSON.stringify({ status });
    return JSON.stringify({
        status,
        problem: {
            type: "https://problems.plurnk.dev/test/fixture/terminal",
            title: "Test terminal",
            status,
            detail: "The test fixture made this loop terminal.",
            instance: `loop:///fixture/${sequence}`,
        },
    });
};

test("loops: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_loops_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("loops: insert with required fields — status defaults to 102", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-default");
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 1, prompt: "decompose the prompt" });
        const row = await db.test_loops_get_by_run.get<{ id: number; version: number; worker_id: number; sequence: number; status: number; prompt: string }>({ worker_id: workerId });
        assert.ok((row?.id ?? 0) >= 1);
        assert.equal(row?.version, 0);
        assert.equal(row?.worker_id, workerId);
        assert.equal(row?.sequence, 1);
        assert.equal(row?.status, 102);
        assert.equal(row?.prompt, "decompose the prompt");
    } finally { await db.close(); }
});

test("loops: status enum — 102, 200, 413, 429, 499, 500, 508 all accepted", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-enum");
        // The full terminal vocabulary: model SENDs (200), engine-imposed ceilings
        // (413 budget, 429 turn-cap), cancel (499), and the strike split (500 fail,
        // 508 runaway). 102 = running. (100 queued is covered in the next test.)
        const valid = [102, 200, 413, 429, 499, 500, 508];
        for (const [i, status] of valid.entries()) {
            await db.test_loops_insert_with_status.run({
                worker_id: workerId,
                sequence: i + 1,
                status,
                prompt: "x",
                terminal_result: terminalResult(status, i + 1),
            });
        }
        const rows = await db.test_loops_statuses_by_run.all<{ status: number }>({ worker_id: workerId });
        assert.deepEqual(rows.map((r) => r.status), valid);
    } finally { await db.close(); }
});

test("loops: status enum accepts 100 (queued) — drain prerequisite", async () => {
    // 100 = "enqueued, awaiting drain claim." Drain flips 100 → 102 atomically
    // when it picks a loop up. Pre-drain enqueueing relies on this state being
    // legal in the CHECK constraint.
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-queued");
        await db.test_loops_insert_with_status.run({
            worker_id: workerId,
            sequence: 1,
            status: 100,
            prompt: "queued",
            terminal_result: null,
        });
        const rows = await db.test_loops_statuses_by_run.all<{ status: number }>({ worker_id: workerId });
        assert.deepEqual(rows.map((r) => r.status), [100]);
    } finally { await db.close(); }
});

test("loops: status enum rejects non-enum values (e.g. 201, 300, 0, -1)", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-badenum");
        // 201/300 are valid HTTP but not loop statuses; 0/-1 are out of range.
        for (const bad of [201, 300, 0, -1]) {
            await assert.rejects(
                () => db.test_loops_insert_with_status.run({
                    worker_id: workerId,
                    sequence: 1,
                    status: bad,
                    prompt: "x",
                    terminal_result: terminalResult(bad, 1),
                }),
                /CHECK constraint failed/,
                `status ${bad} should be rejected`,
            );
        }
    } finally { await db.close(); }
});

test("loops: sequence < 1 rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-seqzero");
        await assert.rejects(
            () => db.test_loops_insert.run({ worker_id: workerId, sequence: 0, prompt: "x" }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => db.test_loops_insert.run({ worker_id: workerId, sequence: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: (worker_id, sequence) UNIQUE — duplicate within run rejected", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-uniq");
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 1, prompt: "a" });
        await assert.rejects(
            () => db.test_loops_insert.run({ worker_id: workerId, sequence: 1, prompt: "b" }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: same sequence number across different runs is fine", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-loops-crossrun");
        const workerA = await insertWorker(db, workspaceId);
        const workerB = await insertWorker(db, workspaceId);
        await db.test_loops_insert.run({ worker_id: workerA, sequence: 1, prompt: "a-1" });
        await db.test_loops_insert.run({ worker_id: workerB, sequence: 1, prompt: "b-1" });
        const count = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("loops: worker_id NOT NULL — insert without worker_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_loops_insert_no_worker_id(),
            /NOT NULL constraint failed: loops\.worker_id/,
        );
    } finally { await db.close(); }
});

test("loops: empty prompt is allowed", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-emptyprompt");
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 1, prompt: "" });
        const row = await db.test_loops_get_prompt.get<{ prompt: string }>({ worker_id: workerId });
        assert.equal(row?.prompt, "");
    } finally { await db.close(); }
});

test("loops: worker_id FK — insert against non-existent run rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_loops_insert.run({ worker_id: 99999, sequence: 1, prompt: "x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: ON DELETE CASCADE via run — deleting run removes its loops", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-runcascade");
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 1, prompt: "a" });
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 2, prompt: "b" });
        await db.test_runs_delete.run({ id: workerId });
        const remaining = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("loops: CASCADE chain via workspace→runs→loops", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-loops-sessioncascade");
        const workerId = await insertWorker(db, workspaceId);
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 1, prompt: "a" });
        await db.test_sessions_delete.run({ id: workspaceId });
        const remaining = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("loops: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-negver");
        await assert.rejects(
            () => db.test_loops_insert_with_version.run({ worker_id: workerId, sequence: 1, version: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("loops: unique index loops_worker_id_sequence exists", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_loops_index_meta.get<{ name: string; sql: string }>();
        assert.equal(row?.name, "loops_worker_id_sequence");
        assert.match(row?.sql ?? "", /UNIQUE/);
    } finally { await db.close(); }
});

test("loops: id auto-assigns on insert", async () => {
    const db = await openMigrated();
    try {
        const workerId = await seedWorker(db, "ws-loops-autoid");
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 1, prompt: "a" });
        await db.test_loops_insert.run({ worker_id: workerId, sequence: 2, prompt: "b" });
        const rows = await db.test_loops_list_ids.all<{ id: number }>({ worker_id: workerId });
        assert.equal(rows[1]!.id, rows[0]!.id + 1);
    } finally { await db.close(); }
});
