import test from "node:test";
import assert from "node:assert/strict";
import { Validator } from "@plurnk/plurnk-grammar";
import ProblemLog from "../../src/core/ProblemLog.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("ProblemLog persists one self-identifying RFC 9457 operation failure", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `problem-log-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 3, "test");
        const turnId = await insertTurn(db, loopId, 4, 102);
        const minted = await new ProblemLog(db).mint({
            workerId,
            loopId,
            turnId,
            sequence: 5,
            origin: "plurnk",
            source: "rail",
            owner: "engine:rail",
            code: "test-failure",
            status: 409,
            detail: "The test contract failed.",
            extensions: { retryable: false },
        });

        assert.equal(Validator.validateOperationResult(minted.result).valid, true);
        assert.deepEqual(minted.result, {
            status: 409,
            problem: {
                type: "https://problems.plurnk.dev/engine/rail/test-failure",
                title: "Test failure",
                status: 409,
                detail: "The test contract failed.",
                retryable: false,
                instance: "log:///3/4/5/error",
            },
        });
        const [row] = await db.test_error_rows_for_run.all<{ rx: string }>({ worker_id: workerId });
        assert.deepEqual(JSON.parse(row!.rx), minted.result, "the returned and durable failure are identical");
    } finally {
        await db.close();
    }
});
