import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- this witness writes a released-shape database and reads sqlite_master.
import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Validator, type FunctionalityListResult, type KillStatement, type ReadStatement } from "@plurnk/plurnk-contracts";
import sha256 from "../../src/core/sha256.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import Daemon from "../../src/server/Daemon.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import File from "../../src/schemes/File.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { editStmt, localPath, fullReplace } from "./_dsl.ts";
import { insertPacketTurn, MIGRATIONS_DIR, openMigrated } from "./_db.ts";

// {§db-migrations} — every released schema version and the fingerprint of its shape: each release
// freezes what it shipped, and a database from any of them keeps its path through the versions after it.
// A release that ships migrations adds its entry here; each witness names the release whose shape it seeds.
type Release = { readonly version: number; readonly release: string; readonly shape: string };
const V4_3_0: Release = Object.freeze({ version: 33, release: "4.3.0", shape: "7c47c39a0e10cc7a6adaaba0bf9a935621ddcf4c14e765c36db248e4b5576d50" });
const V4_0_0: Release = Object.freeze({ version: 32, release: "4.0.0", shape: "76b1dff2af95661a15e32ebea23fddaf4b07cfdc0c06af58e6ca2640e2034263" });
const V3_3_0: Release = Object.freeze({ version: 28, release: "3.3.0", shape: "ab5150bffb53644ae550add320ab2e01e7f2c842a0dc52eeb728b3b09203dd61" });
const V3_2_0: Release = Object.freeze({ version: 25, release: "3.2.0", shape: "ed18a3847357b59abf1f8df95968d98942c660efbb297d6364793379d9b5a1de" });
const V3_1_0: Release = Object.freeze({ version: 22, release: "3.1.0", shape: "2520e04fc1cbafa9c5848ac44120851e600644a59fd381f208633652a7b4cb07" });
const V3_0_0: Release = Object.freeze({ version: 20, release: "3.0.0", shape: "39f52f9fe61e6e61c3f0766d3bcef6d0edec1692058124d1a33ff91e8e0d39b0" });
const V2_0_0: Release = Object.freeze({ version: 17, release: "2.0.0", shape: "500dd916fd0de1704f42d1e2e60dce895fd14714224edb3eb8841e30ea318a07" });
const V1_27_0: Release = Object.freeze({ version: 15, release: "1.27.0", shape: "500dd916fd0de1704f42d1e2e60dce895fd14714224edb3eb8841e30ea318a07" });
const V1_24_0: Release = Object.freeze({ version: 12, release: "1.24.0", shape: "6e655448cb0f1cd2fbbfdd0c7a9ffab22786160483a2fee4333686a262564156" });
const V1_21_1: Release = Object.freeze({ version: 8, release: "1.21.1", shape: "2d93e9044b58ba0167e3b21e9bb9f6daade6cd20221ad153f1079551f9cf9f25" });

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

const columns = (db: DatabaseSync, table: string): string[] =>
    (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(({ name }) => name);

test("{§db-migrations} {§file-snapshot-revision}: upgrade retains projections but requires a verified source before file mutation", async (t) => {
    const path = await released(t, V3_1_0);
    const root = join(path, "..");
    await writeFile(join(root, "doc.md"), "original\n");
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.prepare("INSERT INTO workspaces (id, name, project_root) VALUES (1, 'fileUpgrade', ?)").run(root);
        before.exec(`
            INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'writer', 'model');
            INSERT INTO entries (id, workspace_id, scheme, authority, pathname, synced_sig, membership_origin)
                VALUES (1, 1, 'file', '', 'doc.md', '1700000000000:9', 'constraint');
            INSERT INTO entry_channels (entry_id, name, content, mimetype)
                VALUES (1, 'body', 'original' || char(10), 'text/markdown');
        `);
    } finally { before.close(); }
    const file = new File();
    let landedRevision: string | undefined;
    const db = await openMigrated(path);
    try {
        const ctx = makeSchemeCtx({ db, workspaceId: 1, workerId: 1, mimetypes: DEFAULT_MIMETYPES });
        const retained = await file.readEntry("doc.md", ctx);
        assert.equal(retained.entry?.channels.body?.content, "original\n");
        assert.equal(retained.fileRevision, undefined);
        const statement = editStmt(localPath("doc.md"), "verified replacement\n", fullReplace);
        const refused = await file.edit(statement, ctx);
        assert.equal(refused.status, 409);
        assert.match(refused.problem?.type ?? "", /edit-collision$/);
        assert.equal(await readFile(join(root, "doc.md"), "utf8"), "original\n");
        await MembershipMaterialization.materializeMember("doc.md", root, ctx, new Map());
        const proposal = await file.edit(statement, ctx);
        assert.equal(proposal.status, 202);
        assert.equal((await file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, ctx)).status, 200);
        landedRevision = (await file.readEntry("doc.md", ctx)).fileRevision;
        assert.ok(landedRevision);
    } finally { await db.close(); }
    const reopened = await openMigrated(path);
    try {
        const ctx = makeSchemeCtx({ db: reopened, workspaceId: 1, workerId: 1, mimetypes: DEFAULT_MIMETYPES });
        const retained = await file.readEntry("doc.md", ctx);
        assert.equal(retained.entry?.channels.body?.content, "verified replacement\n");
        assert.equal(retained.fileRevision, landedRevision);
        assert.equal(await readFile(join(root, "doc.md"), "utf8"), "verified replacement\n");
        assert.equal(await MembershipMaterialization.materializeMember("doc.md", root, ctx, new Map()), null);
    } finally { await reopened.close(); }
});

