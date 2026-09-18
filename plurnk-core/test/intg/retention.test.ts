// {§retention-policy} — information is kept by default; the operator's knobs retire packet
// compositions by count or age, and collect what no row references.
import test from "node:test";
import assert from "node:assert/strict";
import Retention, { retentionPolicy } from "../../src/server/Retention.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import type { DurablePacket } from "../../src/core/StoredPacket.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertPacketTurn, insertWorker, insertWorkspace, makeSchemeCtx, openMigrated, seedEntryWithChannel } from "./_helpers.ts";

const counts = ({ reclaimedPages: _reclaimed, ...rest }: Awaited<ReturnType<Retention["run"]>>) => rest;
const DEFAULTS = { PLURNK_SERVICE_RETAIN_PACKET_TURNS: "-1", PLURNK_SERVICE_RETAIN_PACKET_MS: "-1", PLURNK_SERVICE_RETAIN_RESPONSE_TURNS: "-1", PLURNK_SERVICE_RETAIN_RESPONSE_MS: "-1", PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "1", PLURNK_SERVICE_COLLECT_DERIVATIONS: "1", PLURNK_SERVICE_RETENTION_INTERVAL_MS: "3600000" };
const CAPACITY = JSON.stringify({ decision: "admit", contextWindow: 1001, maxInputTokens: null, maxOutputTokens: null, outputBudget: 1, reasoningBudget: null, inputCapacity: 1000, prompt: { kind: "exact", tokens: 10, source: "retention-fixture" } });
const record = (n: number): string => `### log:///1/1/${n}/READ\n{"status":200}\n1:line ${n}`;
const packet = (upTo: number): DurablePacket => {
    const items = Array.from({ length: upTo }, (_, i) => record(i + 1));
    return { weight: 1, sections: [{ name: "log", slot: "user", header: "Log", content: items.join("\n\n"), weight: 1, items }], attributions: [] };
};

test("{§retention-policy}: the shipped defaults keep every packet and refuse malformed knobs", async () => {
    const policy = retentionPolicy(DEFAULTS);
    assert.deepEqual(policy, { retainPacketTurns: -1, retainPacketMs: -1, retainResponseTurns: -1, retainResponseMs: -1, collectPacketItems: true, collectDerivations: true, intervalMs: 3_600_000 });
    assert.throws(() => retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "-2" }), /PLURNK_SERVICE_RETAIN_PACKET_TURNS must be -1 or a non-negative safe integer/);
    assert.throws(() => retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_COLLECT_DERIVATIONS: "yes" }), /PLURNK_SERVICE_COLLECT_DERIVATIONS must be 0 or 1/);
    assert.throws(() => retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETENTION_INTERVAL_MS: undefined }), /PLURNK_SERVICE_RETENTION_INTERVAL_MS must be a non-negative safe integer/);
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

test("{§db-space-reclamation}: the daemon converts its database to incremental auto-vacuum once, and every pass returns freed pages", async () => {
    const db = await openMigrated();
    try {
        const retention = new Retention(db, retentionPolicy(DEFAULTS));
        const first = await retention.prepareStorage();
        assert.equal(first.converted, true, "a fresh SQLite file starts with auto_vacuum off");
        assert.deepEqual(await db.retention_auto_vacuum_mode.get({}), { auto_vacuum: 2 });
        assert.equal((await retention.prepareStorage()).converted, false, "conversion happens once");

        const workspaceId = await insertWorkspace(db, `reclaim-${crypto.randomUUID()}`);
        const entries: number[] = [];
        for (let index = 0; index < 40; index += 1) {
            entries.push(await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: `/bulk-${index}.md`, channel: "body", content: "x".repeat(50_000), mimetype: "text/markdown" }));
        }
        for (const entryId of entries) await db.crud_delete_entry.run({ entry_id: entryId });
        const freed = await db.retention_page_counts.get<{ pages: number; free: number }>({});
        assert.ok((freed?.free ?? 0) > 0, "deleting the bodies leaves free pages in the file");
        const pass = await retention.run();
        assert.equal(pass.reclaimedPages, freed?.free, "the pass returns every freed page");
        assert.equal((await db.retention_page_counts.get<{ pages: number; free: number }>({}))?.free, 0);
    } finally { await db.close(); }
});
