// {§retention-policy} — information is kept by default; the operator's knobs retire packet
// compositions by count or age, and collect what no row references.
import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Retention, { retentionPolicy } from "../../src/server/Retention.ts";
import Daemon from "../../src/server/Daemon.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import SearchIndex from "../../src/schemes/_search-index.ts";
import EntryFts from "../../src/schemes/_entry-fts.ts";
import type { DurablePacket } from "../../src/core/StoredPacket.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { insertLoop, insertPacketTurn, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";

const counts = ({ reclaimedPages: _reclaimed, collectedContents: _contents, ...rest }: Awaited<ReturnType<Retention["run"]>>) => rest;
const DEFAULTS = { PLURNK_SERVICE_RETAIN_PACKET_TURNS: "-1", PLURNK_SERVICE_RETAIN_PACKET_MS: "-1", PLURNK_SERVICE_RETAIN_RESPONSE_TURNS: "-1", PLURNK_SERVICE_RETAIN_RESPONSE_MS: "-1", PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "1", PLURNK_SERVICE_COLLECT_DERIVATIONS: "1", PLURNK_SERVICE_COLLECT_CONTENTS: "1", PLURNK_SERVICE_RETENTION_INTERVAL_MS: "3600000", PLURNK_SERVICE_AUTO_VACUUM: "incremental", PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES: "0" };
const CAPACITY = JSON.stringify({ decision: "admit", contextWindow: 1001, maxInputTokens: null, maxOutputTokens: null, outputBudget: 1, reasoningBudget: null, inputCapacity: 1000, prompt: { kind: "exact", tokens: 10, source: "retention-fixture" } });
const record = (n: number): string => `### log:///1/1/${n}/READ\n{"status":200}\n1:line ${n}`;
const packet = (upTo: number): DurablePacket => {
    const items = Array.from({ length: upTo }, (_, i) => record(i + 1));
    return { weight: 1, sections: [{ name: "log", slot: "user", header: "Log", content: items.join("\n\n"), weight: 1, items }], attributions: [] };
};

test("{§configuration-repair-path}: invalid retention withholds collection and storage conversion through shutdown", async (t) => {
    const key = "PLURNK_SERVICE_RETAIN_PACKET_TURNS";
    const previous = process.env[key];
    process.env[key] = "invalid";
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "retention-repair");
    const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/released.md", channel: "body", content: "must remain", mimetype: "text/plain" });
    await db.crud_delete_entry.run({ entry_id: entryId });
    const before = await db.test_content_store_count.get({});
    assert.equal(before?.n, 1);
    const mode = await db.retention_auto_vacuum_mode.get({});
    const daemon = new Daemon({ db });
    try {
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key));
        assert.deepEqual(await db.retention_auto_vacuum_mode.get({}), mode, "an invalid policy cannot choose a storage conversion");
    } finally { await daemon.stop(); }
    assert.deepEqual(await db.test_content_store_count.get({}), before, "no collector ran at startup or shutdown");
});

test("{§retention-policy}: the shipped panel bounds transient data by age and keeps the durable record (#788)", () => {
    // The intg tier loads .env.defaults, so this is the real panel, not a fixture.
    const shipped = retentionPolicy(process.env);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    assert.equal(shipped.retainPacketMs, thirtyDays, "packets are transient evidence, collected after thirty days");
    assert.equal(shipped.retainResponseMs, thirtyDays, "so are raw response bodies");
    assert.equal(shipped.retainPacketTurns, -1, "a loop is already bounded by its own turns; age is what grows without limit");
    assert.equal(shipped.retainResponseTurns, -1);
});

test("{§retention-policy}: the keep-everything fixture retires nothing and refuses malformed knobs", async () => {
    const policy = retentionPolicy(DEFAULTS);
    assert.deepEqual(policy, { retainPacketTurns: -1, retainPacketMs: -1, retainResponseTurns: -1, retainResponseMs: -1, collectPacketItems: true, collectDerivations: true, collectContents: true, intervalMs: 3_600_000, autoVacuum: "incremental", reclaimMinFreeBytes: 0 });
    for (const [key, value] of [
        ["PLURNK_SERVICE_RETAIN_PACKET_TURNS", "-2"],
        ["PLURNK_SERVICE_COLLECT_DERIVATIONS", "yes"],
        ["PLURNK_SERVICE_AUTO_VACUUM", "full"],
        ["PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES", "-1"],
        ["PLURNK_SERVICE_RETENTION_INTERVAL_MS", ""],
    ]) assert.throws(() => retentionPolicy({ ...DEFAULTS, [key!]: value }), (cause: unknown) => {
        assert.ok(cause instanceof ConfigurationError);
        assert.equal(cause.key, key);
        assert.ok(cause.message.includes(key!));
        return true;
    });
    assert.throws(() => retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETENTION_INTERVAL_MS: undefined }),
        /PLURNK_SERVICE_RETENTION_INTERVAL_MS is missing from the assembled environment floor/u);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-defaults-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertWorker(db, workspaceId), 1, "go");
        const turns = [];
        for (let sequence = 1; sequence <= 3; sequence += 1) turns.push(await insertPacketTurn(db, loopId, sequence, packet(sequence), 200));
        const pass = await new Retention(db, policy).run();
        assert.deepEqual(counts(pass), { retiredPackets: 0, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 }, "nothing that is information leaves under the defaults");
        for (const id of turns) assert.equal((await db.test_turn_sections_count.get<{ n: number }>({ turn_id: id }))!.n, 1);
    } finally { await db.close(); }
});