test("{§db-migrations} {§message-completion}: upgrades preserve resolved messages and literal replies independently of curation", async (t) => {
    const path = await released(t, V2_0_0);
    const before = new DatabaseSync(path);
    let evidence: unknown[];
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'replyUpgrade');
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'requester', 'model'), (2, 1, 'responder', 'model');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns)
                VALUES (1, 1, 1, 'Retain replies', '{"proposals":"reject"}', -1),
                       (2, 2, 1, 'Reply to a peer', '{"proposals":"reject"}', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status)
                VALUES (1, 1, 1, 'model', 'inference', 200), (2, 2, 1, 'model', 'inference', 200);
            INSERT INTO loop_messages (id, loop_id, ordinal, message_key, body)
                VALUES (1, 1, 1, 'first', 'First request'), (2, 1, 2, 'second', 'Second request'),
                       (3, 1, 3, 'open', 'Still open');
        `);
        const reply = before.prepare(`INSERT INTO log_entries
            (id, worker_id, loop_id, turn_id, sequence, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx)
            VALUES (?, ?, ?, ?, ?, 'model', ?, ?, 'application/json', ?, 'application/json', ?)`);
        reply.run(1, 1, 1, 1, 1, "SEND", '{"body":{"raw":"First answer"}}', '{"answers":["message://requester/first"]}', 200);
        reply.run(2, 2, 2, 2, 1, "KILL", '{"body":"Historic final answer"}', '{"answers":["message://requester/second"]}', 200);
        reply.run(3, 1, 1, 1, 2, "SEND", '{"body":{"raw":"Not delivered"}}', '{"answers":["message://requester/open"]}', 400);
        before.exec("INSERT INTO log_entry_projections (log_entry_id, active) VALUES (1, 0), (2, 1), (3, 1)");
        evidence = before.prepare("SELECT * FROM log_entries ORDER BY id").all();
        assert.deepEqual(before.prepare("SELECT id FROM unanswered_messages").all().map(({ id }) => id), [3]);
    } finally { before.close(); }
    const migrated = await openMigrated(path);
    await migrated.close();
    const reopened = await openMigrated(path);
    await reopened.close();
    const after = new DatabaseSync(path);
    try {
        after.exec("PRAGMA foreign_keys = ON");
        // {§log-mutation-patch} — the upgrade adds the patch column; a released row holds nothing in it.
        assert.deepEqual(after.prepare("SELECT * FROM log_entries ORDER BY id").all().map((row) => ({ ...row })), evidence!.map((row) => ({ ...(row as object), patch: null })));
        assert.deepEqual(after.prepare("SELECT * FROM message_completions ORDER BY message_id").all().map((row) => ({ ...row })), [
            { message_id: 1, response_id: 1, status: 200 }, { message_id: 2, response_id: 2, status: 200 },
        ]);
        assert.deepEqual(after.prepare("SELECT id FROM unanswered_messages").all().map(({ id }) => id), [3]);
        assert.equal(after.prepare("SELECT active FROM log_entry_projections WHERE log_entry_id = 1").get()!.active, 0);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
        after.exec("DELETE FROM workspaces WHERE id = 1");
        assert.equal(after.prepare("SELECT count(*) AS n FROM message_completions").get()!.n, 0);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§db-migrations} {§packet-wire-envelope}: role evolution retains historical envelopes and every section item", async (t) => {
    const path = await released(t, V2_0_0);
    const previous = "```EDIT (a.md)\nOriginal complete body.\n```";
    const sections = [
        { name: "definition", slot: "system" as const, header: null, weight: 2, content: "system" },
        { name: "log", slot: "user" as const, header: "Log", weight: 10, content: "first record\n\nsecond record", items: ["first record", "second record"] },
        { name: "worker", slot: "user" as const, header: "Worker", weight: 4, content: '{"turn":3}' },
        { name: "emission-history", slot: "user" as const, header: "Previous Emission", weight: 20, content: previous },
    ];
    const packet = { weight: 36, sections, attributions: [] };
    let original: string;
    let originalItems: unknown[];
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'packetUpgrade');
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'writer', 'model');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns)
                VALUES (1, 1, 1, 'retain evidence', '{"proposals":"reject"}', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status, completed_at)
                VALUES (1, 1, 1, 'model', 'inference', 102, NULL);
        `);
        before.prepare("INSERT INTO turn_inference_evidence (turn_id, packet, sections) VALUES (1, ?, ?)")
            .run(StoredPacket.stringify(packet), StoredPacket.sections(packet));
        original = before.prepare("SELECT packet FROM turn_packets WHERE id = 1").get()!.packet as string;
        originalItems = before.prepare("SELECT * FROM turn_section_items ORDER BY turn_id, section, position").all();
    } finally { before.close(); }
    const db = await openMigrated(path);
    try {
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: 1 }))!.packet, original!, "old packet bytes and section order survive the upgrade");
        const historical = StoredPacket.parse(original!)!;
        assert.deepEqual(PacketWire.packetToWireMessages(historical), [
            { role: "system", content: "system" },
            { role: "user", content: `## Log\n\nfirst record\n\nsecond record\n\n## Worker\n{"turn":3}\n\n## Previous Emission\n\n${previous}` },
        ], "old authorship is not rewritten by the new projector");
        const current = { ...packet, sections: [sections[0], sections[1],
            { ...sections[3], slot: "assistant" as const, header: null }, sections[2]] };
        const id = await insertPacketTurn(db, 1, 2, current, 200);
        const stored = StoredPacket.parse((await db.test_get_packet.get<{ packet: string }>({ id }))!.packet)!;
        assert.deepEqual(PacketWire.packetToWireMessages(stored), [
            { role: "system", content: "system" },
            { role: "user", content: "## Log\n\nfirst record\n\nsecond record" },
            { role: "assistant", content: previous },
            { role: "user", content: '## Worker\n{"turn":3}' },
        ]);
    } finally { await db.close(); }
    const after = new DatabaseSync(path);
    try {
        after.exec("PRAGMA foreign_keys = ON");
        assert.deepEqual(after.prepare("SELECT * FROM turn_section_items WHERE turn_id = 1 ORDER BY turn_id, section, position").all(), originalItems!);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
        assert.equal(after.prepare("SELECT count(*) AS n FROM packet_items").get()!.n, 5, "new message roles reuse every content-addressed item");
        assert.throws(() => after.exec("UPDATE turn_sections SET slot = 'tool' WHERE turn_id = 2"), /CHECK constraint failed/);
        assert.throws(() => after.exec("UPDATE turn_sections SET slot = NULL WHERE turn_id = 2"), /NOT NULL constraint failed/);
        after.exec("DELETE FROM turns WHERE id = 2");
        assert.equal(after.prepare("SELECT count(*) AS n FROM turn_section_items WHERE turn_id = 2").get()!.n, 0, "section and item membership still cascade with the turn");
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§a2a-worker-ownership}: migration reparents A2A contexts without adopting ordinary roots or losing task evidence", async (t) => {
    const path = await released(t, V2_0_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'a2aUpgrade');
            INSERT INTO workers (id, workspace_id, name, origin, parent_worker_id)
                VALUES (1, 1, 'context', 'model', NULL), (2, 1, 'task', 'model', 1), (3, 1, 'ordinary', 'model', NULL);
            INSERT INTO loops (id, worker_id, sequence, prompt, prompt_source, policy, max_turns)
                VALUES (1, 2, 1, 'Retain this task', 'a2a://anonymous/contexts/context/tasks/task/messages/message', '{"proposals":"accept","attended":true}', -1);
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    try {
        const context = after.prepare("SELECT parent_worker_id, owner FROM workers WHERE id = 1").get()!;
        const runtime = after.prepare("SELECT id, owner FROM workers WHERE origin = '_plurnk'").get()!;
        assert.equal(context.parent_worker_id, runtime.id);
        assert.equal(context.owner, "_plurnk");
        assert.equal(runtime.owner, "_plurnk");
        assert.equal(after.prepare("SELECT parent_worker_id FROM workers WHERE id = 2").get()!.parent_worker_id, 1);
        assert.equal(after.prepare("SELECT parent_worker_id FROM workers WHERE id = 3").get()!.parent_worker_id, null);
        assert.equal(after.prepare("SELECT prompt FROM loops WHERE id = 1").get()!.prompt, "Retain this task");
        assert.equal(columns(after, "loops").includes("policy"), false);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§schedule-delivery}: upgrades remove message-carried authority without losing schedules or other family state", async (t) => {
    const path = await released(t, V2_0_0);
    const definition = { rule: "FREQ=HOURLY;COUNT=2", target: "worker://bot", prompt: "Beat." };
    const state = { version: 1, definitions: {
        beat: { origin: "workspace", enabled: true, definition: { ...definition, policy: { proposals: "accept" } } },
        disabled: { origin: "workspace", enabled: false, definition: { ...definition, policy: { proposals: "reject" } } },
        inherited: { origin: "service", enabled: false },
    } };
    const before = new DatabaseSync(path);
    try {
        before.exec("INSERT INTO workspaces (id, name) VALUES (1, 'scheduleUpgrade')");
        const insert = before.prepare("INSERT INTO workspace_module_state (workspace_id, namespace_owner, state) VALUES (1, ?, ?)");
        insert.run("@plurnk/plurnk-schedule", JSON.stringify(state));
        insert.run("other", JSON.stringify(state));
    } finally { before.close(); }
    const db = await openMigrated(path);
    try {
        const read = async (owner: string) => JSON.parse((await db.workspace_module_state_get.get<{ state: string }>({ workspace_id: 1, namespace_owner: owner }))!.state);
        assert.deepEqual(await read("@plurnk/plurnk-schedule"), { version: 1, definitions: {
            beat: { origin: "workspace", enabled: true, definition },
            disabled: { origin: "workspace", enabled: false, definition },
            inherited: { origin: "service", enabled: false },
        } });
        assert.deepEqual(await read("other"), state);
    } finally { await db.close(); }
});

