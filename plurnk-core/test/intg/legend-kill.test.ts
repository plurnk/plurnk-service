// Trial (#1073): an emission row's legend lines are its turn's NOTEs; a line scope aimed at the
// row retires the NOTEs on those lines, and the replayed turn follows.
import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

test("a KILL of legend line 1 retires that NOTE: the legend, the replay and the log all drop it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `legend-kill-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Look around.");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            "```NOTE\nFirst finding.\n```\n\n```NOTE\nSecond finding.\n```\n\n```FIND (worker:///*)\n```",
            "```NOTE\nRetiring the first.\n```\n\n```KILL (log:///1/2/2/emission) <1>\n```",
            "```SEND [200]\nDone.\n```",
        ].map((content) => ({ assistant: { content, reasoning: null, finishReason: "stop" } })) });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
        });
        assert.equal(result.result.status, 200);
        const [, noted, killed, final] = result.turnIds;
        const packetOf = async (turnId: number) => JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: turnId }))!.packet) as { sections: Parameters<typeof PacketWire.renderSlot>[0] };
        const before = await packetOf(killed!);
        const beforeUser = PacketWire.renderSlot(before.sections, "user");
        assert.match(beforeUser, /### log:\/\/\/1\/2\/2\/emission[^\n]*\n1:log:\/\/\/1\/2\/3\/NOTE · \d+\n2:log:\/\/\/1\/2\/4\/NOTE · \d+/u, `the legend names both NOTEs:\n${beforeUser}`);
        assert.match(PacketWire.renderSlot(before.sections, "assistant"), /First finding\.[\s\S]*Second finding\./u);
        const after = await packetOf(final!);
        const afterUser = PacketWire.renderSlot(after.sections, "user");
        assert.match(afterUser, /### log:\/\/\/1\/2\/2\/emission[^\n]*\n1:log:\/\/\/1\/2\/4\/NOTE · \d+\n\n/u, `the legend keeps only the second NOTE:\n${afterUser}`);
        const killRows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: killed! });
        assert.ok(killRows.some(({ op, rx }) => op === "KILL" && /"status":200/u.test(rx)), `the KILL landed 200: ${JSON.stringify(killRows.map(({ op, rx }) => [op, rx.slice(0, 120)]))}`);
        const afterAssistant = PacketWire.renderSlot(after.sections, "assistant");
        assert.doesNotMatch(afterAssistant, /First finding\./u, "the retired NOTE left the replay");
        assert.match(afterAssistant, /Second finding\./u, "the other NOTE stays");
        assert.doesNotMatch(afterUser, /First finding\./u, "and it is not a bodied row either");
    } finally { await db.close(); }
});
