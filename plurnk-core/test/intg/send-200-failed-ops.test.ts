// §send-200-failed-ops (#363, owner ruling) — a run must not conclude 200 over a failed op.
// A turn's failures (op results >= 400, this emission's parse errors) are UNSEEN until the next
// packet; a same-turn SEND[200] is refused 409 (weigh, then conclude), SEND[499] is never gated,
// and the gate judges only the current turn (no re-arm on its own refusal).
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("[§send-200-failed-ops] a failed op + SEND[200] same turn → 409; the NEXT turn's [200] concludes", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // KILL of a nonexistent entry → 404 (a failure that is NOT a retrieval, isolating this gate
        // from the retrievals leg); the same-turn [200] must be refused.
        makeMockResponse("<<PLAN:clean up then conclude:PLAN\n<<KILL(known:///no-such-entry)::KILL\n<<SEND[200]:done:SEND", 10),
        // Next turn: the 404 is in-log and weighed; concluding now is legitimate.
        makeMockResponse("<<PLAN:the KILL 404d — nothing to clean; concluding:PLAN\n<<SEND[200]:done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "failgate" });
            const { finalStatus, turnIds = [] } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { yolo: true } });
            assert.equal(finalStatus, 200, "the loop concluded on the SECOND turn, failures weighed");
            assert.equal(turnIds.length, 2, "exactly two turns — the refusal forced one weigh turn, no more");
            await flush();
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: 2 });
            const sends = (rows ?? []).filter((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 409, "the first [200] was refused over the unseen failure");
            assert.match(sends[0]?.rx ?? "", /failed operation/, "the refusal names the failure, not a generic error");
        } finally { ws.close(); }
    });
});

test("[§send-200-failed-ops] this emission's PARSE errors gate the same-turn [200] (they mint as rows only after dispatch)", async () => {
    // makeMockResponse pre-parses (ops:) and the engine SKIPS parsing pre-parsed responses — so
    // the parse-error leg needs a CONTENT-ONLY response the engine parses for real. An unclosed
    // body (the truncation shape) yields an unparsedTail parse error while the terminal SEND
    // still parses; the count is threaded pre-dispatch — the [200] must not conclude past it.
    const rawResponse = (content: string) => ({
        assistant: { content, reasoning: null, usage: { prompt: 0, completion: 10, reasoning: 0, cached: 0, total: 10 } },
        assistantRaw: null,
    });
    const mock = new Mock({ contextWindow: 16384, responses: [
        rawResponse("<<PLAN:do the thing:PLAN\n<<SEND[200]:done:SEND\n<<EDIT(known:///notes.md):opened but never closed"),
        rawResponse("<<PLAN:the op was malformed — concluding having seen the error:PLAN\n<<SEND[200]:done:SEND"),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "parsegate" });
            const { finalStatus, turnIds = [] } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { yolo: true } });
            assert.equal(finalStatus, 200);
            assert.ok(turnIds.length >= 2, "the parse error forced a weigh turn before concluding");
            await flush();
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; origin: string; status_rx: number }>({ loop_id: 2 });
            const sends = (rows ?? []).filter((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 409, "the emission with a parse error cannot conclude 200");
        } finally { ws.close(); }
    });
});

test("[§send-200-failed-ops] SEND[499] over a same-turn failure abandons unimpeded — declaring failure IS weighing it", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<PLAN:abort:PLAN\n<<KILL(known:///no-such-entry)::KILL\n<<SEND[499]:giving up:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "abandon" });
            const { finalStatus, turnIds = [] } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { yolo: true } });
            assert.equal(finalStatus, 499, "the abandon went through in ONE turn — 499 is never gated");
            assert.equal(turnIds.length, 1);
        } finally { ws.close(); }
    });
});