test("{§db-migrations} {§functionality-addressing}: upgrading names each members definition by its glob and keeps no override an alias named", async (t) => {
    const path = await released(t, V3_2_0);
    const loose = { origin: "workspace", enabled: true, definition: { glob: "loose.md", provenance: { kind: "client-action" } } };
    const noBig = { origin: "workspace", enabled: false, definition: { glob: "!big/**", provenance: { kind: "model-proposal" } } };
    const aliased = { version: 1, definitions: { docs: { origin: "service", enabled: false }, loose, "no-big": noBig } };
    const serviceOnly = { version: 1, definitions: { docs: { origin: "service", enabled: false } } };
    const before = new DatabaseSync(path);
    try {
        before.exec("INSERT INTO workspaces (id, name) VALUES (1, 'membersUpgrade'), (2, 'membersServiceOnly')");
        const insert = before.prepare("INSERT INTO workspace_module_state (workspace_id, namespace_owner, state) VALUES (?, ?, ?)");
        insert.run(1, "@plurnk/plurnk-core/members", JSON.stringify(aliased));
        insert.run(1, "other", JSON.stringify(aliased));
        insert.run(2, "@plurnk/plurnk-core/members", JSON.stringify(serviceOnly));
    } finally { before.close(); }
    const db = await openMigrated(path);
    try {
        const read = async (workspaceId: number, owner: string) => {
            const row = await db.workspace_module_state_get.get<{ state: string }>({ workspace_id: workspaceId, namespace_owner: owner });
            return row === undefined ? undefined : JSON.parse(row.state);
        };
        assert.deepEqual(await read(1, "@plurnk/plurnk-core/members"), { version: 1, definitions: { "loose.md": loose, "!big/**": noBig } },
            "a workspace definition is keyed by its glob, with its enabledness and provenance");
        assert.deepEqual(await read(1, "other"), aliased, "another family's state is untouched");
        assert.equal(await read(2, "@plurnk/plurnk-core/members"), undefined, "a state that held only an alias-keyed override persists nothing");
    } finally { await db.close(); }
});

