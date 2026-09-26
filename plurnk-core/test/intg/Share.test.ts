import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Digest from "../../src/digest/Digest.ts";
import Share from "../../src/share/Share.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§share} {§share-scope}: a scoped share holds one workspace, from a copy of the database", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const kept = await insertWorkspace(db, "kept");
    const other = await insertWorkspace(db, "other");
    await insertLoop(db, await insertWorker(db, kept, null, "alice"), 1, "kept task");
    await insertLoop(db, await insertWorker(db, other, null, "bob"), 1, "other task");
    await db.close();
    const before = readFileSync(dbPath);

    const folder = join(root, "shares", "share_this_session_here");
    const shared = await Share.write({ dbPath, folder, workspaceId: kept });

    assert.deepEqual(shared, { folder });
    assert.ok(existsSync(join(folder, "digest.md")));
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name }) => name), ["kept"]);
    assert.ok(readFileSync(dbPath).equals(before), "the database itself is only read");
});

test("{§share}: a folder that already holds files, the database's own included, is refused and never cleared", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-overlap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    await (await openMigrated(dbPath)).close();
    await assert.rejects(Share.write({ dbPath, folder: root }), { message: `digest: ${root} already exists and is not an empty folder; remove it first` });
    assert.ok(existsSync(dbPath));
});

test("{§share-snapshot}: a snapshot of an open WAL database keeps the commits a byte copy drops; an existing copy is refused", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-share-snapshot-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    t.after(() => db.close());
    await insertWorkspace(db, "committed-in-wal");
    const workspacesOf = (copy: string, digestDir: string): string[] => {
        Digest.run({ dbPath: copy, digestDir });
        return (JSON.parse(readFileSync(join(digestDir, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> }).workspaces.map(({ name }) => name);
    };

    const bytes = join(root, "bytes.db");
    copyFileSync(dbPath, bytes);
    assert.throws(() => workspacesOf(bytes, join(root, "bytes")), { message: "no such table: workspaces" }, "the schema and the commit are still in the -wal file");
    const copy = join(root, "snapshot.db");
    Share.snapshot(dbPath, copy);
    assert.deepEqual(workspacesOf(copy, join(root, "snapshot")), ["committed-in-wal"]);
    assert.throws(() => Share.snapshot(dbPath, copy), { message: `share: ${copy} already exists; remove it first` });
});
