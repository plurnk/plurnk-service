import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validator } from "@plurnk/plurnk-contracts";
import ProblemLog from "../../src/core/ProblemLog.ts";
import Results from "../../src/core/results.ts";
import Digest from "../../src/digest/Digest.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("ProblemLog persists one self-identifying RFC 9457 operation failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-problem-log-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, `problem-log-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 3, "test");
        const turnId = await insertTurn(db, loopId, 4, 102);
        const minted = await new ProblemLog(db).record({
            workerId,
            loopId,
            turnId,
            sequence: 5,
            origin: "plurnk",
            source: "rail",
            result: Results.failure(
                "engine:rail",
                "test-failure",
                409,
                "The test contract failed.",
                {},
                { retryable: false },
            ),
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
        const [row] = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.deepEqual(JSON.parse(row!.rx), minted.result, "the returned and durable failure are identical");
        Digest.run({ dbPath, digestDir });
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{ problem?: unknown }>;
        };
        assert.deepEqual(
            digest.log_entries[0]?.problem,
            minted.result.problem,
            "the digest preserves the same complete Problem occurrence",
        );
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