test("{§db-migrations} {§log-mutation-patch}: upgrading gives every settled row a patch column holding nothing, through the active view", async (t) => {
    const path = await released(t, V3_2_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'patchUpgrade');
            INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'editor', 'model');
            INSERT INTO loops (id, worker_id, sequence, prompt, max_turns) VALUES (1, 1, 1, 'Edit', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 200);
            INSERT INTO log_entries (id, worker_id, loop_id, turn_id, sequence, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx)
                VALUES (1, 1, 1, 1, 1, 'model', 'EDIT', '{"body":{"raw":"TWO"}}', 'application/json', '{"status":200}', 'application/json', 200);
            INSERT INTO log_entry_projections (log_entry_id, active) VALUES (1, 1);
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    try {
        const row = await db.log_read_by_coordinate.get<{ patch: string | null; status_rx: number }>({ worker_id: 1, loop_seq: 1, turn_seq: 1, sequence: 1 });
        assert.deepEqual({ status_rx: row?.status_rx, patch: row?.patch }, { status_rx: 200, patch: null }, "a row settled before this version keeps no invented diff, and the active view serves the column");
    } finally { await db.close(); }
});

test(`{§db-migrations}: a ${V3_3_0.release} database renames its worker flag column in place, keeping each row's flag`, async (t) => {
    const path = await released(t, V3_3_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'flagUpgrade');
            INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
            INSERT INTO workers (id, workspace_id, name, origin, default_conversation) VALUES (1, 1, 'ab3d5678', 'model', 1), (2, 1, 'named', 'model', 0);
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    try {
        assert.ok(columns(after, "workers").includes("default_worker"));
        assert.equal(columns(after, "workers").includes("default_conversation"), false);
        assert.deepEqual(after.prepare("SELECT id, default_worker FROM workers ORDER BY id").all().map((row) => ({ ...row })),
            [{ id: 1, default_worker: 1 }, { id: 2, default_worker: 0 }], "each released row keeps its flag under the new name");
    } finally { after.close(); }
});

test(`{§db-migrations} {§connection-lifecycle}: a ${V3_3_0.release} database's client workers become their runtime worker's history, losing no row anything names`, async (t) => {
    const path = await released(t, V3_3_0);
    const person = "agui://operator/threads/first";
    const json = "'{}', 'application/json', '{\"status\":200}', 'application/json', 200";
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'clientUpgrade'), (2, 'noRuntime');
            INSERT INTO worker_owners (workspace_id, address, tools, interactive)
                VALUES (1, '_plurnk', '[]', 0), (1, '${person}', '[]', 0), (2, '_plurnk', '[]', 0);
            INSERT INTO workers (id, workspace_id, name, origin)
                VALUES (1, 1, 'main', 'model'), (2, 1, '_plurnk', '_plurnk'), (3, 1, 'person', 'client'), (5, 2, 'other', 'client');
            UPDATE workers SET owner = '${person}' WHERE id = 3;
            INSERT INTO workers (id, workspace_id, name, origin, parent_worker_id) VALUES (4, 1, 'helper', 'model', 3);
            UPDATE workers SET owner = '${person}' WHERE id = 4;
            INSERT INTO loops (id, worker_id, sequence, prompt, max_turns)
                VALUES (1, 2, 1, 'narration', -1), (2, 3, 1, 'operation', -1), (3, 3, 2, 'operation', -1), (4, 1, 1, 'Work.', -1), (5, 5, 1, 'operation', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES
                (1, 2, 1, 'client', 'operation', 200), (2, 3, 1, 'client', 'operation', 200),
                (3, 4, 1, 'model', 'inference', 200), (4, 5, 1, 'client', 'operation', 200);
            INSERT INTO log_entries (id, worker_id, loop_id, turn_id, sequence, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx) VALUES
                (1, 3, 2, 1, 1, 'client', 'sh', ${json}), (2, 3, 3, 2, 1, 'client', 'SEND', ${json}), (3, 5, 5, 4, 1, 'client', 'READ', ${json});
            INSERT INTO ambient_events (id, workspace_id, producer_worker_id, recipient_worker_id, kind, source_record_id, op, tx, mimetype_tx, rx, mimetype_rx, status_rx, state)
                VALUES (1, 1, 3, 1, 'reply', 2, 'SEND', ${json}, 'resolved');
            INSERT INTO log_entries (id, worker_id, loop_id, turn_id, sequence, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx, ambient_event_id)
                VALUES (4, 1, 4, 3, 1, 'model', 'SEND', ${json}, 1);
            INSERT INTO log_entry_projections (log_entry_id, active) VALUES (1, 1), (2, 1), (3, 1), (4, 1);
            INSERT INTO entries (id, workspace_id, scheme, pathname) VALUES (1, 1, 'sh', '/1234abcd');
            INSERT INTO subscriptions (id, worker_id, entry_id, scheme, handle, source) VALUES (1, 3, 1, 'sh', 'sh: make', 'log:///1/1/1/sh');
            INSERT INTO worker_module_state (worker_id, namespace_owner, state) VALUES (3, 'env', '{}');
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    try {
        after.exec("PRAGMA foreign_keys = ON");
        const rows = (sql: string) => after.prepare(sql).all().map((row) => ({ ...row }));
        assert.deepEqual(rows("SELECT id, workspace_id, name, origin, parent_worker_id FROM workers ORDER BY id"), [
            { id: 1, workspace_id: 1, name: "main", origin: "model", parent_worker_id: null },
            { id: 2, workspace_id: 1, name: "_plurnk", origin: "_plurnk", parent_worker_id: null },
            { id: 4, workspace_id: 1, name: "helper", origin: "model", parent_worker_id: null },
            { id: 6, workspace_id: 2, name: "_plurnk", origin: "_plurnk", parent_worker_id: null },
        ], "no client worker remains; a worker a client worker parented is a root worker; a workspace gains its runtime worker");
        assert.equal(after.prepare("SELECT owner FROM workers WHERE id = 4").get()!.owner, "agui://operator", "the thread-scoped AG-UI owner collapses onto the workspace operator owner");
        assert.deepEqual(rows("SELECT id, worker_id, sequence, prompt_source FROM loops ORDER BY id"), [
            { id: 1, worker_id: 2, sequence: 1, prompt_source: null },
            { id: 2, worker_id: 2, sequence: 2, prompt_source: person },
            { id: 3, worker_id: 2, sequence: 3, prompt_source: person },
            { id: 4, worker_id: 1, sequence: 1, prompt_source: null },
            { id: 5, worker_id: 6, sequence: 1, prompt_source: null },
        ], "each client loop follows the runtime worker's own in order, naming the person who owned its worker");
        assert.deepEqual(rows("SELECT id, worker_id, loop_id, ambient_event_id FROM log_entries ORDER BY id"), [
            { id: 1, worker_id: 2, loop_id: 2, ambient_event_id: null },
            { id: 2, worker_id: 2, loop_id: 3, ambient_event_id: null },
            { id: 3, worker_id: 6, loop_id: 5, ambient_event_id: null },
            { id: 4, worker_id: 1, loop_id: 4, ambient_event_id: 1 },
        ], "every row keeps its identity and its loop; the model's observed reply still names its event");
        assert.deepEqual(rows("SELECT producer_worker_id, recipient_worker_id FROM ambient_events"), [{ producer_worker_id: 2, recipient_worker_id: 1 }]);
        assert.deepEqual(rows("SELECT worker_id, source FROM subscriptions"), [{ worker_id: 2, source: "log:///2/1/1/sh" }],
            "an execution's source takes its loop's new number");
        assert.deepEqual(rows("SELECT worker_id FROM worker_module_state"), [], "a client worker's own environment goes with it");
        assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
        assert.deepEqual(rows("SELECT name FROM sqlite_schema WHERE name = 'workers_workspace_default_worker'"), []);
        assert.throws(() => after.exec("UPDATE log_entries SET worker_id = 1 WHERE id = 1"), /immutable/, "the row identity guard holds again");
        assert.throws(() => after.exec("UPDATE subscriptions SET source = 'log:///9/9/9/sh' WHERE id = 1"), /immutable/, "the subscription identity guard holds again");
    } finally { after.close(); }
});

