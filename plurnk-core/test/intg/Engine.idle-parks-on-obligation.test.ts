// {§send-idle-turn} {§worker-optimistic-settlement}
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, waitForDb } from "./_rpc.ts";

test("{§send-idle-turn} actionable TASK-only turns continue with or without a stream; only waiting parks", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "plurnk-idle-park-"));
    const releasePath = join(releaseDir, "release");
    const priorWait = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "100";
    try {
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse(`\`\`\`EXEC
while [ ! -f '${releasePath}' ]; do sleep 0.05; done; printf finished
\`\`\`

\`\`\`TASK
[{"content":"started","status":"in_progress"}]
\`\`\``, 50),
            makeMockResponse("```TASK\n[{\"content\":\"Review the independent work\",\"status\":\"in_progress\"}]\n```", 50),
            makeMockResponse("```TASK\n[{\"content\":\"Await the command\",\"status\":\"waiting\"}]\n```", 50),
            makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 50),
            makeMockResponse("```TASK\n[{\"content\":\"nothing to wait on\",\"status\":\"in_progress\"}]\n```", 50),
            makeMockResponse("```SEND\nconcluded\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "idle-park" });
                const running = runLoopToTerminal(ws, 2, { prompt: "run and wait", policy: { proposals: "accept" } }, { timeoutMs: 20_000 });
                let taskStatuses: number[];
                try {
                    // The park lands the loop's status before the TASK row's receipt is durable, so
                    // wait for the rows the assertion reads, not for the status.
                    taskStatuses = await waitForDb(
                        async () => (await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({}))
                            .filter(({ op }) => op === "TASK").map(({ status_rx }) => status_rx),
                        (statuses) => statuses.length === 3,
                    );
                } finally {
                    // Release the command whatever the wait said: a failed assertion must not leave
                    // the loop parked past the end of the test.
                    await writeFile(releasePath, "");
                }
                assert.equal(mock.remaining, 3, "both actionable turns ran before the explicit waiting inventory parked");
                assert.deepEqual(taskStatuses, [102, 102, 202], "launch, independent work, then explicit wait");
                const parked = await running;
                assert.equal(parked.result.status, 200, "the loop concludes after the parked turn wakes on the stream's end");
                const errBefore = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: parked.modelWorkerId! });
                assert.deepEqual(errBefore, [], "valid inventory-only work and waiting produced no errors");
                const idle = await runLoopToTerminal(ws, 3, { prompt: "sit", policy: { proposals: "accept" } });
                assert.equal(idle.result.status, 200);
                const errAfter = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: idle.modelWorkerId! });
                assert.deepEqual(errAfter, [], "inventory-only work is also valid without a stream");
                assert.equal(mock.remaining, 0, "each explicitly supplied inventory was processed");
            } finally { ws.close(); }
        });
    } finally {
        if (priorWait === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = priorWait;
        await rm(releaseDir, { recursive: true, force: true });
    }
});
