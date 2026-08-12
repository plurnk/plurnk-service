// {§tools-loop-affinity} When no exec runtime is active, the capability sheet
// says EXEC is disabled instead of implying availability by silence.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import { packetSection } from "./_helpers.ts";

const answer = () => new Mock({ contextWindow: 16384, responses: [makeMockResponse("## SEND1 [200]\nthe answer is 4", 10)] });

test("{§tools-loop-affinity}: ask mode states that EXEC is disabled", async () => {
    await withDaemon(answer(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ask-disabled-line" });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "what is 2+2?", flags: { mode: "ask" } });
            const turn = await db.test_first_turn_for_loop.get<{ packet: string }>({ loop_id: loopId });
            assert.match(turn!.packet, /EXEC operations are disabled for this loop/, "the disabled line rides the sheet");
            assert.match(turn!.packet, /answer or advise directly/, "and names the alternative");
        } finally { ws.close(); }
    });
});

test("act mode: no disabled line — the runtimes advertise normally", async () => {
    await withDaemon(answer(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "act-no-line" });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "what is 2+2?" });
            const turn = await db.test_first_turn_for_loop.get<{ packet: string }>({ loop_id: loopId });
            assert.doesNotMatch(turn!.packet, /EXEC operations are disabled/, "act mode never carries the negative line");
            // {§packet-operation-fences} Executor examples use the packet's operation fence.
            const packet = JSON.parse(turn!.packet) as { sections?: Array<{ name?: string; header?: string }> };
            const tools = packetSection(packet as Parameters<typeof packetSection>[0], "tools");
            assert.match(tools, /^```plurnk\n## EXEC1/, "act mode: executor examples advertise inside a plurnk fence, not bullets");
            assert.equal(packet.sections?.find((section) => section.name === "tools")?.header, "Registered Executable Tools");
        } finally { ws.close(); }
    });
});