test("{§worker-owner-creation}: upgrades retain workers and their loops, assign runtime ownership and enforce inherited references", async (t) => {
    const path = await released(t, V2_0_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'ownersUpgrade'), (2, 'otherWorkspace');
            INSERT INTO workers (id, workspace_id, name, origin, parent_worker_id)
                VALUES (1, 1, 'parent', 'model', NULL), (2, 1, 'child', 'model', 1), (3, 1, '_plurnk', '_plurnk', NULL);
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns)
                VALUES (1, 1, 1, 'original request', '{"proposals":"accept","attended":true}', -1);
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    after.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        after.exec("PRAGMA foreign_keys = ON");
        assert.deepEqual(after.prepare("SELECT id, owner FROM workers ORDER BY id").all().map((row) => ({ ...row })),
            [1, 2, 3].map((id) => ({ id, owner: "_plurnk" })), "old loop policy does not guess an approval owner");
        assert.equal(after.prepare("SELECT prompt FROM loops WHERE id = 1").get()!.prompt, "original request");
        assert.deepEqual(after.prepare("SELECT workspace_id, address, tools, interactive FROM worker_owners ORDER BY workspace_id").all().map((row) => ({ ...row })),
            [1, 2].map((workspace_id) => ({ workspace_id, address: "_plurnk", tools: "[]", interactive: 0 })), "{§worker-ownership} nobody attends an upgraded owner");
        after.exec(`
            INSERT INTO worker_owners (workspace_id, address, tools) VALUES (1, 'agui://owner', '["request_approval"]');
            UPDATE workers SET owner = 'agui://owner' WHERE id = 1;
            INSERT INTO workers (id, workspace_id, name, origin, parent_worker_id) VALUES (4, 1, 'later', 'model', 1);
        `);
        assert.equal(after.prepare("SELECT interactive FROM worker_owners WHERE address = 'agui://owner'").get()!.interactive, 0, "a client is not interactive until it says so");
        after.exec("UPDATE worker_owners SET interactive = 1 WHERE address = 'agui://owner'");
        assert.throws(() => after.exec("UPDATE worker_owners SET interactive = 1 WHERE address = '_plurnk'"), /CHECK constraint failed/, "the runtime owner is never interactive");
        assert.equal(after.prepare("SELECT owner FROM workers WHERE id = 4").get()!.owner, "agui://owner");
        assert.throws(() => after.exec("UPDATE workers SET owner = 'missing' WHERE id = 2"), /worker owner does not belong/);
        assert.throws(() => after.exec("UPDATE workers SET owner = 'agui://owner' WHERE id = 3"), /worker owner does not belong/);
        assert.throws(() => after.exec("DELETE FROM worker_owners WHERE address = 'agui://owner'"), /worker owner is still referenced/);
        assert.throws(() => after.exec("INSERT INTO workers (workspace_id, name, parent_worker_id) VALUES (2, 'wrong', 1)"), /worker owner or parent does not belong/);
        after.exec("DELETE FROM workspaces WHERE id = 1");
        assert.equal(after.prepare("SELECT count(*) AS n FROM worker_owners WHERE workspace_id = 1").get()!.n, 0);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§db-migrations} {§skills-module}: the skills family state moves to its owner exactly", async (t) => {
    const path = await released(t, V1_27_0);
    const home = await mkdtemp(join(tmpdir(), "plurnk-skills-upgrade-"));
    const hostPaths = new HostPaths({ home, env: {} });
    const definition = { name: "review", source: "https://unreachable.invalid/skills.git", commit: "b".repeat(40) };
    const state = JSON.stringify({ version: 1, definitions: {
        review: { origin: "workspace", enabled: false, definition },
        plurnk: { origin: "service", enabled: false },
    } });
    const before = new DatabaseSync(path);
    try {
        before.exec("INSERT INTO workspaces (id, name) VALUES (1, 'skillsUpgrade')");
        before.prepare("INSERT INTO workspace_module_state (workspace_id, namespace_owner, state) VALUES (1, ?, ?)")
            .run("@plurnk/plurnk-core/skills", state);
    } finally { before.close(); }
    const db = await openMigrated(path);
    const daemon = new Daemon({ db, provider: null, hostPaths });
    t.after(async () => { await daemon.stop(); await db.close(); await rm(home, { recursive: true, force: true }); });
    assert.equal(await db.workspace_module_state_get.get({ workspace_id: 1, namespace_owner: "@plurnk/plurnk-core/skills" }), undefined);
    assert.deepEqual(await db.workspace_module_state_get.get({ workspace_id: 1, namespace_owner: "@plurnk/plurnk-skills" }), { state });
    await daemon.start();
    const listed = await daemon.invokeModuleAction("workspace.skills.list", {}, { scope: "workspace", workspaceId: 1 }) as FunctionalityListResult;
    assert.equal(listed.definitions.find(({ alias }) => alias === "plurnk")?.state, "disabled");
    assert.equal(listed.definitions.find(({ alias }) => alias === "review")?.state, "disabled");
    assert.deepEqual(listed.definitions.find(({ alias }) => alias === "review")?.definition, definition);
});

