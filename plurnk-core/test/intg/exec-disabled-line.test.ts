// execs#24 (operator design) — when EVERY exec runtime is mode-excluded, the capability sheet
// carries a POSITIVE "EXEC operations are disabled" line: plurnk.md teaches EXEC as language, and
// silent absence measurably invites confabulated runtimes (the client's 5-probe: 500×3 on the
// omission-only stack). Core speaks it — only core knows the filtered set emptied.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import { packetSection } from "./_helpers.ts";

const answer = () => new Mock({ contextWindow: 16384, responses: [makeMockResponse("<<SEND[200]:the answer is 4:SEND", 10)] });

test("ask mode: the capability sheet says EXEC is disabled — positively, not by omission (execs#24)", async () => {
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
            // #441 — the capability sheet's op examples ride a `plurnk` fence, matching the Schemes catalog.
            const packet = JSON.parse(turn!.packet) as { sections?: Array<{ name?: string; header?: string }> };
            const tools = packetSection(packet as Parameters<typeof packetSection>[0], "tools");
            assert.match(tools, /^```plurnk\n<</, "act mode: executor examples advertise inside a plurnk fence, not bullets (#441)");
            assert.equal(packet.sections?.find((section) => section.name === "tools")?.header, "Registered Executable Tools");
        } finally { ws.close(); }
    });
});
