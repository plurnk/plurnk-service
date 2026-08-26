// {§exec-stream} {§exec-stream-page} — an active stream reaches the model only as a Child Streams
// pointer with its size and growth; at close, ONE foisted READ that is exactly a markerless READ:
// the first page, the extent, the terminal status. The channel keeps every line for a scoped READ.

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETRIEVAL_LIMIT } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { logEntries, packetSection } from "./_helpers.ts";

const withSettlement = async (ms: string, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = ms;
    try {
        await fn();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
};

test("a 40-line stream closes as its first page with the extent; a scoped READ still reaches line 40", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("## EXEC0 [sh]\nseq 1 40\n\n## SEND0 [202]\nwaiting", 10),
            makeMockResponse("## READ0 (sh:///1/2/3#stdout) <38,40>\n## SEND0 [102]\nreading the tail", 10),
            makeMockResponse("## SEND0 [200]\ndone", 10),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-stream-page" });
            const { finalStatus, turnIds, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "count", flags: { auto: true } });
            const turn2 = turnIds![2]!;
            const rows = await db.test_log_entries_by_turn.all<{ scheme: string; op: string; origin: string; fragment: string | null; rx: string }>({ turn_id: turn2 });
            const foisted = rows.find((r) => r.scheme === "sh" && r.op === "READ" && r.origin === "_plurnk" && r.fragment === "stdout");
            assert.ok(foisted, "the stream's terminal observation was foisted");
            const rx = JSON.parse(foisted.rx) as { content: string; mimetype: string; startLine: number; range: { unit: string; total: number; returned: [number, number] } };
            assert.equal(rx.content.split("\n").filter((l) => l !== "").length, DEFAULT_RETRIEVAL_LIMIT, "exactly the retrieval page");
            assert.equal(rx.content.startsWith("1\n2\n"), true, "the page is the FIRST page — a markerless READ");
            assert.equal(rx.startLine, 1);
            assert.deepEqual(rx.range, { unit: "line", total: 40, requested: [1, 16], returned: [1, 16] });
            assert.equal(rx.mimetype, "text/stream", "the channel's own mimetype, as a markerless READ keeps it");
            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow!.packet);
            const log = packetSection(packet, "log");
            assert.match(log, /\s1:1\n/, "line 1 is delivered");
            assert.doesNotMatch(log, /\s40:40\n/, "line 40 is not delivered unasked");
            assert.ok(logEntries(packet).some((e) => String(e.path).endsWith("/READ") && String(e.target ?? "").includes("stdout")));
            assert.equal(finalStatus, 200, "the scoped READ turn concluded");
            const read = await db.test_get_log_rx_by_worker_op.get<{ rx: string }>({ worker_id: modelWorkerId, op: "READ" });
            const asked = JSON.parse(read!.rx) as { content: string; startLine: number };
            assert.equal(asked.content, "38\n39\n40", "the channel keeps every line for a scoped READ");
            assert.equal(asked.startLine, 38);
        } finally {
            ws.close();
        }
    }));
});

test("an active stream reaches the model only as a Child Streams pointer with its size and growth", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("## EXEC0 [sh]\nseq 1 5; sleep 2\n\n## SEND0 [102]\nlet it run", 10),
            // the stream is still running when this packet is built: only the pointer shows it
            makeMockResponse("## SEND0 [202] <10>\nwait for it", 10),
            makeMockResponse("## SEND0 [200]\ndone", 10),
        ],
    });
    await withSettlement("200", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-stream-ambient" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run", flags: { auto: true } }, { timeoutMs: 20_000 });
            assert.equal(finalStatus, 200);
            const turn2 = turnIds![2]!;
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn2 }))!.packet);
            const pointers = packetSection(packet, "child-streams");
            assert.match(pointers, /\* active sh:\/\/\/1\/2\/3 — .*stdout 5 lines \(\+\d+ bytes\)/, "the pointer carries size and growth");
            const log = packetSection(packet, "log");
            assert.doesNotMatch(log, /"target":"sh:\/\/\/1\/2\/3#stdout"/, "nothing of the stream enters the Log while it is active");
        } finally {
            ws.close();
        }
    }));
});
