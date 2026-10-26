// {§packet-current-turn} — the Session block opens the footer and names the coordinate the
// packet's response becomes, so the model's own `reasoning://alice/L/T` and `ops://alice/L/T` need no guessing.
import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { packetSection } from "./_packet.ts";
import { provider, statement } from "./reasoning-fixture.ts";
import { userText } from "./_mock.ts";
import { clientRead } from "./_client-read.ts";

test("{§packet-current-turn}: the Session block carries the loop and turn sequence the packet opens, after log and continuity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-current-turn");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 3);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const packet = await packets.buildRequestPacket({
            initialMessages: [], workspaceId, sessionId, loopId, currentTurnSeq: 7, provider: provider(), gitStatus: null,
        });
        const block = JSON.parse(packetSection(packet, "session")) as { loop: number; turn: number; path: string };
        assert.deepEqual([block.loop, block.turn], [3, 7]);
        assert.match(block.path, /^session:\/\//);
        const names = packet.sections.map(({ name }) => name);
        assert.ok(names.indexOf("session") > names.indexOf("log"), "in the status clump, below the initial log");
    } finally { await db.close(); }
});

test("{§packet-current-turn}: the coordinate on the packet is the one whose reasoning the model's READ resolves as its own", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-current-turn-own");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const mock = provider("Own reasoning for this very turn.",
            `${PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`);
        const ran = await engine.runTurn({ ...context, provider: mock, messages: [] });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: ran.turnId });
        assert.equal(turn?.sequence, 2);
        const user = userText(mock.received.at(-1)!);
        assert.match(user, /## Session\n\{"path":"session:\/\/alice","parent":null,"loop":1,"turn":2,"owner":\{"address":"[^"]+","interactive":(?:true|false)\}\}/, "the packet the model answered named turn 1/2 and its owner in its Session block");
        assert.ok(user.indexOf("## Log") < user.indexOf("## Session"), "below the log");
        const own = await clientRead(engine, db, { ...context, statement: statement("````READ (reasoning://alice/1/2) <1,-1>````") });
        assert.equal(own.status, 200);
        assert.ok("content" in own);
        assert.equal(own.content, "Own reasoning for this very turn.");
    } finally { await db.close(); }
});
