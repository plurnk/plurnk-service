// Wake-on-completion daemon decision tree (E.4). When an exec spawn
// concludes, Daemon.#handleWakeRun picks one of:
//   - "no-op-active-loop" — the run has a live drain on its current loop
//   - "opened-loop" — no active loop in the run; daemon enqueues a fresh
//     loop with the summary as the user prompt
//   - "skipped-aborted" — closeStatus=499 (deliberate cancel)
//
// These exercise the daemon end-to-end through real WS calls with a
// Mock provider. Mock emissions use the EXEC op per plurnk.md.

import test from "node:test";
import assert from "node:assert/strict";
import Mock from "../../src/providers/Mock.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

const execDsl = (command: string): string =>
    `<<EXEC[sh]:${command}:EXEC\n<<SEND[200]:done:SEND`;

const mockResponse = (dsl: string) => ({
    assistant: {
        content: dsl,
        reasoning: null,
        usage: { prompt: 0, completion: 0, cached: 0, total: 0 },
    },
    assistantRaw: null,
});

test("wake-on-completion: dormant run → daemon opens a new loop with the summary prompt", async () => {
    // First loop: EXEC echo + SEND[200] to terminate the loop immediately.
    // The exec spawn runs async after the loop ends. Daemon's wake handler
    // detects "no active loop in this run" and opens a fresh loop whose
    // user prompt is the synthetic conclusion summary.
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            mockResponse(execDsl("echo hi")),
            mockResponse("<<SEND[200]:saw the wake:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "exec-wake-dormant" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");
            const terminatedEvents = subscribeNotifications(ws, "loop/terminated");

            await rpcCall(ws, 2, "loop.run", { prompt: "kick off exec then end", flags: { yolo: true } });

            // echo hi is fast; wake fires after the loop ends; daemon
            // opens a second loop; that loop terminates on its own.
            await new Promise((r) => setTimeout(r, 800));

            const concluded = concludedEvents() as Array<{
                scheme: string; closeStatus: number; summary: string;
                wakeAction: string; wakeLoopId?: number;
            }>;
            assert.ok(concluded.length >= 1, `expected >=1 stream/concluded event, got ${concluded.length}`);
            const wake = concluded.find((c) => c.scheme === "exec");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.closeStatus, 200);
            assert.match(wake.summary, /^exec:\/\/r-[a-f0-9]+ completed \(exit 0\)/,
                "summary references the auto-generated exec://r-<uuid> path");
            assert.equal(wake.wakeAction, "opened-loop", "daemon opened a new loop because the original ended first");
            assert.ok(typeof wake.wakeLoopId === "number", "wakeLoopId is reported");

            // Wake-opened loop terminated too (mock's second response was SEND[200]).
            const terminated = terminatedEvents() as Array<{ loopId: number; finalStatus: number }>;
            assert.ok(terminated.some((t) => t.loopId === wake.wakeLoopId && t.finalStatus === 200),
                "wake loop terminated cleanly");
        } finally { ws.close(); }
    });
});

test("wake-on-completion: active loop → daemon does NOT open a new loop (no-op-active-loop)", async () => {
    // Loop emits exec + a SEND[102] continuation per turn — the loop
    // stays active across multiple turns. The exec finishes mid-loop;
    // wake should see active loop and skip.
    const continueResponse = mockResponse("<<SEND[102]:thinking:SEND");
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            mockResponse(execDsl("echo soon").replace("SEND[200]", "SEND[102]")),
            continueResponse,
            continueResponse,
            continueResponse,
            mockResponse("<<SEND[200]:done:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "exec-wake-active" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            await rpcCall(ws, 2, "loop.run", { prompt: "stay active during exec", flags: { yolo: true } });
            await flush();
            await new Promise((r) => setTimeout(r, 200));

            const concluded = concludedEvents() as Array<{ scheme: string; wakeAction: string }>;
            const wake = concluded.find((c) => c.scheme === "exec");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.wakeAction, "no-op-active-loop",
                "wake declined to open a new loop because the original was still active");
        } finally { ws.close(); }
    });
});

test("wake-on-completion: streaming spawn outlives loop — wake summary reports the FULL final byte count, not what was buffered at loop-end", async () => {
    // A countdown emits 5 lines over ~2.5s. The model SEND[200]s
    // immediately, so the loop closes well before the spawn finishes.
    // When the spawn DOES finish, wake fires with closeStatus=200 and
    // a summary that reflects the COMPLETE stdout (10 bytes for
    // "5\n4\n3\n2\n1\n") — proving the streaming continued past the
    // loop's terminal status and the conclusion is the final state,
    // not a partial snapshot.
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            mockResponse(`<<EXEC[sh]:for i in 5 4 3 2 1; do echo $i; sleep 0.4; done:EXEC\n<<SEND[200]:fire and forget:SEND`),
            // Wake-opened loop just terminates so the test completes:
            mockResponse("<<SEND[200]:saw the wake:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "exec-wake-streaming" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            const startedAt = Date.now();
            const firstResp = await rpcCall(ws, 2, "loop.run", { prompt: "stream while I leave", flags: { yolo: true } });
            const firstResult = firstResp.result as { finalStatus: number };
            const firstElapsed = Date.now() - startedAt;
            assert.equal(firstResult.finalStatus, 200, "first loop terminates cleanly on SEND[200]");
            // The loop's RPC should return well before the spawn's ~2.5s
            // — the wake-on-completion path is what handles the spawn's
            // late conclusion, not the original loop.
            assert.ok(firstElapsed < 1500,
                `first loop returns before the spawn finishes (~2.5s); got ${firstElapsed}ms`);

            // Now wait for the spawn to conclude + wake to fire + wake loop to terminate.
            await new Promise((r) => setTimeout(r, 3500));

            const concluded = concludedEvents() as Array<{
                scheme: string; closeStatus: number; summary: string; wakeAction: string;
            }>;
            const wake = concluded.find((c) => c.scheme === "exec" && c.closeStatus === 200);
            assert.ok(wake, "exec stream concluded");
            // The KEY assertion: summary has the FULL byte count, not
            // whatever happened to be in the channel when loop ended.
            assert.match(wake.summary, /stdout=10 bytes/,
                `summary should report the full final stdout=10 bytes ("5\\n4\\n3\\n2\\n1\\n"); got ${wake.summary}`);
            assert.equal(wake.wakeAction, "opened-loop");
        } finally { ws.close(); }
    });
});

test("wake-on-completion: loop.cancel mid-spawn → daemon skips wake (skipped-aborted)", async () => {
    // Slow exec; loop.cancel RPC fires the drain controller; spawn aborts
    // with closeStatus=499; daemon's handler skips opening a wake loop.
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            mockResponse(`<<EXEC[sh]:sleep 30:EXEC\n<<SEND[102]:running:SEND`),
            mockResponse("<<SEND[200]:never:SEND"),
        ],
    });

    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "exec-wake-cancelled" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "cancel mid-stream", flags: { yolo: true } });
            await flush();
            await new Promise((r) => setTimeout(r, 250));

            await rpcCall(ws, 3, "loop.cancel", {});
            try { await loopPromise; } catch { /* cancelled */ }
            await new Promise((r) => setTimeout(r, 200));

            const concluded = concludedEvents() as Array<{ scheme: string; closeStatus: number; wakeAction: string }>;
            const wake = concluded.find((c) => c.scheme === "exec");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.closeStatus, 499);
            assert.equal(wake.wakeAction, "skipped-aborted",
                "deliberate cancellations don't resurrect into a wake loop");
        } finally { ws.close(); }
    });
});
