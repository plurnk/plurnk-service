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
import sha256 from "../../src/core/sha256.ts";
import { MIGRATIONS_DIR, openMigrated } from "./_db.ts";

// {§db-migrations} — the released schema versions and the fingerprints of their shapes: every
// release freezes what it shipped, the previous release is the path an existing database takes, and
// an earlier release keeps its longer path through the versions after it.
type Release = { readonly version: number; readonly release: string; readonly shape: string };
const RELEASED: Release = Object.freeze({ version: 12, release: "1.24.0", shape: "6e655448cb0f1cd2fbbfdd0c7a9ffab22786160483a2fee4333686a262564156" });
const PREVIOUS: Release = Object.freeze({ version: 11, release: "1.23.0", shape: "e6c30907c5a19216150ed1c29b2f4ba6a8cca1ac0dd08a1a85e31cfa286aa4d3" });
const EARLIER: Release = Object.freeze({ version: 8, release: "1.21.1", shape: "2d93e9044b58ba0167e3b21e9bb9f6daade6cd20221ad153f1079551f9cf9f25" });

const released = async (release: Release): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-released-"));
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

const columns = (db: DatabaseSync, table: string): string[] =>
    (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(({ name }) => name);

test("{§db-migrations}: versions are consecutive from 1 and a fresh database lands on the last", async () => {
    const versions = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.map(({ version }) => version);
    assert.deepEqual(versions, versions.map((_, index) => index + 1), "versions are numbered consecutively from 1 with no gaps");
    assert.ok(versions.length >= RELEASED.version, "the released versions are all present");
    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, versions.length, "a fresh database applies every version");
    } finally { await db.close(); }
});

for (const release of [RELEASED, PREVIOUS, EARLIER]) {
    test(`{§db-migrations}: versions 1-${release.version} keep the ${release.release} shape`, async () => {
        assert.equal(shape(await released(release)), release.shape, `a released migration changed shape; add the next MIGRATE version instead of editing versions 1-${release.version}`);
    });
}