test("{§retention-policy}: a count policy keeps the newest packets of each loop; retired compositions release only their own items", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-count-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertWorker(db, workspaceId), 1, "go");
        const turns = [];
        for (let sequence = 1; sequence <= 4; sequence += 1) turns.push(await insertPacketTurn(db, loopId, sequence, packet(sequence), 200));
        const live = await db.test_open_inference_turn.get<{ id: number }>({ loop_id: loopId, sequence: 5 });
        assert.ok(live);
        const pass = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "2" })).run();
        assert.deepEqual(counts(pass), { retiredPackets: 2, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 }, "turns 1 and 2 retire; every one of their records is still cited by turns 3 and 4");
        assert.deepEqual(await Promise.all(turns.map(async (id) => (await db.test_turn_sections_count.get<{ n: number }>({ turn_id: id }))!.n)), [0, 0, 1, 1]);
        const bag = await db.test_bag_of_turn.get<{ packet: string | null }>({ id: turns[0]! });
        assert.ok(bag?.packet, "the retired turn keeps its bag: weight, attributions, and any admitted response");
        const assembled = await db.test_get_packet.get<{ packet: string }>({ id: turns[0]! });
        assert.deepEqual(JSON.parse(assembled!.packet).sections, [], "a retired packet reads back with no sections");

        const again = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "0" })).run();
        assert.deepEqual(counts(again), { retiredPackets: 2, retiredResponses: 0, collectedItems: 4, collectedDerivations: 0 }, "keeping none retires the rest; the four records nothing cites now leave");
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 0);
        const keep = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "0", PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "0" })).run();
        assert.deepEqual(counts(keep), { retiredPackets: 0, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 }, "the open turn is never retired");
    } finally { await db.close(); }
});

test("{§retention-policy}: a response policy retires bodies while the call's evidence and admission stay, and a body never changes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-responses-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertWorker(db, workspaceId), 1, "go");
        const calls: number[] = [];
        for (let sequence = 1; sequence <= 3; sequence += 1) {
            const turn = await db.test_context_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence, curation_budget: null, curation_weight: 10 });
            await db.test_complete_turn_at.run({ id: turn!.id, completed_at: `2026-09-0${sequence}T00:00:00.000Z` });
            const call = await db.test_context_insert_model_call.get<{ id: number }>({ turn_id: turn!.id, sequence: 1, kind: "emission" });
            await db.test_context_close_model_call.run({ id: call!.id, capacity: CAPACITY });
            calls.push(call!.id);
        }
        await assert.rejects(db.test_context_close_model_call.run({ id: calls[0]!, capacity: CAPACITY }), /model call observation is immutable/, "a settled call refuses a second observation");
        await assert.rejects(db.test_update_model_call_response.run({ id: calls[0]!, response: "{}" }), /model call response is immutable/, "a body never changes");
        const bodies = async () => (await db.test_model_call_bodies.all<{ id: number; state: string; has_body: number; has_capacity: number }>({ loop_id: loopId })).map(({ state, has_body, has_capacity }) => `${state}:${has_body}:${has_capacity}`);
        assert.deepEqual(await bodies(), ["response:1:1", "response:1:1", "response:1:1"]);
        const keepAll = await new Retention(db, retentionPolicy(DEFAULTS)).run();
        assert.equal(keepAll.retiredResponses, 0, "the defaults keep every body");

        const byCount = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_RESPONSE_TURNS: "1" })).run();
        assert.equal(byCount.retiredResponses, 2, "the two older bodies of the loop retire; the newest stays");
        assert.deepEqual(await bodies(), ["response:0:1", "response:0:1", "response:1:1"], "the calls stay settled with their capacity; only the bodies went");

        const byAge = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_RESPONSE_MS: String(24 * 3_600_000) })).run(Date.parse("2026-09-05T00:00:00.000Z"));
        assert.equal(byAge.retiredResponses, 1, "an age policy retires the remaining body by its turn's completion");
        assert.deepEqual(await bodies(), ["response:0:1", "response:0:1", "response:0:1"]);
    } finally { await db.close(); }
});

