import assert from "node:assert/strict";
import test from "node:test";
import StreamMock from "./_stream-mock.ts";
import { connect, makeMockResponse, makeRawMockResponse, rpcCall, runLoopToTerminal, waitForDb, withDaemon } from "./_rpc.ts";
import { executionAddress, packetSection } from "./_helpers.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";

test("{§exec-input}: the production loop sends stdin, waits for EOF completion, and observes the real result", async () => {
    const mock = new StreamMock({ contextWindow: 100_000, responses: [
        makeMockResponse("````node [{\"stdin\": \"open\"}]\nprocess.stdin.on(\"data\", d => process.stdout.write(\"received:\" + d));\n````\n\n````NOTE\nDeliver input to the process.\n````", 10),
        makeMockResponse("````SEND ($STREAM) [{\"eof\": true}]\ninput-witness\n````\n\n````WAIT\nObserve the output.\n````", 10),
        makeMockResponse("````SEND\nVerified the process response.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, address) => {
        const client = await connect(address);
        try {
            await rpcCall(client, 1, "workspace.create", { name: "stdin-composition" });
            const result = await runLoopToTerminal(client, 2, { prompt: "Exchange input with the process.", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200);
            assert.equal(result.turnIds?.length, 4);
            const inputRows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: result.turnIds![2]! });
            const delivered = inputRows.find((row) => row.op === "SEND");
            assert.equal(delivered?.status_rx, 200);
            assert.match(delivered?.rx ?? "", /"bytesAccepted":13/);
            const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds![3]! });
            assert.match(packetSection(JSON.parse(packet!.packet), "log"), /13 bytes delivered to stdin; input closed\./,
                "the model sees delivery and EOF facts, not only a copy of its authored input");
            assert.match(packetSection(JSON.parse(packet!.packet), "log"), /received:input-witness/,
                "the actual process output reaches the model through ordinary stream observation");
        } finally { client.close(); }
    });
});

for (const failure of ["operation", "parser"] as const) {
    test(`{§wait-obligation-matrix}: a fresh ${failure} failure recovers before automatically parking an input-open process`, async () => {
        const prefix = failure === "parser"
            ? "Starting the input exchange.\n\n"
            : "````SEND\nStarting the input exchange.\n````\n\n````READ (worker:///missing)\n````\n\n";
        const mock = new StreamMock({ contextWindow: 100_000, responses: [
            makeRawMockResponse(`${prefix}\`\`\`\`node [{"stdin":"open"}]\nlet input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => console.log("received:" + input));\n\`\`\`\``),
            makeMockResponse("````SEND ($STREAM) [{\"eof\":true}]\nrecovery-witness\n````\n\n````WAIT\nObserve the response.\n````"),
            makeMockResponse("````SEND\nVerified recovery-witness in the process response.\n````"),
        ] });
        await withDaemon(mock, async (db, _daemon, address) => {
            const client = await connect(address);
            try {
                await rpcCall(client, 1, "workspace.create", { name: `stdin-recovery-${failure}` });
                const result = await runLoopToTerminal(client, 2, {
                    prompt: "Exchange input with the process and verify its response.",
                    policy: { proposals: "accept" },
                });
                assert.equal(result.finalStatus, 200);
                assert.equal(result.turnIds?.length, 4);
                const failedTurn = result.turnIds![1]!;
                assert.equal((await db.test_get_turn_status.get<{ status: number }>({ id: failedTurn }))?.status, 102,
                    "the failing turn continues immediately instead of relying on a stream poll or external wake");
                const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: failedTurn });
                assert.ok(rows.some((row) => failure === "parser"
                    ? row.op === "error" && row.status_rx === 400 && row.rx.includes("Only valid Operation Syntax OPs allowed. No free response.")
                    : row.op === "READ" && row.status_rx === 404), "the failure is retained, not suppressed to resume the loop");
                const input = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: result.turnIds![2]! });
                assert.ok(input.some((row) => row.op === "SEND" && row.status_rx === 200 && row.rx.includes('"bytesAccepted":16')));
                const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds![3]! });
                assert.match(packetSection(JSON.parse(packet!.packet), "log"), /received:recovery-witness/,
                    "the recovery actually feeds and closes stdin, then observes the real process output");
            } finally { client.close(); }
        });
    });
}

for (const action of ["cancel", "stop"] as const) {
    test(`{§exec-input}: daemon ${action} reaps a real input-open process without a spurious model wake`, async () => {
        const mock = new StreamMock({ contextWindow: 100_000, responses: [
            makeMockResponse("````node [{\"stdin\": \"open\"}]\nconsole.log(process.pid); process.stdin.resume();\n````\n\n````WAIT\nAwait process input.\n````"),
        ] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `stdin-${action}` });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Await input.", policy: { proposals: "accept" } });
            await waitForDb(() => new LoopLifecycle(db).status(loopId), (status) => status === 202, { timeoutMs: 8_000 });
            const turn = await db.test_latest_model_turn_in_loop.get<{ id: number }>({ loop_id: loopId });
            assert.ok(turn);
            const stream = await executionAddress(db, turn.id, 2);
            const channel = await waitForDb(() => db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({
                pathname: new URL(stream).pathname, scheme: "node", name: "stdout",
            }), (value) => /^\d+\s*$/.test(value?.content ?? ""));
            const pid = Number(channel!.content.trim());
            assert.ok(Number.isSafeInteger(pid) && pid > 0);
            process.kill(pid, 0);
            if (action === "stop") await daemon.stop();
            else await daemon.cancelWorker({ workspaceId, workerId });
            await waitForDb(() => db.find_open_subscriptions_for_worker.all({ worker_id: workerId }), (rows) => rows.length === 0);
            assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the input-open child does not outlive teardown");
            assert.equal(mock.received.length, 1, "teardown never schedules a second inference");
        });
    });
}
