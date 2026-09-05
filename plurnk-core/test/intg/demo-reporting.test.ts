import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openMigrated, insertWorkspace, insertWorker } from "./_helpers.ts";
import { readWorkerTopology } from "../WorkerTopology.ts";
import Owner from "../../src/core/Owner.ts";

test("{§methods-worker-list} topology reporting counts children and grandchildren, not independent roots", async () => {
    const db = await openMigrated();
    try {
        const workspace = await insertWorkspace(db, "topology-report");
        const commons = await Owner.commonsId(db, workspace);
        const root = await insertWorker(db, workspace, null, "root", "model");
        const independent = await insertWorker(db, workspace, null, "independent", "model");
        const child = await insertWorker(db, workspace, root, "child", "model");
        const grandchild = await insertWorker(db, workspace, child, "grandchild", "model");
        const client = await insertWorker(db, workspace, null, "client", "client");
        const report = await readWorkerTopology(db, workspace);
        assert.equal(report.delegatedWorkers, 2);
        assert.deepEqual(new Set(report.workers.map(({ id }) => id)), new Set([commons, root, independent, child, grandchild, client]));
    } finally { await db.close(); }
});

test("{§packet-assembly} the advisory floor instrument measures a real initial packet", { timeout: 90_000 }, async () => {
    for (const items of ["0", "-1"]) {
        const { stdout } = await promisify(execFile)(process.execPath, [
            "--conditions=plurnk-dev", "--import=./test/setup.ts", "--env-file-if-exists=.env.defaults",
            "scripts/floor-report.mjs",
        ], {
            cwd: new URL("../../", import.meta.url), timeout: 40_000,
            env: { ...process.env, PLURNK_SERVICE_FILES_ITEMS: items },
        });
        assert.doesNotMatch(stdout, /floor report unavailable/);
        assert.match(stdout, /log rows\s+: [1-9]\d* rows, [1-9]\d* tok active, [1-9]\d* metadata/);
        assert.match(stdout, /by op\s+: .*PLAN \d+.*SEND \d+/);
        if (items === "0") assert.doesNotMatch(stdout, /FIND \d+/, "disabled survey contributes no FIND weight");
        else assert.match(stdout, /FIND [1-9]\d*/, "enabled survey contributes its measured FIND weight");
        assert.match(stdout, /FLOOR \(approx\): ~[1-9]\d* tok/);
    }
});
