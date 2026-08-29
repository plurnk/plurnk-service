// {§send-target-recipient} — a SEND addressed to a non-recipient (the prompt itself) is refused
// with the form named, not the writer rule; the next turn's target-less reply concludes.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("SEND [200] addressed to the prompt is refused 400 naming the target-less reply and the recipient form", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("## SEND0 [200] (prompt:///1/1)\nthe answer", 10),
        makeMockResponse("## SEND0 [200]\nthe answer", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "answer me", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the target-less reply concluded on the second turn");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 400, "the directed SEND was refused 400, not 403");
            const problem = (JSON.parse(sends[0]!.rx) as { problem?: Record<string, unknown> }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/send-target-not-a-recipient");
            assert.equal(problem?.detail, "`## SEND0 [200]` answers the active prompt with no target.");
            assert.match(String(problem?.recovery), /`## SEND0 \(worker:\/\/<name>\)`/);
            assert.match(String(problem?.recovery), /\[410\]/);
            assert.ok(!sends.some((r) => r.status_rx === 403), "the writer rule never speaks first");
            assert.equal(sends[1]?.status_rx, 200);
        } finally { ws.close(); }
    });
});

test("SEND [102] addressed to a file path answers 501 carrying the same recovery", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("## SEND0 [102] (.)\nwaiting", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target-file" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const first = rows.filter((r) => r.op === "SEND" && r.origin === "model")[0];
            assert.equal(first?.status_rx, 501);
            assert.match(String((JSON.parse(first!.rx) as { problem?: { recovery?: string } }).problem?.recovery), /answers the active prompt with no target/);
        } finally { ws.close(); }
    });
});
