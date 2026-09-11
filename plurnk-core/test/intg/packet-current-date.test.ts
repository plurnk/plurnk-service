// {§packet-current-date} — the Worker block dates the packet from the daemon's clock: a
// calendar date and IANA zone, injectable so fixtures stay deterministic.
import assert from "node:assert/strict";
import test from "node:test";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection } from "./_helpers.ts";
import { provider } from "./reasoning-fixture.ts";

test("{§packet-current-date}: the Worker block carries the clock's calendar date and zone, beside path and parent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-current-date");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        // 2030-06-15T03:30:00Z is still 2030-06-14 in every zone west of UTC-3.5 and already the 15th east of it;
        // the block renders the daemon's local date, so compare against the same projection.
        const fixed = new Date("2030-06-15T03:30:00Z");
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined, now: () => fixed });
        const packet = await packets.buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: 1, provider: provider(), gitStatus: null,
        });
        const block = JSON.parse(packetSection(packet, "worker")) as { path: string; parent: string | null; date: string; timezone: string };
        const expected = PacketBuilder.currentDate(fixed);
        assert.match(block.path, /^worker:\/\//);
        assert.equal(block.parent, null, "a root worker states parent: null");
        assert.equal(block.date, expected.date);
        assert.match(block.date, /^\d{4}-\d{2}-\d{2}$/, "a calendar date, never a timestamp");
        assert.equal(block.timezone, expected.timezone);
        assert.equal(block.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, "the daemon's IANA zone");
        assert.deepEqual(Object.keys(block), ["path", "parent", "date", "timezone"], "the block carries nothing else");
    } finally { await db.close(); }
});
