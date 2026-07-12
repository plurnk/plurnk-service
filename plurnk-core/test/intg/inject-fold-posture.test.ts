// #368 — flags are LOOP-scoped; a prompt folding into a live loop can't re-flag it mid-flight and
// must never PRETEND to. An inject whose flags DIFFER from the target loop's is refused legibly
// (the TUI's `? ask` against a running act loop gets an error, not a silently-act'd question);
// identical or absent flags fold clean.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, subscribeNotifications, waitFor, runLoopToTerminal } from "./_rpc.ts";

const heldLoopMock = () => new Mock({ contextSize: 16384, responses: [
    // A non-yolo EXEC proposal holds loop 1 live (paused at the review) while injects arrive.
    makeMockResponse("<<PLAN:hold:PLAN\n<<EXEC[sh]:echo hold:EXEC\n<<SEND[102]:working:SEND", 10),
    makeMockResponse("<<SEND[200]:done:SEND", 10),
    makeMockResponse("<<SEND[200]:done again:SEND", 10),
] });

test("inject with flags DIFFERING from the live loop's is refused — never a silent posture discard (#368)", async () => {
    await withDaemon(heldLoopMock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "posture-conflict" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "start working", flags: { yolo: false } });
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            // Loop 1 is live (held at the proposal). An ask-mode prompt must not fold in as act.
            const conflicted = await rpcCall(ws, 3, "loop.run", { prompt: "? what is the plan", flags: { mode: "ask" } });
            assert.ok(conflicted.error, "the posture-changing fold is refused");
            assert.match(conflicted.error!.message, /flags are loop-scoped/, "the refusal names the contract");
            assert.match(conflicted.error!.message, /loop\.cancel|without flags/, "the refusal names the remedy");
        } finally { ws.close(); }
    });
});

test("inject with MATCHING or ABSENT flags folds into the live loop untouched (#368)", async () => {
    await withDaemon(heldLoopMock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "posture-match" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "start working", flags: { yolo: false } });
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });
            const matching = await rpcCall(ws, 3, "loop.run", { prompt: "also do this", flags: { yolo: false } });
            assert.equal((matching.result as { action: string }).action, "injected_next_turn", "identical flags fold clean");
            const bare = await rpcCall(ws, 4, "loop.run", { prompt: "and this" });
            assert.equal((bare.result as { action: string }).action, "injected_next_turn", "absent flags adopt the loop's posture");
            // Release the held proposal so teardown reaps a settled world.
            const pending = proposals() as Array<{ logEntryId: number }>;
            await rpcCall(ws, 5, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
            await runLoopToTerminal(ws, 6, { prompt: "wrap up", flags: { yolo: false } }).catch(() => {});
        } finally { ws.close(); }
    });
});
