// Regression guard for the live/demo exec failure: a model workers an EXEC, the
// entry is created in the DB — but its result must also surface in the NEXT
// turn's LOG (the EXEC log row links its output via stream=<runtime>:///<coord>),
// or the model is blind to its own output and loops forever. The bug only manifested in the
// e2e tier (model-in-loop); this reproduces it deterministically with a Mock
// model driven through the REAL prod loop — loop.run via the daemon, the same
// packet assembly + doc materialization production runs — so the guard exercises
// the exact path the live/demo failure took, not a hand-built engine fork.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import { logEntries, packetSection } from "./_helpers.ts";

test("[§exec-stream] regression: a model's EXEC result surfaces in the NEXT turn's log, not just the DB", async () => {
    // Turn 1: EXEC + SEND[102] (continue). Turn 2: SEND[200] (terminate). The
    // exec result created in turn 1 must appear in turn 2's packet log so the
    // model can READ it — assert the ENGINE put a <runtime>:///<coord> stream link there.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("<<EXEC[sh]:echo plurnk-index-probe:EXEC\n<<SEND[102]:running:SEND", 10),
        makeMockResponse("<<SEND[200]:done:SEND", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-surface" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run a command", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "loop terminates on the turn-2 SEND[200]");
            assert.ok((turnIds?.length ?? 0) >= 2, `expected at least 2 turns; got ${turnIds?.length}`);

            const turn2 = turnIds![1];
            const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(row?.packet ?? "{}");
            const entries = logEntries(packet);
            assert.ok(
                entries.some((e) => String(e.stream ?? "").startsWith("sh:///")),
                `turn-2 log must link the exec result via stream=; got ${JSON.stringify(entries.map((e) => e.stream))}`,
            );
            // §exec-stream — the environment-observation machine foists a READ of the exec stream
            // into the NEXT turn (origin=plurnk), OPEN because the channel closed: the model SEES
            // its output, it never has to find+pull it. This is the loop the live demo exposed.
            assert.ok(
                entries.some((e) => e.op === "READ" && e.origin === "plurnk" && String(e.target ?? "").includes("stdout")),
                `turn-2 must foist a READ of the exec stdout; got ${JSON.stringify(entries.map((e) => ({ op: e.op, origin: e.origin, target: e.target })))}`,
            );
            assert.match(packetSection(packet, "log"), /plurnk-index-probe/, "the foisted delta surfaces the actual stdout, open");
        } finally { ws.close(); }
    });
});

test("[§exec-stream] the cursor-terminal race: a one-burst stream fully shown FOLDED before its close still gets an OPEN terminal delta", async () => {
    // The owner's dogfood find (the search digest): a channel written in one final burst is
    // fully shown (folded) on an interim turn while still ACTIVE; the close arrives with zero
    // new bytes, and the auto-OPEN terminal never fired — the model never saw the stream
    // conclude. Turn 1: EXEC a slow-close command + [102]. Turn 2 (stream active, content
    // complete): the delta shows folded. Turn 3 (closed, nothing new): the terminal marker
    // MUST land, open, carrying the close status — never a silent skip.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("<<EXEC[sh]:echo burst-payload && sleep 2:EXEC\n<<SEND[102]:spawned:SEND", 10),
        makeMockResponse("<<SEND[102]:waiting:SEND", 10),
        makeMockResponse("<<SEND[102]:checking:SEND", 10),
        makeMockResponse("<<SEND[200]:done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "cursor-terminal" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run it", flags: { yolo: true } });
            assert.equal(finalStatus, 200);
            const last = turnIds![turnIds!.length - 1];
            const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: last });
            const packet = JSON.parse(row?.packet ?? "{}");
            const entries = logEntries(packet);
            const deltas = entries.filter((e) => e.op === "READ" && e.origin === "plurnk" && String(e.target ?? "").includes("stdout"));
            assert.ok(deltas.length >= 1, "the stream's deltas surfaced");
            const log = packetSection(packet, "log");
            assert.match(log, /burst-payload/, "the burst content was delivered");
            assert.match(log, /stream closed \(200\)/, "the OPEN terminal marker landed even though the close brought zero new bytes — the model SEES the conclusion");
        } finally { ws.close(); }
    });
});
