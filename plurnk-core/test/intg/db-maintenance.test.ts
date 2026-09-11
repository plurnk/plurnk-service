// {§db-maintenance-optimize} — the daemon leaves planner statistics behind when it stops.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- {§db-maintenance-optimize}: the witness reads sqlite_master after the daemon has closed; no persistence happens outside SqlRite.
import { DatabaseSync } from "node:sqlite";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { provider, statement } from "./reasoning-fixture.ts";

const stat1 = (path: string): number => {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
        const table = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get();
        return table === undefined ? 0 : (raw.prepare("SELECT count(*) AS n FROM sqlite_stat1").get() as { n: number }).n;
    } finally { raw.close(); }
};

test("{§db-maintenance-optimize}: stopping the daemon runs PRAGMA optimize on the writer, so the next open plans from statistics", async () => {
    const path = join(tmpdir(), `maintenance-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    const daemon = new Daemon({ db, provider: null, mimetypes: DEFAULT_MIMETYPES });
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, "maintenance");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        await daemon.engine.runTurn({ workspaceId, workerId, loopId, provider: provider("thought",
            `${PlurnkParser.frame("READ (reasoning:///1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`), messages: [] });
        assert.equal((await daemon.engine.look({ workspaceId, workerId, loopId, statement: statement("```READ (reasoning:///1/2) <1,-1>```") })).status, 200);
        assert.equal(stat1(path), 0, "a fresh baseline carries no statistics");
    } finally {
        await daemon.stop();
        await db.close();
    }
    assert.ok(stat1(path) > 0, "shutdown analyzed the tables the writer planned against");
});
