// {§packet-current-turn} — the Worker block follows the log and carries the actor, its parent
// and the coordinate this packet's response becomes; the packet carries no date, time or zone.
import assert from "node:assert/strict";
import test from "node:test";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection } from "./_helpers.ts";
import { provider } from "./reasoning-fixture.ts";

test("{§packet-current-turn}: the Worker block follows the log with path, parent, loop and turn, and nothing dated", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-worker-block");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const packet = await packets.buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: 3, provider: provider(), gitStatus: null,
        });
        const block = JSON.parse(packetSection(packet, "worker")) as { path: string; parent: string | null; loop: number; turn: number };
        assert.match(block.path, /^worker:\/\//);
        assert.equal(block.parent, null, "a root worker states parent: null");
        assert.deepEqual([block.loop, block.turn], [1, 3], "the coordinate this packet's response becomes");
        assert.deepEqual(Object.keys(block), ["path", "parent", "loop", "turn"], "the block carries nothing else: no date, time or zone");
        const user = packet.sections.filter(({ slot }) => slot === "user").map(({ name }) => name);
        assert.equal(user.indexOf("worker"), user.indexOf("log") + 1, "the Worker block is the first section after the log");
        assert.equal(user[0], "log", "nothing volatile precedes the log");
        const rendered = PacketWire.renderSlot(packet.sections, "user");
        assert.ok(rendered.indexOf("## Log") < rendered.indexOf("## Worker"), "on the wire the Worker block is below the log");
        assert.doesNotMatch(rendered, /## Turn/);
        assert.doesNotMatch(rendered, /"date"|"timezone"|\d{4}-\d{2}-\d{2}T/, "no date, time or zone anywhere in the user slot");
        assert.doesNotMatch(PacketWire.renderSlot(packet.sections, "system"), /\d{4}-\d{2}-\d{2}/, "nor in the system slot");
    } finally { await db.close(); }
});