test("{§retention-policy}: an age policy retires by completion time, and a disabled collector keeps orphaned items", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-age-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertWorker(db, workspaceId), 1, "go");
        const old = await insertPacketTurn(db, loopId, 1, packet(1), 200);
        const fresh = await insertPacketTurn(db, loopId, 2, packet(2), 200);
        await db.test_complete_turn_at.run({ id: old, completed_at: "2026-01-01T00:00:00.000Z" });
        const policy = retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_PACKET_MS: String(7 * 24 * 3_600_000), PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "0" });
        const pass = await new Retention(db, policy).run(Date.parse("2026-09-12T00:00:00.000Z"));
        assert.deepEqual(counts(pass), { retiredPackets: 1, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 });
        assert.equal((await db.test_turn_sections_count.get<{ n: number }>({ turn_id: old }))!.n, 0);
        assert.equal((await db.test_turn_sections_count.get<{ n: number }>({ turn_id: fresh }))!.n, 1);
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 2, "the collector is off: the shared record and the fresh record stay, nothing else existed");
    } finally { await db.close(); }
});

test("{§retention-policy}: a superseded derivation and its full-text shadow are collected; a cited one stays", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-derivations-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const entryId = await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "first edition\n", mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
        await SearchIndex.maintain(ctx);
        assert.equal((await db.test_derivation_state_counts.get<{ complete: number }>({}))!.complete, 1);
        assert.equal((await db.test_fts_count.get<{ n: number }>({}))!.n, 1);
        await db.test_set_channel_content.run({ entry_id: entryId, content: "second edition\n" });
        await SearchIndex.maintain(ctx);
        assert.equal((await db.test_derivation_state_counts.get<{ complete: number }>({}))!.complete, 2, "the superseded derivation is still resident before retention");

        const kept = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_COLLECT_DERIVATIONS: "0" })).run();
        assert.equal(kept.collectedDerivations, 0);
        const pass = await new Retention(db, retentionPolicy(DEFAULTS)).run();
        assert.equal(pass.collectedDerivations, 1, "the edition no channel cites leaves");
        assert.equal((await db.test_derivation_state_counts.get<{ complete: number }>({}))!.complete, 1);
        assert.equal((await db.test_fts_count.get<{ n: number }>({}))!.n, 1, "its full-text row left with it through derivations_delete_fts");
        assert.deepEqual(await db.test_fts_search.all({ query: "second", workspace_id: workspaceId }), [{ pathname: "/notes.md" }], "the cited edition still searches");
    } finally { await db.close(); }
});

test("{§derivation-in-flight}: collection preserves unattached search snapshots through derivation and query", async (t) => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `snapshot-retention-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
    const retention = new Retention(db, retentionPolicy(DEFAULTS));
    const process = DEFAULT_MIMETYPES.process.bind(DEFAULT_MIMETYPES);
    t.mock.method(DEFAULT_MIMETYPES, "process", async (...args: Parameters<typeof process>) => {
        const collected = await retention.run();
        assert.equal(collected.collectedDerivations, 0, "a building artifact is still owned by its producer");
        return process(...args);
    });
    const source = { content: "a needle in an unattached snapshot", mimetype: "text/plain", pathname: "/snapshot", scheme: "worker" };
    await SearchIndex.snapshot(ctx, source, async ({ deepHash }) => {
        assert.equal((await retention.run()).collectedDerivations, 0, "a completed snapshot remains held until its query ends");
        const result = await EntryFts.rankCandidates(db, [{ key: "snapshot", deepHash }], "needle");
        assert.equal(result.status, 200);
        assert.deepEqual(result.matches[0]?.matches, [{ region: { startLine: 1, startColumn: 3, endLine: 1, endColumn: 9 }, matched: "needle" }]);
    });
    assert.equal((await retention.run()).collectedDerivations, 1, "unattached evidence is collectible when no operation holds it");
    assert.equal((await db.test_fts_count.get({}))?.n, 0);
    await assert.rejects(SearchIndex.snapshot(ctx, source, async () => { throw new Error("query failed"); }), /query failed/);
    assert.equal((await retention.run()).collectedDerivations, 1, "a failed query also releases its snapshot");
});

test("{§db-space-reclamation}: the daemon converts its database to incremental auto-vacuum once, and every pass returns freed pages", async () => {
    const db = await openMigrated();
    try {
        const retention = new Retention(db, retentionPolicy(DEFAULTS));
        const first = await retention.prepareStorage();
        assert.equal(first.converted, true, "a fresh SQLite file starts with auto_vacuum off");
        assert.deepEqual(await db.retention_auto_vacuum_mode.get({}), { auto_vacuum: 2 });
        assert.equal((await retention.prepareStorage()).converted, false, "conversion happens once");
        await dropBodies(db);
        const pass = await retention.run();
        assert.equal(pass.collectedContents, 40, "the bodies nothing holds leave the content store");
        assert.ok(pass.reclaimedPages > 0, "the pass returns the pages they occupied");
        assert.equal((await db.retention_page_counts.get<{ free: number }>({}))?.free, 0);
    } finally { await db.close(); }
});

// Forty distinct bodies stored and then released: their entries go, their bodies stay in the
// content store until a pass collects them.
const dropBodies = async (db: Awaited<ReturnType<typeof openMigrated>>): Promise<void> => {
    const workspaceId = await insertWorkspace(db, `reclaim-${crypto.randomUUID()}`);
    const entries: number[] = [];
    for (let index = 0; index < 40; index += 1) {
        entries.push(await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: `/bulk-${index}.md`, channel: "body", content: `${index}`.padEnd(50_000, "x"), mimetype: "text/markdown" }));
    }
    for (const entryId of entries) await db.crud_delete_entry.run({ entry_id: entryId });
};

test("{§db-space-reclamation}: a pass leaves no write-ahead log behind (#786)", async () => {
    const path = join(tmpdir(), `wal-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    try {
        const retention = new Retention(db, retentionPolicy(DEFAULTS));
        await retention.prepareStorage();
        await dropBodies(db);
        assert.ok((await stat(`${path}-wal`)).size > 0, "forty stored and released bodies went through the log");
        await retention.run();
        assert.equal((await stat(`${path}-wal`)).size, 0, "reclaimed pages are not held hostage by the log");
    } finally { await db.close(); }
});

