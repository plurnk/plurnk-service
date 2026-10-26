import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";

const seedSession = async (db: Db, label: string): Promise<number> => {
    const workspaceId = await insertWorkspace(db, label);
    return insertSession(db, workspaceId);
};

const terminalResult = (status: number, sequence: number): string | null => {
    if ([100, 102, 202].includes(status)) return null;
    if (status < 400) return JSON.stringify({ status });
    return JSON.stringify({
        status,
        problem: {
            type: "https://problems.plurnk.xyz/test/fixture/terminal",
            title: "Test terminal",
            status,
            detail: "The test fixture made this loop terminal.",
            instance: `ops://fixture/${sequence}`,
        },
    });
};

test("{§loop-terminals} loops: status enum — 102, 200, 413, 429, 499, 500, 508 all accepted", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-enum");
        // The full terminal vocabulary: model SENDs (200), engine-imposed ceilings
        // (413 budget, 429 turn-cap), cancel (499), and the strike split (500 fail,
        // 508 runaway). 102 = running. (100 queued is covered in the next test.)
        const valid = [102, 200, 413, 429, 499, 500, 508];
        for (const [i, status] of valid.entries()) {
            await db.test_loops_insert_with_status.run({
                session_id: sessionId,
                sequence: i + 1,
                status,
                prompt: "x",
                terminal_result: terminalResult(status, i + 1),
            });
        }
        const rows = await db.test_loops_statuses_by_session.all<{ status: number }>({ session_id: sessionId });
        assert.deepEqual(rows.map((r) => r.status), valid);
    } finally { await db.close(); }
});

test("{§loop-terminals} loops: status enum accepts 100 (queued) — drain prerequisite", async () => {
    // 100 = "enqueued, awaiting drain claim." Drain flips 100 → 102 atomically
    // when it picks a loop up. Pre-drain enqueueing relies on this state being
    // legal in the CHECK constraint.
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-queued");
        await db.test_loops_insert_with_status.run({
            session_id: sessionId,
            sequence: 1,
            status: 100,
            prompt: "queued",
            terminal_result: null,
        });
        const rows = await db.test_loops_statuses_by_session.all<{ status: number }>({ session_id: sessionId });
        assert.deepEqual(rows.map((r) => r.status), [100]);
    } finally { await db.close(); }
});

test("{§session-lifecycle-terminal-result} loops: one terminal-result constraint rejects incomplete failures on insert and update", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-terminal-result");
        await assert.rejects(
            () => db.test_loops_insert_with_status.run({
                session_id: sessionId,
                sequence: 1,
                status: 500,
                prompt: "invalid insert",
                terminal_result: JSON.stringify({ status: 500 }),
            }),
            /loops_terminal_result_contract/,
            "a failed result cannot omit its Problem",
        );

        await db.test_loops_insert.run({
            session_id: sessionId,
            sequence: 2,
            prompt: "invalid update",
        });
        const loop = await db.test_loops_get_by_session.get<{ id: number }>({ session_id: sessionId });
        assert.ok(loop);
        await assert.rejects(
            () => db.test_set_loop_status.run({
                id: loop.id,
                status: 500,
                terminal_result: JSON.stringify({ status: 500 }),
            }),
            /loops_terminal_result_contract/,
            "an update cannot exploit SQLite NULL truth to omit its Problem",
        );
    } finally { await db.close(); }
});

test("{§loop-terminals} loops: status enum rejects non-enum values (e.g. 201, 300, 0, -1)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-badenum");
        // 201/300 are valid HTTP but not loop statuses; 0/-1 are out of range.
        for (const bad of [201, 300, 0, -1]) {
            await assert.rejects(
                () => db.test_loops_insert_with_status.run({
                    session_id: sessionId,
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

test("{§validation-topology} loops: sequence < 1 rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-seqzero");
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: sessionId, sequence: 0, prompt: "x" }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: sessionId, sequence: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§session-loop-result} loops: (session_id, sequence) UNIQUE — duplicate within session rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-uniq");
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "a" });
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "b" }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§session-loop-result} loops: same sequence number across different sessions is fine", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-loops-crossrun");
        const sessionA = await insertSession(db, workspaceId);
        const sessionB = await insertSession(db, workspaceId);
        await db.test_loops_insert.run({ session_id: sessionA, sequence: 1, prompt: "a-1" });
        await db.test_loops_insert.run({ session_id: sessionB, sequence: 1, prompt: "b-1" });
        const count = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("{§validation-topology} loops: session_id NOT NULL — insert without session_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_loops_insert_no_session_id(),
            /NOT NULL constraint failed: loops\.session_id/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} loops: empty prompt is allowed", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-emptyprompt");
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "" });
        const row = await db.test_loops_get_prompt.get<{ prompt: string }>({ session_id: sessionId });
        assert.equal(row?.prompt, "");
    } finally { await db.close(); }
});

test("{§validation-topology} loops: session_id FK — insert against non-existent session rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: 99999, sequence: 1, prompt: "x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§validation-topology} loops: ON DELETE CASCADE via session — deleting session removes its loops", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-runcascade");
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "a" });
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 2, prompt: "b" });
        await db.test_sessions_delete.run({ id: sessionId });
        const remaining = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§validation-topology} loops: CASCADE chain via workspace→sessions→loops", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-loops-workspacecascade");
        const sessionId = await insertSession(db, workspaceId);
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "a" });
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§validation-topology} loops: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-negver");
        await assert.rejects(
            () => db.test_loops_insert_with_version.run({ session_id: sessionId, sequence: 1, version: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});