test(`{§db-migrations} {§emission-row}: a ${PREVIOUS.release} database migrates in place, keeping its log and inventing no announcement`, async () => {
    const path = await released(PREVIOUS);
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'exampleWorkspace');
            INSERT INTO model_routes (id, alias, provider, model) VALUES (1, 'example', 'deepseek', 'deepseek-chat');
            INSERT INTO workers (id, workspace_id, name, model_route_id, effort, effort_source)
                VALUES (1, 1, 'exampleWorkerName', 1, 'medium', 'explicit');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns) VALUES (1, 1, 1, 'example prompt', '{}', 3);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 200);
            INSERT INTO turn_sources (turn_id, kind, content) VALUES (1, 'ops', 'exampleProgram');
            INSERT INTO log_entries (id, worker_id, loop_id, turn_id, sequence, origin, op, scheme, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx)
                VALUES (1, 1, 1, 1, 1, 'model', 'READ', 'worker', '/example.md', '{}', 'application/json', '{"status":200,"content":"example"}', 'application/json', 200);
            INSERT INTO log_entry_projections (log_entry_id) VALUES (1);
        `);
    } finally { before.close(); }

    const db = await openMigrated(path);
    await db.close();

    const after = new DatabaseSync(path);
    try {
        assert.deepEqual((after.prepare("SELECT id, turn_id, sequence, op, attrs FROM log_entries").all()).map((row) => ({ ...row })),
            [{ id: 1, turn_id: 1, sequence: 1, op: "READ", attrs: "{}" }], "the released row is kept, and its turn gains no backfilled announcement");
        assert.deepEqual(
            (after.prepare("SELECT type, name FROM sqlite_master WHERE name IN ('log_entries_emission_turn', 'log_entries_emission_shape', 'log_entries_emission_frozen', 'log_entry_projections_emission_whole') ORDER BY name").all() as Array<{ type: string; name: string }>).map(({ type, name }) => `${type} ${name}`),
            ["trigger log_entries_emission_frozen", "trigger log_entries_emission_shape", "index log_entries_emission_turn", "trigger log_entry_projections_emission_whole"],
        );
    } finally { after.close(); }
});

test(`{§db-migrations}: a ${EARLIER.release} database migrates in place and keeps its rows`, async () => {
    const path = await released(EARLIER);
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'exampleWorkspace');
            INSERT INTO model_routes (id, alias, provider, model) VALUES (1, 'example', 'deepseek', 'deepseek-chat');
            INSERT INTO workers (id, workspace_id, name, model_route_id, reasoning_policy, reasoning_source)
                VALUES (1, 1, 'exampleWorkerName', 1, 'medium', 'explicit');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns) VALUES (1, 1, 1, 'example prompt', '{}', 3);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 200);
            INSERT INTO turn_sources (turn_id, kind, content) VALUES (1, 'ops', 'exampleProgram');
            INSERT INTO entries (id, workspace_id, scheme, authority, pathname) VALUES (1, 1, 'worker', '', '/settled');
            INSERT INTO entry_channels (entry_id, name, content, mimetype, state) VALUES (1, 'body', 'a' || char(13) || 'b' || char(13), 'text/plain', 'active');
            INSERT INTO subscriptions (id, worker_id, entry_id, scheme, handle) VALUES (1, 1, 1, 'sse', '/settled');
            -- The fork trigger names turn_sources and persists between opens; the rebuild must survive it.
            CREATE TRIGGER workers_fork_copies_history AFTER INSERT ON workers
            BEGIN INSERT INTO turn_sources (turn_id, kind, content) SELECT turn_id, kind, content FROM turn_sources WHERE 0; END;
        `);
    } finally { before.close(); }

    const db = await openMigrated(path);
    await db.close();

    const after = new DatabaseSync(path);
    after.function("sha256", { deterministic: true }, (text) => sha256(text as string));
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
        // {§validation-topology}: the redeclared subscription guard keeps its row, accepts a settled
        // result and refuses one the settled-result invariant excludes; the redeclared channel write
        // path keeps its row and counts a lone CR ({§logical-line-count}).
        assert.deepEqual({ ...after.prepare("SELECT id, worker_id, entry_id, closed_at FROM subscriptions").get() },
            { id: 1, worker_id: 1, entry_id: 1, closed_at: null });
        assert.deepEqual({ ...after.prepare("SELECT name, content, lines FROM entry_channels WHERE entry_id = 1").get() },
            { name: "body", content: "a\rb\r", lines: 1 }, "the stored count is rewritten at the next write, not by the migration");
        const settle = (id: number, status: number, result: string): void => {
            after.prepare("UPDATE subscriptions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), close_status = ?, close_result = ?, channel_results = '{}' WHERE id = ?").run(status, result, id);
        };
        const problem = '{"type":"https://problems.plurnk.xyz/test/settled","title":"Settled","status":404,"detail":"The witness problem."}';
        assert.throws(() => settle(1, 202, '{"status":202}'), /violates the operation-result contract/, "202 is refused after the redeclaration");
        assert.throws(() => settle(1, 404, `{"status":404,"problem":${problem.replace(',"detail":"The witness problem."', "")}}`), /violates the operation-result contract/, "a Problem without detail is refused after the redeclaration");
        settle(1, 404, `{"status":404,"problem":${problem}}`);
        assert.equal(after.prepare("SELECT close_status FROM subscriptions WHERE id = 1").get()?.close_status, 404);
        after.exec("UPDATE entry_channels SET content = 'a' || char(13) || 'b' || char(10) || 'c' WHERE entry_id = 1 AND name = 'body'");
        assert.equal(after.prepare("SELECT lines FROM entry_channels WHERE entry_id = 1 AND name = 'body'").get()?.lines, 3, "the recreated update trigger counts a lone CR");
        after.exec("INSERT INTO entry_channels (entry_id, name, content, mimetype, state) VALUES (1, 'fresh', 'a' || char(13) || 'b' || char(13), 'text/plain', 'active')");
        assert.equal(after.prepare("SELECT lines FROM entry_channels WHERE entry_id = 1 AND name = 'fresh'").get()?.lines, 2, "the recreated insert trigger counts a lone CR");
        assert.deepEqual(
            (after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('subscriptions_result_contract_update', 'entry_channels_insert', 'entry_channels_update') ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name),
            ["entry_channels_insert", "entry_channels_update", "subscriptions_result_contract_update"],
        );
    } finally { after.close(); }
});
