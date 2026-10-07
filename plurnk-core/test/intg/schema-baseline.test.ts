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
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Validator, type KillStatement, type ReadStatement } from "@plurnk/plurnk-contracts";
import sha256 from "../../src/core/sha256.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { MIGRATIONS_DIR, openMigrated } from "./_db.ts";

// {§db-migrations} — the released schema versions and the fingerprints of their shapes: every
// release freezes what it shipped, the previous release is the path an existing database takes, and
// an earlier release keeps its longer path through the versions after it.
type Release = { readonly version: number; readonly release: string; readonly shape: string };
const RELEASED: Release = Object.freeze({ version: 15, release: "1.27.0", shape: "500dd916fd0de1704f42d1e2e60dce895fd14714224edb3eb8841e30ea318a07" });
const PREVIOUS: Release = Object.freeze({ version: 12, release: "1.24.0", shape: "6e655448cb0f1cd2fbbfdd0c7a9ffab22786160483a2fee4333686a262564156" });
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

test("{§db-migrations} {§target-group}: stored groups normalize without rewriting original evidence or historic selection meaning", async () => {
    const path = await released(RELEASED);
    const operation = (heading: string): ReadStatement | KillStatement => {
        const item = PlurnkParser.parseStatements(PlurnkParser.frame(heading, null)).items.find((item) => item.kind === "statement");
        assert.ok(item?.kind === "statement" && (item.statement.op === "READ" || item.statement.op === "KILL"));
        return item.statement;
    };
    const first = operation("READ (a) <1,3> /shared/");
    const second = operation("READ (b) <4,6>");
    const member = ({ target, lineMarker, metadata, matcher }: ReadStatement | KillStatement) => ({ target, lineMarker, metadata, matcher });
    const shared = { ...first, group: [member({ ...first, matcher: null }), member(second)] };
    const own = { ...first, matcher: { dialect: "regex", raw: "/own/", pattern: "own", flags: "" }, group: [member(first), member(second)] };
    const kill = operation("KILL (log:///1/1/1/READ)");
    const killNext = operation("KILL (log:///1/1/2/READ)");
    const groupedKill = { ...kill, lineMarker: { marks: [1, 3] }, body: "retained distillation", group: [member(kill), member(killNext)] };
    const originalOps = [second, shared, own, groupedKill, second];
    const content = '```READ (a) (b)\n```\n\noriginal \\"source\\"';
    const reasoning = "original reasoning\r\nincluding whitespace  ";
    const packet = { weight: 123, attributions: [], assistant: { content, reasoning, ops: originalOps }, assistantRaw: { content, reasoning, opaque: [1, null] } };
    const unchanged = JSON.stringify({ weight: 0, attributions: [], assistant: { content: "", reasoning: null, ops: [second] }, assistantRaw: null });
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'astUpgrade');
            INSERT INTO workers (id, workspace_id, name) VALUES (1, 1, 'witness');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns)
                VALUES (1, 1, 1, 'retain evidence', '{"proposals":"reject"}', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status, completed_at)
                VALUES (1, 1, 1, 'model', 'inference', 102, NULL), (2, 1, 2, 'model', 'inference', 102, NULL);
        `);
        before.prepare("UPDATE turns SET packet = ? WHERE id = 1").run(JSON.stringify(packet));
        before.prepare("UPDATE turns SET packet = ? WHERE id = 2").run(unchanged);
        before.prepare("INSERT INTO turn_sources (turn_id, kind, content) VALUES (1, 'ops', ?), (1, 'reasoning', ?)").run(content, reasoning);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    try {
        const migrated = JSON.parse(after.prepare("SELECT packet FROM turns WHERE id = 1").get()!.packet as string);
        assert.deepEqual(migrated.assistant.ops, [
            second, first, { ...second, aside: first.aside, position: first.position, matcher: first.matcher },
            { ...first, matcher: first.matcher }, { ...second, aside: first.aside, position: first.position },
            { ...kill, body: groupedKill.body }, { ...killNext, position: kill.position }, second,
        ], "the old members, not their duplicated top-level fields, defined the actual selections");
        for (const op of migrated.assistant.ops) assert.equal(Validator.validatePlurnkStatement(op).valid, true);
        assert.deepEqual({ ...migrated, assistant: { ...migrated.assistant, ops: originalOps } }, packet);
        assert.equal(after.prepare("SELECT packet FROM turns WHERE id = 2").get()!.packet, unchanged, "a packet without groups is untouched byte-for-byte");
        assert.deepEqual(after.prepare("SELECT kind, content FROM turn_sources ORDER BY kind").all().map((row) => ({ ...row })),
            [{ kind: "ops", content }, { kind: "reasoning", content: reasoning }]);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

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

test("{§db-migrations} {§provider-request-evidence}: upgrading keeps earlier requests and does not fabricate captures", async () => {
    const path = await released(PREVIOUS);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'requestUpgrade');
            INSERT INTO workers (id, workspace_id, name) VALUES (1, 1, 'witness');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns)
                VALUES (1, 1, 1, 'retain requests', '{"proposals":"reject"}', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status, completed_at)
                VALUES (1, 1, 1, 'model', 'inference', 102, NULL);
            INSERT INTO inference_calls (id, workspace_id, turn_id, sequence, kind, request_model)
                VALUES (1, 1, 1, 1, 'emission', 'fixture');
            INSERT INTO provider_requests (id, inference_call_id, sequence, provider, model)
                VALUES (1, 1, 1, 'provider:fixture', 'fixture');
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual({ ...after.prepare("SELECT id, state, evidence FROM provider_requests").get() },
            { id: 1, state: "pending", evidence: null });
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§graph-relations}: upgrading preserves source content and invalidates imprecise derived coordinates", async () => {
    const path = await released(PREVIOUS);
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'graphUpgrade');
            INSERT INTO entries (id, workspace_id, scheme, pathname) VALUES (1, 1, 'worker', '/example.js');
            INSERT INTO derivations (id, deep_hash, state, disposition) VALUES (1, 'old-graph', 'complete', 'indexed');
            INSERT INTO symbol_defs (derivation_id, name, kind, line, end_line) VALUES (1, 'foo', 'function', 1, 1);
            INSERT INTO symbol_refs (derivation_id, name, kind, line) VALUES (1, 'bar', 'call', 1);
            INSERT INTO entry_channels (entry_id, name, content, mimetype, deep_hash)
                VALUES (1, 'body', 'function foo() { bar(); }', 'text/javascript', 'old-graph');
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual({ ...after.prepare("SELECT content, deep_hash FROM entry_channels WHERE entry_id = 1").get() },
            { content: "function foo() { bar(); }", deep_hash: null });
        assert.equal(after.prepare("SELECT COUNT(*) AS n FROM derivations").get()?.n, 0);
        for (const table of ["symbol_defs", "symbol_refs"]) {
            assert.ok(columns(after, table).includes("column") && columns(after, table).includes("end_column"));
        }
        assert.ok(columns(after, "symbol_refs").includes("end_line"));
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§db-migrations} {§child-orientation}: upgrading retains streams without inventing their missing output timestamps", async () => {
    const path = await released(PREVIOUS);
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'streamUpgrade');
            INSERT INTO workers (id, workspace_id, name) VALUES (1, 1, 'observer');
            INSERT INTO entries (id, workspace_id, scheme, pathname) VALUES (1, 1, 'sh', '/1234abcd');
            INSERT INTO entry_channels (entry_id, name, content, mimetype, state)
                VALUES (1, 'stdout', 'retained', 'text/stream', 'active');
            INSERT INTO subscriptions (id, worker_id, entry_id, scheme, handle, opened_at)
                VALUES (1, 1, 1, 'sh', 'old-stream', '2026-01-01T00:00:00.000Z');
            INSERT INTO subscription_publications (subscription_id, channel, published_end)
                VALUES (1, 'stdout', 8);
        `);
    } finally { before.close(); }
    let timestamp: string;
    const db = await openMigrated(path);
    try {
        assert.deepEqual(await db.test_stream_clock.get({ id: 1 }), {
            opened_at: "2026-01-01T00:00:00.000Z", output_changed_at: null,
        }, "old stream timing is unknown, not inferred from broader entry timestamps");
        assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: 1, name: "stdout" }))?.content, "retained");
        assert.equal((await db.test_subscription_publications.all<{ published_end: number }>({ id: 1 }))[0]?.published_end, 8);
        await ChannelWrite.appendToChannel(db, { entryId: 1, producerWorkerId: 1, channel: "stdout", chunk: " output" });
        const row = await db.test_stream_clock.get<{ output_changed_at: string | null }>({ id: 1 });
        assert.ok(row?.output_changed_at);
        timestamp = row.output_changed_at;
    } finally { await db.close(); }
    const reopened = await openMigrated(path);
    try {
        assert.equal((await reopened.test_stream_clock.get<{ output_changed_at: string }>({ id: 1 }))?.output_changed_at,
            timestamp, "reopening the database preserves the output activity fact");
        assert.equal((await reopened.test_get_channel.get<{ content: string }>({ entry_id: 1, name: "stdout" }))?.content,
            "retained output");
        assert.equal((await reopened.test_get_subscription.get<{ closed_at: string | null }>({ id: 1 }))?.closed_at, null);
    } finally { await reopened.close(); }
});

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
