import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- this witness writes a released-shape database and reads sqlite_master.
import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { MIGRATIONS_DIR, openMigrated } from "./_db.ts";

// {§db-migrations} — every released schema version from the 4.0.0 support floor forward and the
// fingerprint of its shape: each release freezes what it shipped, and a database from any of them
// keeps its path through the versions after it. A database from before the 4.0.0 floor upgrades
// through @plurnk/plurnk-service@4.3.3 first.
type Release = { readonly version: number; readonly release: string; readonly shape: string };
const V4_3_3: Release = Object.freeze({ version: 10, release: "4.3.3", shape: "eb983f7a985b3ba40bec17b3b16a8acd2bf1ea0300bbbceb446762c1bec78bd0" });
const V4_3_0: Release = Object.freeze({ version: 9, release: "4.3.0", shape: "eb983f7a985b3ba40bec17b3b16a8acd2bf1ea0300bbbceb446762c1bec78bd0" });
const V4_0_0: Release = Object.freeze({ version: 8, release: "4.0.0", shape: "eace3ea2371f551d2b69cbb830a575abf0793f0bd62d3d27bbad1cdd08368e7e" });

// A database at a released version, in a temporary root the test removes when it ends.
const released = async (t: Pick<TestContext, "after">, release: Pick<Release, "version">): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-released-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "migrations");
    await mkdir(dir);
    const chapters = (await readdir(MIGRATIONS_DIR)).filter((name) => Number(name.split("_")[0]) <= release.version);
    await Promise.all(chapters.map((name) => copyFile(join(MIGRATIONS_DIR, name), join(dir, name))));
    const path = join(root, "released.db");
    new SqlRiteSync({ path, dir }).close();
    return path;
};

const shape = (path: string): string => {
    const db = new DatabaseSync(path);
    try {
        const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string }>;
        const text = rows.map(({ type, name, sql }) => `${type} ${name} ${sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ")}`).join("\n");
        return createHash("sha256").update(text).digest("hex");
    } finally { db.close(); }
};

test(`{§db-migrations} {§place-hiding}: a ${V4_0_0.release} database keeps every row, each workspace and session shown`, async (t) => {
    const path = await released(t, V4_0_0);
    const before = new DatabaseSync(path);
    before.exec(`
        PRAGMA foreign_keys = ON;
        INSERT INTO workspaces (id, name) VALUES (1, 'retained');
        INSERT INTO session_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
        INSERT INTO sessions (id, workspace_id, name, origin) VALUES (1, 1, 'root', 'model');
        INSERT INTO sessions (id, workspace_id, name, parent_session_id, origin) VALUES (2, 1, 'child', 1, 'model');
    `);
    const workspace = { ...before.prepare("SELECT * FROM workspaces WHERE id = 1").get() };
    const sessions = before.prepare("SELECT * FROM sessions ORDER BY id").all().map((row) => ({ ...row }));
    before.close();
    const upgraded = await openMigrated(path);
    await upgraded.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual({ ...after.prepare("SELECT * FROM workspaces WHERE id = 1").get() }, { ...workspace, hidden_at: null });
        assert.deepEqual(after.prepare("SELECT * FROM sessions ORDER BY id").all().map((row) => ({ ...row })),
            sessions.map((row) => ({ ...row, hidden_at: null, hidden_by: null })));
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test(`{§db-migrations} {§session-ownership}: a ${V4_3_0.release} database collapses historical operator owners onto the workspace ACP operator owner`, async (t) => {
    const path = await released(t, V4_3_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'operatorOwners');
            INSERT INTO session_owners (workspace_id, address, tools, interactive) VALUES
                (1, '_plurnk', '[]', 0),
                (1, 'acp://anonymous/threads/1%23user', '["request_approval","question"]', 1),
                (1, 'acp://operator/threads/1%23child', '["request_approval"]', 0),
                (1, 'acp://operator', '["request_approval"]', 0);
            INSERT INTO sessions (id, workspace_id, name, origin, owner) VALUES
                (1, 1, 'user', 'model', 'acp://anonymous/threads/1%23user'),
                (2, 1, 'child', 'model', 'acp://operator/threads/1%23child'),
                (3, 1, 'peer', 'model', 'acp://operator');
            INSERT INTO loops (id, session_id, sequence, prompt, max_turns) VALUES (1, 2, 1, 'Ask', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 102);
            INSERT INTO client_interactions (id, session_id, loop_id, turn_id, recipient, request)
                VALUES (1, 2, 1, 1, 'acp://operator/threads/1%23child', '{"tool":"question"}');
        `);
    } finally { before.close(); }
    const upgraded = await openMigrated(path);
    await upgraded.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual(after.prepare("SELECT address, tools, interactive FROM session_owners WHERE workspace_id = 1 ORDER BY address").all().map((row) => ({ ...row })), [
            { address: "_plurnk", tools: "[]", interactive: 0 },
            { address: "acp://operator", tools: '["request_approval","question"]', interactive: 1 },
        ]);
        assert.deepEqual(after.prepare("SELECT id, owner FROM sessions ORDER BY id").all().map((row) => ({ ...row })), [
            { id: 1, owner: "acp://operator" },
            { id: 2, owner: "acp://operator" },
            { id: 3, owner: "acp://operator" },
        ]);
        assert.equal(after.prepare("SELECT recipient FROM client_interactions WHERE id = 1").get()!.recipient, "acp://operator");
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§db-migrations}: a database from before the 4.0.0 support floor is refused naming the stepping-stone release", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pre-floor-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const version of [8, 28]) {
        const dir = join(root, `v${version}`);
        await mkdir(dir);
        await writeFile(join(dir, `0${version}_legacy.sql`), `-- MIGRATE: ${version} legacy\nCREATE TABLE workspaces (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL);\n`);
        const dbPath = join(root, `legacy-${version}.db`);
        new SqlRiteSync({ path: dbPath, dir }).close();
        await assert.rejects(
            () => openMigrated(dbPath),
            /precedes the 4\.0\.0 support floor; upgrade through @plurnk\/plurnk-service@4\.3\.3 first/,
        );
    }
});

test("{§db-migrations}: versions are consecutive from 1 and a fresh database lands on the last", async () => {
    const versions = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.map(({ version }) => version);
    assert.deepEqual(versions, versions.map((_, index) => index + 1), "versions are numbered consecutively from 1 with no gaps");
    assert.ok(versions.length >= V4_0_0.version, "the released versions are all present");
    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, versions.length, "a fresh database applies every version");
    } finally { await db.close(); }
});

for (const release of [V4_3_3, V4_3_0, V4_0_0]) {
    test(`{§db-migrations}: versions 1-${release.version} keep the ${release.release} shape`, async (t) => {
        assert.equal(shape(await released(t, release)), release.shape, `a released migration changed shape; add the next MIGRATE version instead of editing versions 1-${release.version}`);
    });
}