test("{§db-migrations} {§target-group}: stored groups normalize without rewriting original evidence or historic selection meaning", async (t) => {
    const path = await released(t, V1_27_0);
    const operation = (heading: string): ReadStatement | KillStatement => {
        const item = PlurnkParser.parseStatements(PlurnkParser.frame(heading, null)).items.find((candidate) => candidate.kind === "statement");
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
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'witness', 'model');
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

test("{§db-migrations} {§worker-wait-timing} {§log-history-projection}: a released log keeps its rows, its receipts' bounds and its projections", async (t) => {
    const path = await released(t, V2_0_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'logUpgrade');
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'witness', 'model');
            INSERT INTO loops (id, worker_id, sequence, prompt, policy, max_turns) VALUES (1, 1, 1, 'wait for work', '{}', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 200), (2, 1, 2, 'model', 'inference', 200);
            INSERT INTO log_entries (id, worker_id, loop_id, turn_id, sequence, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx, attrs) VALUES
                (1, 1, 1, 1, 1, 'model', 'WAIT', '{}', 'application/json', '{"status":202}', 'application/json', 202, '{"waiting":-1,"label":"build"}'),
                (2, 1, 1, 1, 2, 'model', 'WAIT', '{}', 'application/json', '{"status":202}', 'application/json', 202, '{"waiting":300}'),
                (3, 1, 1, 2, 1, 'model', 'NOTE', '{}', 'application/json', '{"status":200}', 'application/json', 200, '{"waiting":-1}');
            INSERT INTO log_entry_projections (log_entry_id, active, folded, output_admission_turn_id, output_withheld) VALUES
                (1, 1, '[]', 2, 1), (2, 0, '[]', NULL, 0), (3, 1, '[[1,2]]', NULL, 0);
            -- The process triggers that name the projection persist between opens; the rebuild must survive them.
            CREATE TRIGGER log_entries_initialize_projection AFTER INSERT ON log_entries
            BEGIN INSERT INTO log_entry_projections (log_entry_id, active, folded) VALUES (NEW.id, 1, '[]'); END;
            CREATE TRIGGER log_entries_apply_curation AFTER INSERT ON log_entries WHEN 0
            BEGIN UPDATE log_entry_projections SET active = active WHERE 0; END;
            CREATE TRIGGER workers_fork_copies_history AFTER INSERT ON workers
            BEGIN UPDATE log_entry_projections SET folded = folded WHERE 0; END;
        `);
    } finally { before.close(); }
    const db = await openMigrated(path);
    await db.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual(after.prepare("SELECT id, op, attrs FROM log_entries ORDER BY id").all().map((row) => ({ ...row })), [
            { id: 1, op: "WAIT", attrs: '{"label":"build"}' },
            { id: 2, op: "WAIT", attrs: '{"waiting":300}' },
            { id: 3, op: "NOTE", attrs: '{"waiting":-1}' },
        ], "a WAIT receipt carries only a seconds bound; other evidence is unchanged");
        assert.deepEqual(columns(after, "log_entry_projections"), ["log_entry_id", "active", "folded"]);
        assert.deepEqual(after.prepare("SELECT log_entry_id, active, folded FROM log_entry_projections ORDER BY log_entry_id").all().map((row) => ({ ...row })), [
            { log_entry_id: 1, active: 1, folded: "[]" },
            { log_entry_id: 2, active: 0, folded: "[]" },
            { log_entry_id: 3, active: 1, folded: "[[1,2]]" },
        ]);
        assert.deepEqual(after.prepare("SELECT id, folded FROM active_log_entries ORDER BY id").all().map((row) => ({ ...row })), [
            { id: 1, folded: "[]" },
            { id: 3, folded: "[[1,2]]" },
        ], "the view reads the rebuilt projection");
        assert.deepEqual(
            (after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%log_entry_projections%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name),
            [
                "log_entries_apply_curation", "log_entries_initialize_projection",
                "log_entry_projections_delete_with_event_only", "log_entry_projections_emission_whole",
                "log_entry_projections_folded_valid_insert", "log_entry_projections_folded_valid_update",
                "log_entry_projections_invalidate_derivation", "log_entry_projections_kill_terminal",
                "workers_fork_copies_history",
            ],
            "the guards are redeclared and the processes are current",
        );
        assert.throws(() => after.exec("UPDATE log_entries SET attrs = '{}' WHERE id = 2"), /attrs are immutable/, "the attrs guard is redeclared");
        assert.throws(() => after.exec("UPDATE log_entry_projections SET active = 1 WHERE log_entry_id = 2"), /cannot re-enter the active projection/);
        assert.throws(() => after.exec("UPDATE log_entry_projections SET folded = '[[2,1]]' WHERE log_entry_id = 1"), /folded ranges are invalid/);
        assert.throws(() => after.exec("DELETE FROM log_entry_projections WHERE log_entry_id = 1"), /must retain its projection/);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

// {§worker-obligations} The migration before 31 identified a message's sender by its name; 31 records the operation
// that sent it. A message sent before that record keeps its every fact and opens no worker's obligation.
test("{§db-migrations} {§worker-obligations}: a version-30 database keeps its messages, and one sent before openers were recorded holds no worker", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-openers-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "migrations");
    await mkdir(dir);
    const chapters = (await readdir(MIGRATIONS_DIR)).filter((name) => Number(name.split("_")[0]) <= 30);
    await Promise.all(chapters.map((name) => copyFile(join(MIGRATIONS_DIR, name), join(dir, name))));
    const path = join(root, "openers.db");
    const before = new SqlRiteSync({ path, dir: [dir, join(import.meta.dirname, "migration-031")] });
    try { before.test_seed_message_openers(); } finally { before.close(); }
    const db = await openMigrated(path);
    try {
        assert.deepEqual((await db.test_message_openers.all({})).map((row) => ({ ...row })), [
            { id: 1, source: "worker://main", opened_turn_id: null, opened_sequence: null, sender_worker_id: null },
        ], "the message keeps its source and body and names no opener");
        assert.deepEqual({ ...(await db.test_worker_obligations.get({ worker_id: 1 })) }, { worker_id: 1, streams: 0, workers: 0, messages: 0 },
            "a message with no recorded opener holds no worker");
    } finally { await db.close(); }
});

test("{§db-migrations} {§worker-external-reference}: upgrade preserves existing workers without inventing external identities", async (t) => {
    const path = await released(t, { version: 31 });
    const before = new DatabaseSync(path);
    before.exec(`
        PRAGMA foreign_keys = ON;
        INSERT INTO workspaces (id, name) VALUES (1, 'retained');
        INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
        INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'retained', 'model');
    `);
    const workspace = { ...before.prepare("SELECT * FROM workspaces WHERE id = 1").get() };
    const worker = { ...before.prepare("SELECT * FROM workers WHERE id = 1").get() };
    before.close();
    const upgraded = await openMigrated(path);
    await upgraded.close();
    const after = new DatabaseSync(path);
    // The columns the released rows had: a later version may add its own beside them.
    const retained = (row: object, seeded: object): Record<string, unknown> =>
        Object.fromEntries(Object.entries(row).filter(([column]) => Object.hasOwn(seeded, column)));
    try {
        assert.deepEqual(retained({ ...after.prepare("SELECT * FROM workspaces WHERE id = 1").get() }, workspace), workspace);
        assert.deepEqual(retained({ ...after.prepare("SELECT * FROM workers WHERE id = 1").get() }, worker), worker);
        assert.deepEqual(after.prepare("SELECT * FROM worker_references").all(), []);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test(`{§db-migrations} {§place-hiding}: a ${V4_0_0.release} database keeps every row, each workspace and worker shown`, async (t) => {
    const path = await released(t, V4_0_0);
    const before = new DatabaseSync(path);
    before.exec(`
        PRAGMA foreign_keys = ON;
        INSERT INTO workspaces (id, name) VALUES (1, 'retained');
        INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
        INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'root', 'model');
        INSERT INTO workers (id, workspace_id, name, parent_worker_id, origin) VALUES (2, 1, 'child', 1, 'model');
    `);
    const workspace = { ...before.prepare("SELECT * FROM workspaces WHERE id = 1").get() };
    const workers = before.prepare("SELECT * FROM workers ORDER BY id").all().map((row) => ({ ...row }));
    before.close();
    const upgraded = await openMigrated(path);
    await upgraded.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual({ ...after.prepare("SELECT * FROM workspaces WHERE id = 1").get() }, { ...workspace, hidden_at: null });
        assert.deepEqual(after.prepare("SELECT * FROM workers ORDER BY id").all().map((row) => ({ ...row })),
            workers.map((row) => ({ ...row, hidden_at: null, hidden_by: null })));
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test(`{§db-migrations} {§worker-ownership}: a ${V4_3_0.release} database collapses thread-scoped AG-UI owners onto the workspace operator owner`, async (t) => {
    const path = await released(t, V4_3_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'operatorOwners');
            INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES
                (1, '_plurnk', '[]', 0),
                (1, 'agui://anonymous/threads/1%23user', '["request_approval","question"]', 1),
                (1, 'agui://operator/threads/1%23child', '["request_approval"]', 0),
                (1, 'acp://operator', '["request_approval"]', 1);
            INSERT INTO workers (id, workspace_id, name, origin, owner) VALUES
                (1, 1, 'user', 'model', 'agui://anonymous/threads/1%23user'),
                (2, 1, 'child', 'model', 'agui://operator/threads/1%23child'),
                (3, 1, 'peer', 'model', 'acp://operator');
            INSERT INTO loops (id, worker_id, sequence, prompt, max_turns) VALUES (1, 2, 1, 'Ask', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 102);
            INSERT INTO client_interactions (id, worker_id, loop_id, turn_id, recipient, request)
                VALUES (1, 2, 1, 1, 'agui://operator/threads/1%23child', '{"tool":"question"}');
        `);
    } finally { before.close(); }
    const upgraded = await openMigrated(path);
    await upgraded.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual(after.prepare("SELECT address, tools, interactive FROM worker_owners WHERE workspace_id = 1 ORDER BY address").all().map((row) => ({ ...row })), [
            { address: "_plurnk", tools: "[]", interactive: 0 },
            { address: "acp://operator", tools: '["request_approval"]', interactive: 1 },
            { address: "agui://operator", tools: '["request_approval","question"]', interactive: 1 },
        ]);
        assert.deepEqual(after.prepare("SELECT id, owner FROM workers ORDER BY id").all().map((row) => ({ ...row })), [
            { id: 1, owner: "agui://operator" },
            { id: 2, owner: "agui://operator" },
            { id: 3, owner: "acp://operator" },
        ]);
        assert.equal(after.prepare("SELECT recipient FROM client_interactions WHERE id = 1").get()!.recipient, "agui://operator");
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§db-migrations}: versions are consecutive from 1 and a fresh database lands on the last", async () => {
    const versions = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.map(({ version }) => version);
    assert.deepEqual(versions, versions.map((_, index) => index + 1), "versions are numbered consecutively from 1 with no gaps");
    assert.ok(versions.length >= V2_0_0.version, "the released versions are all present");
    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, versions.length, "a fresh database applies every version");
    } finally { await db.close(); }
});

