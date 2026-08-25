// {§exec-stream-tail} — the foisted stream READ publishes only the LAST page of a long segment,
// typed as text with its channel-absolute extent; the channel keeps every line for a scoped READ.

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETRIEVAL_LIMIT } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { logEntries, packetSection } from "./_helpers.ts";

test("a 40-line stream reaches the model as its last 16 lines with the extent; a scoped READ still reaches line 1", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("## EXEC0 [sh]\nseq 1 40\n\n## SEND0 [202]\nwaiting", 10),
            makeMockResponse("## READ0 (sh:///1/2/3#stdout) <1,3>\n## SEND0 [102]\nreading the head", 10),
            makeMockResponse("## SEND0 [200]\ndone", 10),
        ],
    });
    await withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-stream-tail" });
            const { finalStatus, turnIds, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "count", flags: { auto: true } });
            const turn2 = turnIds![2]!;
            const rows = await db.test_log_entries_by_turn.all<{ scheme: string; op: string; origin: string; fragment: string | null; rx: string }>({ turn_id: turn2 });
            const foisted = rows.find((r) => r.scheme === "sh" && r.op === "READ" && r.origin === "_plurnk" && r.fragment === "stdout");
            assert.ok(foisted, "the stream's terminal observation was foisted");
            const rx = JSON.parse(foisted.rx) as { content: string; mimetype: string; startLine: number; range: { unit: string; total: number; returned: [number, number] } };
            assert.equal(rx.content.split("\n").filter((l) => l !== "").length, DEFAULT_RETRIEVAL_LIMIT, "only the last page is published");
            assert.equal(rx.content.startsWith("25\n"), true, "the page is the TAIL");
            assert.equal(rx.startLine, 25);
            assert.deepEqual(rx.range, { unit: "line", total: 40, requested: [25, 40], returned: [25, 40] });
            assert.equal(rx.mimetype, "text/markdown", "a partial projection is text, as a scoped READ's is");
            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow!.packet);
            const log = packetSection(packet, "log");
            assert.match(log, /40:40\b/, "the conclusion of the stream is what the model sees");
            assert.doesNotMatch(log, /\n1:1\n/, "line 1 of the stream is not delivered unasked");
            const entry = logEntries(packet).find((e) => String(e.path).endsWith("/READ") && String(e.target ?? "").includes("stdout"));
            assert.ok(entry, "the packet carries the foisted READ");
            assert.equal(finalStatus, 200, `the scoped READ turn concluded; stream was ${String(entry.target)}`);
            const read = await db.test_get_log_rx_by_worker_op.get<{ rx: string }>({ worker_id: modelWorkerId, op: "READ" });
            const asked = JSON.parse(read!.rx) as { content: string; startLine: number };
            assert.equal(asked.content, "1\n2\n3", "the channel keeps every line for a scoped READ");
            assert.equal(asked.startLine, 1);
        } finally {
            ws.close();
        }
    });
});
