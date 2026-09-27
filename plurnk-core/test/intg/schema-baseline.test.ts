import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- this witness writes a released-shape database and reads sqlite_master.
import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { MIGRATIONS_DIR, openMigrated } from "./_helpers.ts";

// {§db-migrations} — the last released schema version and the fingerprint of its shape.
const RELEASED = Object.freeze({ version: 8, release: "1.21.1", shape: "2d93e9044b58ba0167e3b21e9bb9f6daade6cd20221ad153f1079551f9cf9f25" });

const released = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-released-"));
    const dir = join(root, "migrations");
    await mkdir(dir);
    const chapters = (await readdir(MIGRATIONS_DIR)).filter((name) => Number(name.split("_")[0]) <= RELEASED.version);
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

const columns = (db: DatabaseSync, table: string): string[] =>
    (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(({ name }) => name);

test("{§db-migrations}: versions are consecutive from 1 and a fresh database lands on the last", async () => {
    const versions = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.map(({ version }) => version);
    assert.deepEqual(versions, versions.map((_, index) => index + 1), "versions are numbered consecutively from 1 with no gaps");
    assert.ok(versions.length > RELEASED.version, "evolution continues past the released baseline");
    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, versions.length, "a fresh database applies every version");
    } finally { await db.close(); }
});

test(`{§db-migrations}: the released versions keep the ${RELEASED.release} shape`, async () => {
    assert.equal(shape(await released()), RELEASED.shape, `a released migration changed shape; add the next MIGRATE version instead of editing versions 1-${RELEASED.version}`);
});

test(`{§db-migrations}: a ${RELEASED.release} database migrates in place and keeps its rows`, async () => {
    const path = await released();
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'exampleWorkspace');
            INSERT INTO model_routes (id, alias, provider, model) VALUES (1, 'example', 'deepseek', 'deepseek-chat');
            INSERT INTO workers (id, workspace_id, name, model_route_id, reasoning_policy, reasoning_source)
                VALUES (1, 1, 'exampleWorkerName', 1, 'medium', 'explicit');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns) VALUES (1, 1, 1, 'example prompt', '{}', 3);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 200);
            INSERT INTO turn_sources (turn_id, kind, content) VALUES (1, 'ops', 'exampleProgram');
            -- The fork trigger names turn_sources and persists between opens; the rebuild must survive it.
            CREATE TRIGGER workers_fork_copies_history AFTER INSERT ON workers
            BEGIN INSERT INTO turn_sources (turn_id, kind, content) SELECT turn_id, kind, content FROM turn_sources WHERE 0; END;
        `);
    } finally { before.close(); }

    const db = await openMigrated(path);
    await db.close();

    const after = new DatabaseSync(path);
    try {
        assert.ok(columns(after, "workers").includes("effort") && columns(after, "workers").includes("effort_source"));
        assert.ok(columns(after, "loops").includes("effort"));
        assert.ok(![...columns(after, "workers"), ...columns(after, "loops")].some((name) => name.startsWith("reasoning_")), "no retired column survives");
        assert.deepEqual({ ...after.prepare("SELECT name, effort, effort_source FROM workers WHERE id = 1").get() },
            { name: "exampleWorkerName", effort: "medium", effort_source: "explicit" });
        assert.throws(() => after.exec("UPDATE workers SET effort = NULL WHERE id = 1"), /CHECK constraint failed/, "the generation-policy CHECK follows the rename");
        // {§outside-text}: the rebuilt turn_sources keeps its rows, admits the outside kind and still refuses an unknown one.
        assert.deepEqual({ ...after.prepare("SELECT turn_id, kind, sequence, content FROM turn_sources").get() },
            { turn_id: 1, kind: "ops", sequence: 0, content: "exampleProgram" });
        after.exec("INSERT INTO turn_sources (turn_id, kind, content) VALUES (1, 'outside', 'stray text')");
        assert.throws(() => after.exec("INSERT INTO turn_sources (turn_id, kind, content) VALUES (1, 'aside', 'x')"), /CHECK constraint failed/, "an unknown source kind is refused after the rebuild");
        assert.throws(() => after.exec("UPDATE turn_sources SET content = 'rewritten' WHERE kind = 'outside'"), /turn source evidence is immutable/, "the immutability trigger is recreated");
        assert.throws(() => after.exec("DELETE FROM turn_sources WHERE kind = 'outside'"), /belongs to its retained turn/, "the retention trigger is recreated");
        assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'turn_sources_deep_hash'").get()?.name, "turn_sources_deep_hash");
    } finally { after.close(); }
});
