import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// eslint-disable-next-line no-restricted-imports -- inject a native query failure; all persistence still uses package-owned SqlRite statements.
import { StatementSync } from "node:sqlite";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import { Mock } from "@plurnk/plurnk-providers";
import Digest from "@plurnk/plurnk-service/digest";
import { insertLoop, insertPacketTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

for (const surface of ["run", "requiem"] as const) {
    for (const failed of [false, true]) {
        test(`{§digest-programmatic-surface}: ${surface} releases its reader after ${failed ? "a query failure" : "success"}`, async (t) => {
            const root = await mkdtemp(join(tmpdir(), "plurnk-digest-reader-"));
            t.after(() => rm(root, { recursive: true, force: true }));
            const dbPath = join(root, "plurnk.db");
            const db = await openMigrated(dbPath);
            await db.close();
            const closed: SqlRiteSync[] = [];
            const close = SqlRiteSync.prototype.close;
            t.mock.method(SqlRiteSync.prototype, "close", function (this: SqlRiteSync) {
                close.call(this);
                closed.push(this);
            });
            const failure = new Error("forensic query failed");
            if (failed) {
                const all = StatementSync.prototype.all;
                t.mock.method(StatementSync.prototype, "all", function (this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
                    if (this.sourceSQL.includes("SELECT * FROM workers ORDER BY id")) throw failure;
                    return all.call(this, ...args);
                });
            }
            const invoke = () => Digest[surface]({
                dbPath,
                digestDir: join(root, "output"),
                provider: new Mock({ contextWindow: 8192, responses: [] }),
            });
            if (failed) await assert.rejects(async () => invoke(), (cause) => cause === failure);
            else await invoke();
            assert.equal(closed.length, 1, "the forensic reader is explicitly closed exactly once");
            assert.throws(() => (closed[0].digest_workers as { all(): unknown[] }).all(), { code: "ERR_INVALID_STATE" });
        });
    }
}

test("{§digest-requiem}: releases the reader before waiting for the witness, including witness failure", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-reader-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reader-lifetime");
        const workerId = await insertWorker(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, workerId, 1, "inspect");
        await insertPacketTurn(db, loopId, 1, {
            weight: 1,
            sections: [{ name: "log", slot: "user", header: "Log", content: "evidence", weight: 1 }],
            attributions: [],
            assistant: { content: "completed", ops: [], reasoning: null },
            assistantRaw: null,
        }, 200);
    } finally {
        await db.close();
    }
    const close = t.mock.method(SqlRiteSync.prototype, "close");
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    const failure = new Error("witness unavailable");
    const generate = t.mock.method(provider, "generate", async () => {
        assert.equal(close.mock.callCount(), 1, "the witness must not retain a database connection");
        throw failure;
    });
    await assert.rejects(Digest.requiem({ dbPath, digestDir: join(root, "output"), provider }), (cause) => cause === failure);
    assert.equal(generate.mock.callCount(), 1);
    assert.equal(close.mock.callCount(), 1);
});
