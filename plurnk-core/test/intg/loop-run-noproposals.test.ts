// Server-side noProposals wire path — the inverse of loop-run-auto.test.ts.
// loop.run accepts flags.noProposals; the in-tree noProposals.ts listener
// reads ProposalPendingEvent.flags and auto-REJECTS in-process without any
// client loop.resolve. The model sees an ordinary 400 (the action did NOT
// occur), NEVER the orchestration reason and NEVER a "scheme inactive" gate.
// Proposal handling stays invisible to the model: the outcome reason is
// forensics-only, so a noProposals reject is indistinguishable from a human
// declining.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { rpcCall, rpcProblem, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

// Minimal always-proposing scheme (mirrors loop-run-auto.test.ts). Returns
// 202 so the proposal lifecycle fires from a full Daemon RPC roundtrip.
class ProposingTest {
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
    };
    async editBatch(): Promise<{ status: number; attrs: object; body: string }> {
        return { status: 202, body: "--- proposed\n+++ proposed", attrs: { target: "/proposed" } };
    }
}

test("loop.run flags.noProposals=true: in-tree listener auto-rejects — model sees 400 (didn't occur), not a 403 gate", async () => {
    // Model emits EDIT against the proposing scheme (202), then SEND[200].
    // With noProposals on, the proposal auto-rejects in-process; the EDIT
    // lands as status 400 (action did NOT occur) — identical to a human
    // declining — NOT a 403 "scheme inactive under current loop flags".
    // The model knows WHETHER (400) without learning HOW (the orchestration).
    // §send-200-failed-ops: the rejection is a same-turn unseen failure, so the
    // first [200] is refused; the loop concludes NEXT turn, the 400 weighed.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<EDIT(proposing-test://x):y:EDIT\n<<SEND[200]:done:SEND", 50),
        makeMockResponse("<<SEND[200]:the edit was declined; concluding:SEND", 50),
    ] });

    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "noproposals-resolve" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal", flags: { noProposals: true },
            });
            assert.equal(result.result.status, 200, "loop concludes on the SECOND [200], the rejection weighed (§send-200-failed-ops)");

            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string }>({ loop_id: result.loopId });
            const edit = rows.find((r) => r.op === "EDIT" && r.scheme === "proposing-test");
            assert.ok(edit !== undefined, "proposing-test EDIT log entry expected");
            assert.equal(edit!.status_rx, 400,
                "auto-rejected to 400 via the proposal lifecycle (action didn't occur), NOT gated to 403");
        } finally { ws.close(); }
    });
});

test("loop.run rejects non-boolean flags.noProposals", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "bad-noproposals" });
            const response = await rpcCall(ws, 2, "loop.run", {
                prompt: "test", flags: { noProposals: "nope" },
            });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/input/loop-flag-invalid");
            assert.equal(problem.field, "flags.noProposals");
            assert.equal(problem.retryable, false);
        } finally { ws.close(); }
    });
});
