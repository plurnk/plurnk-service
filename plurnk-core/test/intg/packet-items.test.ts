// {§packet-items} — a packet's sections are rows over content-addressed items: a turn stores its
// new and changed items, the composition reads back byte for byte, and items nothing references
// are transient data, collected.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import StoredPacket, { type DurablePacket } from "../../src/core/StoredPacket.ts";
import Turn from "../../src/core/Turn.ts";
import { insertLoop, insertPacketTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const RECORDS = ["### log:///1/1/1/FIND\n{\"status\":200}\n1:[]", "### log:///1/1/2/READ\n{\"status\":200}\n1:alpha\n2:beta"];
const packet = (records: readonly string[], prompt: string): DurablePacket => ({
    weight: 7,
    sections: [
        { name: "definition", slot: "system", header: null, content: "# Plurnk", weight: 2 },
        { name: "log", slot: "user", header: "Log", content: records.join("\n\n"), weight: 4, items: records },
        { name: "prompt", slot: "user", header: "Active Prompts", content: prompt, weight: 1 },
    ],
    attributions: ["worker://a"],
});

test("{§packet-items}: a turn stores only the items the previous turn did not, and reads back exactly", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const first = packet(RECORDS.slice(0, 1), "[\"prompt://w/1/a\"]");
        const second = packet(RECORDS, "[\"prompt://w/1/a\"]");
        const firstId = await insertPacketTurn(db, loopId, 1, first, 102);
        const before = (await db.test_packet_item_count.get<{ n: number }>({}))!.n;
        assert.equal(before, 3, "turn 1: definition, one log record, prompt");
        const secondId = await insertPacketTurn(db, loopId, 2, second, 200);
        const after = (await db.test_packet_item_count.get<{ n: number }>({}))!.n;
        assert.equal(after - before, 1, "turn 2 added exactly its new log record; every other block was already stored");

        const items = await db.test_turn_items.all<{ section: number; position: number; item_hash: string; text: string }>({ turn_id: secondId });
        assert.deepEqual(items.map(({ section, position, text }) => ({ section, position, text })), [
            { section: 0, position: 0, text: "# Plurnk" },
            { section: 1, position: 0, text: RECORDS[0] },
            { section: 1, position: 1, text: RECORDS[1] },
            { section: 2, position: 0, text: "[\"prompt://w/1/a\"]" },
        ]);
        assert.ok(items.every(({ item_hash, text }) => item_hash === sha256(text)), "an item's address is the SHA-256 of its text");

        for (const [id, expected] of [[firstId, first], [secondId, second]] as const) {
            const row = await db.test_get_packet.get<{ packet: string }>({ id });
            const parsed = StoredPacket.parse(row!.packet, `turn ${id}`);
            assert.deepEqual(parsed, { ...expected, sections: expected.sections.map(({ items: _items, ...section }) => section) }, "the assembled packet is the stored packet, sections included, without the items key");
        }
        const bag = await db.test_bag_of_turn.get<{ packet: string }>({ id: secondId });
        assert.equal(JSON.parse(bag!.packet).sections, undefined, "the bag in turns.packet carries no sections");
    } finally { await db.close(); }
});

test("{§packet-items}: the write view refuses a turn that is not an open model inference turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-refuse-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const done = await insertPacketTurn(db, loopId, 1, packet(RECORDS, "[]"), 200);
        await assert.rejects(
            () => Turn.recordInference(db, done, { packet: StoredPacket.stringify(packet([], "[]")), sections: StoredPacket.sections(packet([], "[]")), usageCurationBudget: null, finishReason: null, model: "m", meta: "{}" }),
            /turn is not an open model inference turn/,
        );
    } finally { await db.close(); }
});

test("{§packet-items}: items nothing references are collected; shared items survive", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `packet-items-collect-${crypto.randomUUID()}`);
        const keeper = await insertWorker(db, workspaceId, null, "keeper");
        const leaver = await insertWorker(db, workspaceId, null, "leaver");
        await insertPacketTurn(db, await insertLoop(db, keeper, 1, "k"), 1, packet(RECORDS.slice(0, 1), "[\"k\"]"), 200);
        await insertPacketTurn(db, await insertLoop(db, leaver, 1, "l"), 1, packet(RECORDS, "[\"l\"]"), 200);
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 5, "definition + two records + two prompts");
        await db.test_delete_worker.run({ id: leaver });
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 5, "deletion cascades the composition, not the items");
        await db.retention_collect_packet_items.run({ collect: 1 });
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 3, "the leaver's own record and prompt are collected; the shared definition and record stay");
    } finally { await db.close(); }
});
