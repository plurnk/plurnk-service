import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, waitForDb, withDaemon } from "./_rpc.ts";
import { packetSection } from "./_helpers.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";

test("{§exec-input}: the production loop sends stdin, waits for EOF completion, and observes the real result", async () => {
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse('````node {stdin=open}\nprocess.stdin.on("data", d => process.stdout.write("received:" + d));\n````\n\n````TASK\n[{"content":"Deliver input to the process.","status":"in_progress"}]\n````', 10),
        makeMockResponse('````SEND (node:///1/2/2/node) {eof=true}\ninput-witness\n````\n\n````TASK\n[{"content":"Observe the output.","status":"waiting"}]\n````', 10),
        makeMockResponse('````SEND\nVerified the process response.\n````\n\n````TASK\n[{"content":"Observed input-witness.","status":"completed"}]\n````', 10),
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

for (const action of ["cancel", "stop"] as const) {
    test(`{§exec-input}: daemon ${action} reaps a real input-open process without a spurious model wake`, async () => {
        const mock = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse('````node {stdin=open}\nconsole.log(process.pid); process.stdin.resume();\n````\n\n````TASK\n[{"content":"Await process input.","status":"waiting"}]\n````'),
        ] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `stdin-${action}` });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Await input.", policy: { proposals: "accept" } });
            await waitForDb(() => new LoopLifecycle(db).status(loopId), (status) => status === 202, { timeoutMs: 8_000 });
            const channel = await waitForDb(() => db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({
                pathname: "/1/2/2/node", scheme: "node", name: "stdout",
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
