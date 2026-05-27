// Wake-on-completion daemon decision tree (E.4). When a streaming-scheme
// subscription closes, Daemon.#handleWakeRun decides one of:
//   - "skipped-aborted" when closeStatus=499 (don't resurrect a cancel)
//   - "no-op-active-loop" when the run still has an active loop
//   - "opened-loop" when the run is dormant — daemon opens a new loop
//     with the synthetic summary as prompt so the model can react
//
// These tests run real daemon + real exec + real Mock provider end-to-end.
// They consume the `stream/concluded` notification (NOT in the WS surface
// for clients to ignore — it's a load-bearing wire event).

import test from "node:test";
import assert from "node:assert/strict";
import Mock from "../../src/providers/Mock.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

const yoloEditExecDsl = (id: string, command: string): string =>
    `<<EDIT(exec://${id}):${command}:EDIT\n<<SEND[200]:done:SEND`;

const mockResponse = (dsl: string) => ({
    assistant: {
        content: dsl,
        reasoning: null,
        usage: { prompt: 0, completion: 0, cached: 0, total: 0 },
    },
    assistantRaw: null,
});

test("wake-on-completion: dormant run → daemon opens a new loop with the summary prompt", async () => {
    // First loop: EDIT(exec://greet, "echo hi") + SEND[200] to terminate the loop
    // immediately. The exec spawn runs async after the loop ends. Daemon's
    // wake handler should detect "no active loop in this run" and open a
    // fresh loop whose user prompt is the synthetic summary.
    //
    // Second loop (the wake-opened one): the mock's second response just
    // emits SEND[200] (the model "reads the situation and ends").
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            mockResponse(yoloEditExecDsl("greet", "echo hi")),
            mockResponse("<<SEND[200]:saw the wake:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "exec-wake-dormant" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");
            const terminatedEvents = subscribeNotifications(ws, "loop/terminated");

            await rpcCall(ws, 2, "loop.run", { prompt: "kick off exec then end", flags: { yolo: true } });

            // The spawn (`echo hi`) is fast; wake fires after the loop ends;
            // daemon opens a second loop; that loop terminates on its own.
            // Allow generous time for both to finish.
            await new Promise((r) => setTimeout(r, 800));

            const concluded = concludedEvents() as Array<{
                scheme: string; closeStatus: number; summary: string;
                wakeAction: string; wakeLoopId?: number;
            }>;
            assert.ok(concluded.length >= 1, `expected >=1 stream/concluded event, got ${concluded.length}`);
            const wake = concluded.find((c) => c.scheme === "exec");
            assert.ok(wake, "exec stream concluded");
            assert.equal(wake.closeStatus, 200);
            assert.match(wake.summary, /exec:\/\/greet completed \(exit 0\)/);
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
    // STAYS active across multiple turns. The exec finishes mid-loop;
    // wake should see active loop and skip.
    //
    // We give the loop 5 turns of just-continue ops; the exec is `echo
    // soon` which finishes in milliseconds, so the wake fires while the
    // loop is mid-iteration. On the final turn, SEND[200].
    const continueResponse = mockResponse("<<SEND[102]:thinking:SEND");
    const mock = new Mock({
        contextSize: 8192,
        responses: [
            mockResponse(yoloEditExecDsl("active", "echo soon").replace("SEND[200]", "SEND[102]")),
            continueResponse,
            continueResponse,
            continueResponse,
            mockResponse("<<SEND[200]:done:SEND"),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
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

test("wake-on-completion: SEND[499] cancel → daemon skips wake (skipped-aborted)", async () => {
    // Loop: emit a slow exec, then SEND[499](exec://x) to cancel, then SEND[200].
    // Wake fires with closeStatus=499; daemon's handler skips.
    const dsl = [
        "<<EDIT(exec://slow):sleep 30:EDIT",
        "<<SEND[499](exec://slow)::SEND",
        "<<SEND[200]:cancelled:SEND",
    ].join("\n");
    const mock = new Mock({
        contextSize: 8192,
        responses: [mockResponse(dsl)],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "exec-wake-cancelled" });
            const concludedEvents = subscribeNotifications(ws, "stream/concluded");

            await rpcCall(ws, 2, "loop.run", { prompt: "cancel mid-stream", flags: { yolo: true } });
            await flush();
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
