// {§retention-policy} — information is kept by default; the operator's knobs retire packet
// compositions by count or age, and collect what no row references.
import test from "node:test";
import assert from "node:assert/strict";
import Retention, { retentionPolicy } from "../../src/server/Retention.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import type { DurablePacket } from "../../src/core/StoredPacket.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertPacketTurn, insertWorker, insertWorkspace, makeSchemeCtx, openMigrated, seedEntryWithChannel } from "./_helpers.ts";

const DEFAULTS = { PLURNK_SERVICE_RETAIN_PACKET_TURNS: "-1", PLURNK_SERVICE_RETAIN_PACKET_MS: "-1", PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "1", PLURNK_SERVICE_COLLECT_DERIVATIONS: "1", PLURNK_SERVICE_RETENTION_INTERVAL_MS: "3600000" };
const record = (n: number): string => `### log:///1/1/${n}/READ\n{"status":200}\n1:line ${n}`;
const packet = (upTo: number): DurablePacket => {
    const items = Array.from({ length: upTo }, (_, i) => record(i + 1));
    return { weight: 1, sections: [{ name: "log", slot: "user", header: "Log", content: items.join("\n\n"), weight: 1, items }], attributions: [] };
};

test("{§retention-policy}: the shipped defaults keep every packet and refuse malformed knobs", async () => {
    const policy = retentionPolicy(DEFAULTS);
    assert.deepEqual(policy, { retainPacketTurns: -1, retainPacketMs: -1, collectPacketItems: true, collectDerivations: true, intervalMs: 3_600_000 });
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
        assert.deepEqual(pass, { retiredPackets: 0, collectedItems: 0, collectedDerivations: 0 }, "nothing that is information leaves under the defaults");
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
        assert.deepEqual(pass, { retiredPackets: 2, collectedItems: 0, collectedDerivations: 0 }, "turns 1 and 2 retire; every one of their records is still cited by turns 3 and 4");
        assert.deepEqual(await Promise.all(turns.map(async (id) => (await db.test_turn_sections_count.get<{ n: number }>({ turn_id: id }))!.n)), [0, 0, 1, 1]);
        const bag = await db.test_bag_of_turn.get<{ packet: string | null }>({ id: turns[0]! });
        assert.ok(bag?.packet, "the retired turn keeps its bag: weight, attributions, and any admitted response");
        const assembled = await db.test_get_packet.get<{ packet: string }>({ id: turns[0]! });
        assert.deepEqual(JSON.parse(assembled!.packet).sections, [], "a retired packet reads back with no sections");

        const again = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "0" })).run();
        assert.deepEqual(again, { retiredPackets: 2, collectedItems: 4, collectedDerivations: 0 }, "keeping none retires the rest; the four records nothing cites now leave");
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 0);
        const keep = await new Retention(db, retentionPolicy({ ...DEFAULTS, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "0", PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "0" })).run();
        assert.deepEqual(keep, { retiredPackets: 0, collectedItems: 0, collectedDerivations: 0 }, "the open turn is never retired");
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
        assert.deepEqual(pass, { retiredPackets: 1, collectedItems: 0, collectedDerivations: 0 });
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
