import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { connect, rpcCall } from "./_rpc.ts";

// {§share} — the client names an absolute folder; the daemon shares its own database, scoped to the workspace.
test("{§share}: workspace.share writes the workspace's share and its zip from the daemon's own database", { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-workspace-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const daemon = new Daemon({ db, dbPath, provider: new Mock({ contextWindow: 8192, responses: [] }) });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ws = await connect({ daemon });
    t.after(() => ws.close());
    await rpcCall(ws, 1, "workspace.create", { name: "not-shared" });
    await rpcCall(ws, 2, "workspace.create", { name: "shared-here" }); // creation attaches the connection
    const folder = join(root, "share_this_session_here");
    const shared = (await rpcCall(ws, 4, "workspace.share", { folder })).result as { folder: string; zip: string };
    assert.deepEqual(shared, { folder, zip: `${folder}.zip` });
    assert.ok(existsSync(join(folder, "digest.md")));
    assert.ok(existsSync(`${folder}.zip`));
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name }) => name), ["shared-here"], "the share is the attached workspace alone");
    const refused = await rpcCall(ws, 5, "workspace.share", { folder: "relative/folder" });
    const problem = (refused.result as { status: number; problem: { detail: string } });
    assert.equal(problem.status, 400);
    assert.equal(problem.problem.detail, "workspace.share requires an absolute folder.");
});