test("{§db-space-reclamation}: below the reclaim floor a pass leaves free pages for reuse", async () => {
    const db = await openMigrated();
    try {
        const retention = new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES: String(1 << 30) }));
        await retention.prepareStorage();
        await dropBodies(db);
        const pass = await retention.run();
        assert.equal(pass.collectedContents, 40);
        assert.equal(pass.reclaimedPages, 0, "a gigabyte floor is far above what the fixture frees");
        assert.ok((await db.retention_page_counts.get<{ free: number }>({}))!.free > 0, "freed pages stay for reuse");
    } finally { await db.close(); }
});

test("{§db-space-reclamation}: auto_vacuum=none converts an incremental file back and never steps a vacuum", async () => {
    const db = await openMigrated();
    try {
        await new Retention(db, retentionPolicy(DEFAULTS)).prepareStorage();
        const retention = new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_AUTO_VACUUM: "none" }));
        assert.equal((await retention.prepareStorage()).converted, true);
        assert.deepEqual(await db.retention_auto_vacuum_mode.get({}), { auto_vacuum: 0 });
        assert.equal((await retention.prepareStorage()).converted, false);
        await dropBodies(db);
        const pass = await retention.run();
        assert.equal(pass.collectedContents, 40);
        assert.equal(pass.reclaimedPages, 0);
        assert.ok((await db.retention_page_counts.get<{ free: number }>({}))!.free > 0, "freed pages stay in the file");
    } finally { await db.close(); }
});

test("{§content-store}: a body is stored once however many workspaces hold it, and leaves when the last lets go", async () => {
    const db = await openMigrated();
    try {
        const book = "Chapter 1\n".repeat(200_000);
        const entries: number[] = [];
        for (let index = 0; index < 3; index += 1) {
            const workspaceId = await insertWorkspace(db, `book-${index}-${crypto.randomUUID()}`);
            entries.push(await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/book.md", channel: "body", content: book, mimetype: "text/markdown" }));
        }
        assert.deepEqual(await db.test_content_store_count.get({}), { n: 1, bytes: book.length }, "three workspaces, one stored body");
        const retention = new Retention(db, retentionPolicy(DEFAULTS));
        await db.crud_delete_entry.run({ entry_id: entries[0]! });
        await db.crud_delete_entry.run({ entry_id: entries[1]! });
        assert.equal((await retention.run()).collectedContents, 0, "a body still held stays");
        await db.crud_delete_entry.run({ entry_id: entries[2]! });
        assert.equal((await retention.run()).collectedContents, 1);
        assert.deepEqual(await db.test_content_store_count.get({}), { n: 0, bytes: null });
        const kept = new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_COLLECT_CONTENTS: "0" }));
        const workspaceId = await insertWorkspace(db, `book-kept-${crypto.randomUUID()}`);
        await db.crud_delete_entry.run({ entry_id: await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/book.md", channel: "body", content: book, mimetype: "text/markdown" }) });
        assert.equal((await kept.run()).collectedContents, 0, "a disabled collector keeps released bodies");
    } finally { await db.close(); }
});