for (const release of [V4_3_0, V4_0_0, V3_3_0, V3_2_0, V3_1_0, V3_0_0, V2_0_0, V1_27_0, V1_24_0, V1_21_1]) {
    test(`{§db-migrations}: versions 1-${release.version} keep the ${release.release} shape`, async (t) => {
        assert.equal(shape(await released(t, release)), release.shape, `a released migration changed shape; add the next MIGRATE version instead of editing versions 1-${release.version}`);
    });
}

test("{§db-migrations} {§provider-request-evidence}: upgrading keeps earlier requests and does not fabricate captures", async (t) => {
    const path = await released(t, V1_24_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'requestUpgrade');
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'witness', 'model');
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

test("{§db-migrations} {§proposal-decision-evidence} {§retention-policy}: upgrade preserves old results and captures without inventing decisions or expiry", async (t) => {
    const path = await released(t, V3_1_0);
    const before = new DatabaseSync(path);
    let request: unknown;
    let operation: unknown;
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'evidenceUpgrade');
            INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'witness', 'model');
            INSERT INTO loops (id, worker_id, sequence, prompt, max_turns)
                VALUES (1, 1, 1, 'retain the facts', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status, completed_at)
                VALUES (1, 1, 1, 'model', 'inference', 102, NULL);
            INSERT INTO inference_calls (id, workspace_id, turn_id, sequence, kind, request_model)
                VALUES (1, 1, 1, 1, 'emission', 'fixture');
            INSERT INTO provider_requests (id, inference_call_id, sequence, provider, model)
                VALUES (1, 1, 1, 'provider:fixture', 'fixture');
            UPDATE provider_requests SET state = 'settled', outcome = 'error', status = 502,
                cost_kind = 'unknown', cost_reason = 'No billing response arrived.',
                completed_at = '2026-09-01T00:00:00.000Z', evidence = '{"reasoning":"Earlier partial output."}'
                WHERE id = 1;
            INSERT INTO log_entries (id, worker_id, loop_id, turn_id, sequence, origin, op, tx, mimetype_tx, rx, mimetype_rx, status_rx)
                VALUES (1, 1, 1, 1, 1, 'model', 'EDIT', '{}', 'application/json', '{"status":200}', 'application/json', 200);
            INSERT INTO log_entry_projections (log_entry_id, active, folded) VALUES (1, 0, '[]');
        `);
        request = before.prepare("SELECT * FROM provider_requests").get();
        operation = before.prepare("SELECT * FROM log_entries").get();
    } finally { before.close(); }
    const migrated = await openMigrated(path);
    await migrated.close();
    const after = new DatabaseSync(path, { readOnly: true });
    try {
        assert.deepEqual(after.prepare("SELECT * FROM provider_requests").get(), request);
        assert.deepEqual({ ...after.prepare("SELECT * FROM log_entries").get() }, { ...(operation as object), patch: null });
        assert.deepEqual(after.prepare("SELECT * FROM proposal_decisions").all(), [], "an old successful result is not evidence of who approved it");
        assert.equal(after.prepare("SELECT payloads_retired_at FROM inference_calls").get()!.payloads_retired_at, null);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§graph-relations}: upgrading preserves source content and invalidates imprecise derived coordinates", async (t) => {
    const path = await released(t, V1_24_0);
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

test("{§db-migrations} {§child-orientation}: upgrading retains streams without inventing their missing output timestamps", async (t) => {
    const path = await released(t, V1_24_0);
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'streamUpgrade');
            INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'observer', 'model');
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

test(`{§db-migrations} {§emission-row}: a ${V1_24_0.release} database migrates in place, keeping its log and inventing no announcement`, async (t) => {
    const path = await released(t, V1_24_0);
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'exampleWorkspace');
            INSERT INTO model_routes (id, alias, provider, model) VALUES (1, 'example', 'deepseek', 'deepseek-chat');
            INSERT INTO workers (id, workspace_id, name, origin, model_route_id, effort, effort_source)
                VALUES (1, 1, 'exampleWorkerName', 'model', 1, 'medium', 'explicit');
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

test(`{§db-migrations}: a ${V1_21_1.release} database migrates in place and keeps its rows`, async (t) => {
    const path = await released(t, V1_21_1);
    const before = new DatabaseSync(path);
    before.function("sha256", { deterministic: true }, (text) => sha256(text as string));
    try {
        before.exec(`
            INSERT INTO workspaces (id, name) VALUES (1, 'exampleWorkspace');
            INSERT INTO model_routes (id, alias, provider, model) VALUES (1, 'example', 'deepseek', 'deepseek-chat');
            INSERT INTO workers (id, workspace_id, name, origin, model_route_id, reasoning_policy, reasoning_source)
                VALUES (1, 1, 'exampleWorkerName', 'model', 1, 'medium', 'explicit');
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
