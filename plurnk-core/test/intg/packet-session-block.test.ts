// {§packet-current-turn} — the Session block follows the log and carries the actor, its parent, the
// coordinate this packet's response becomes and its owner with whether a person attends; the packet
// carries no date, time or zone.
import assert from "node:assert/strict";
import test from "node:test";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { packetSection } from "./_packet.ts";
import { provider } from "./reasoning-fixture.ts";

test("{§packet-current-turn}: the Session block follows the log with path, parent, loop, turn and owner, and nothing dated", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-session-block");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const packet = await packets.buildRequestPacket({
            initialMessages: [], workspaceId, sessionId, loopId, currentTurnSeq: 3, provider: provider(), gitStatus: null,
        });
        const block = JSON.parse(packetSection(packet, "session")) as { path: string; parent: string | null; loop: number; turn: number; owner: { address: string; interactive: boolean } };
        assert.match(block.path, /^session:\/\//);
        assert.equal(block.parent, null, "a root session states parent: null");
        assert.deepEqual([block.loop, block.turn], [1, 3], "the coordinate this packet's response becomes");
        assert.deepEqual(block.owner, { address: "_plurnk", interactive: false }, "a runtime-owned session is told that nobody attends its owner");
        assert.deepEqual(Object.keys(block), ["path", "parent", "loop", "turn", "owner"], "the block carries nothing else: no date, time or zone");
        const user = packet.sections.filter(({ slot }) => slot === "user").map(({ name }) => name);
        assert.ok(user.indexOf("session") > user.indexOf("log"), "the Session block sits in the status clump below the log");
        assert.equal(user[0], "log", "nothing volatile precedes the log");
        const rendered = PacketWire.renderSlot(packet.sections, "user");
        assert.ok(rendered.indexOf("## Log") < rendered.indexOf("## Session"), "on the wire the Session block is below the log");
        assert.doesNotMatch(rendered, /"date"|"timezone"|\d{4}-\d{2}-\d{2}T/, "no date, time or zone anywhere in the user slot");
        assert.doesNotMatch(PacketWire.renderSlot(packet.sections, "system"), /\d{4}-\d{2}-\d{2}/, "nor in the system slot");
    } finally { await db.close(); }
});
