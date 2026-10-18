// Trial (#1073): text outside the fences is annotation the model wrote without its fence; it lands as a
// NOTE at its position, is frozen into the program as one, and draws no notice.
import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { packetSection } from "./_packet.ts";

test("prose before, between and after fences lands as NOTEs in order and is replayed in the model's voice", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `outside-notes-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Look around.");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            "Thinking out loud first.\n\n```FIND (worker:///*)\n```\n\nBetween the two.\n\n```FIND (worker:///*)\n```\n\nAnd a trailing remark.",
            "```SEND [200]\nDone.\n```",
        ].map((content) => ({ assistant: { content, reasoning: null, finishReason: "stop" } })) });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
        });
        assert.equal(result.result.status, 200, JSON.stringify(result.result));
        const [, prosed, final] = result.turnIds;
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: prosed });
        const notes = rows.filter(({ op, origin }) => op === "NOTE" && origin === "model").map(({ tx }) => (JSON.parse(tx) as { body: string }).body);
        assert.deepEqual(notes, ["Thinking out loud first.", "Between the two.", "And a trailing remark."], "each span is one NOTE row, in source order");
        assert.ok(!rows.some(({ op, origin }) => op === "error" && origin === "_plurnk"), "no error row");
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: final }))!.packet) as { sections: Parameters<typeof PacketWire.renderSlot>[0] };
        assert.equal(packetSection(packet, "notices"), "", "no outside-text and no missing-NOTE notice");
        const user = PacketWire.renderSlot(packet.sections, "user");
        assert.equal([...user.matchAll(/^### log:\/\/\/1\/2\/\d+\/NOTE · \d+/gmu)].length, 3, "each annotation retains its own receipt");
        assert.doesNotMatch(user, /Thinking out loud|Between the two|And a trailing remark/u, "receipts do not duplicate the annotations");
        const assistant = PacketWire.renderSlot(packet.sections, "assistant");
        assert.match(assistant, /```NOTE\nThinking out loud first\.\n```[\s\S]*```NOTE\nBetween the two\.\n```[\s\S]*```NOTE\nAnd a trailing remark\.\n```/u, `the replay carries them as NOTE fences:\n${assistant}`);
    } finally { await db.close(); }
});
