import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Share from "../../src/share/Share.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§share} {§share-scope}: a scoped share holds one workspace, beside its zip, from a copy of the database", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const kept = await insertWorkspace(db, "kept");
    const other = await insertWorkspace(db, "other");
    await insertLoop(db, await insertWorker(db, kept, null, "alice"), 1, "kept task");
    await insertLoop(db, await insertWorker(db, other, null, "bob"), 1, "other task");
    await db.close();
    const before = statSync(dbPath).mtimeMs;

    const folder = join(root, "shares", "share_this_session_here");
    const shared = await Share.write({ dbPath, folder, workspaceId: kept });

    assert.deepEqual(shared, { folder, zip: `${folder}.zip` });
    assert.ok(existsSync(join(folder, "digest.md")));
    assert.ok(readFileSync(`${folder}.zip`).subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), "the zip is a ZIP archive");
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name }) => name), ["kept"]);
    assert.equal(statSync(dbPath).mtimeMs, before, "the database itself is only read");
});

test("{§share}: a folder that overlaps the database is refused before anything is written", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-overlap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    await (await openMigrated(dbPath)).close();
    await assert.rejects(Share.write({ dbPath, folder: root }), { message: `digest: output directory ${root} overlaps input database ${dbPath}` });
    assert.ok(existsSync(dbPath));
    assert.ok(!existsSync(`${root}.zip`));
});
