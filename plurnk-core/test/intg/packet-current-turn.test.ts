// {§packet-current-turn} — the packet names the coordinate its response becomes, first in the
// status clump, so the model's own `reasoning:///L/T` and `ops:///L/T` need no guessing.
import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection } from "./_helpers.ts";
import { provider, statement } from "./reasoning-fixture.ts";

test("{§packet-current-turn}: the Turn line is the loop and turn sequence the packet opens, placed right after the log", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-current-turn");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 3);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const packet = await packets.buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: 7, provider: provider(), gitStatus: null,
        });
        assert.deepEqual(JSON.parse(packetSection(packet, "turn")), { loop: 3, turn: 7 });
        const names = packet.sections.map(({ name }) => name);
        assert.equal(names[names.indexOf("log") + 1], "turn", "first in the status clump, never before the log");
    } finally { await db.close(); }
});

test("{§packet-current-turn}: the coordinate on the packet is the one whose reasoning the model's READ resolves as its own", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-current-turn-own");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        const mock = provider("Own reasoning for this very turn.",
            `${PlurnkParser.frame("READ (reasoning:///1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`);
        const ran = await engine.runTurn({ ...context, provider: mock, messages: [] });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: ran.turnId });
        assert.equal(turn?.sequence, 2);
        const user = mock.received.at(-1)!.find((m) => m.role === "user")?.content;
        assert.ok(typeof user === "string", "the mock receives the user packet as text");
        assert.match(user, /## Turn\n\{"loop":1,"turn":2\}/, "the packet the model answered named turn 1/2");
        const own = await engine.look({ ...context, statement: statement("```READ (reasoning:///1/2) <1,-1>```") });
        assert.equal(own.status, 200);
        assert.ok("content" in own);
        assert.equal(own.content, "Own reasoning for this very turn.");
    } finally { await db.close(); }
});
