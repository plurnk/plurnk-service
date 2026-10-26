import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";
import { readSessionTopology } from "../SessionTopology.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";

test("{§methods-session-list} topology reporting counts children and grandchildren, not independent roots", async () => {
    const db = await openMigrated();
    try {
        const workspace = await insertWorkspace(db, "topology-report");
        const root = await insertSession(db, workspace, null, "root", "model");
        const independent = await insertSession(db, workspace, null, "independent", "model");
        const child = await insertSession(db, workspace, root, "child", "model");
        const grandchild = await insertSession(db, workspace, child, "grandchild", "model");
        const runtime = await RuntimeSession.ensure(db, workspace);
        const report = await readSessionTopology(db, workspace);
        assert.equal(report.delegatedSessions, 2);
        assert.deepEqual(new Set(report.sessions.map(({ id }) => id)), new Set([root, independent, child, grandchild, runtime]));
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
        if (items === "0") assert.doesNotMatch(stdout, /FIND \d+/, "disabled survey contributes no FIND weight");
        else assert.match(stdout, /FIND [1-9]\d*/, "enabled survey contributes its measured FIND weight");
        assert.match(stdout, /FLOOR \(approx\): ~[1-9]\d* tok/);
    }
});
