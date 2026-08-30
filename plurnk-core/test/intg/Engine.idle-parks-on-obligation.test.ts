// {§send-idle-turn} — an empty [102] while a stream is in flight is a mis-spelled wait: the
// engine parks it as [202] with a warning notice and no strike; with nothing in flight the
// idle-turn 409 stands (#441, ruled 2026-08-30). The stream must outlive the turn's optimistic
// settlement window ({§worker-optimistic-settlement}) to be in flight at the next turn, so the
// window is shortened and the command waits on a release file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, waitForDb } from "./_rpc.ts";

test("{§send-idle-turn} an empty [102] parks like [202] while a stream runs; with nothing in flight it strikes as idle", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "plurnk-idle-park-"));
    const releasePath = join(releaseDir, "release");
    const priorWait = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "100";
    try {
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse(`## EXEC0\nwhile [ ! -f '${releasePath}' ]; do sleep 0.05; done; printf finished\n\n## SEND0 [102]\nstarted`, 50),
            makeMockResponse("## SEND0 [102]\nwaiting for the command", 50),
            makeMockResponse("## SEND0 [200]\ndone", 50),
            makeMockResponse("## SEND0 [102]\nnothing to wait on", 50),
            makeMockResponse("## SEND0 [200]\nconcluded", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "idle-park" });
                const running = runLoopToTerminal(ws, 2, { prompt: "run and wait", policy: { proposals: "accept" } }, { timeoutMs: 20_000 });
                // The empty [102] is parked: the loop sits at 202 until the stream ends.
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: 1 }))?.status,
                    (status) => status === 202,
                );
                await writeFile(releasePath, "");
                const parked = await running;
                assert.equal(parked.result.status, 200, "the loop concludes after the parked turn wakes on the stream's end");
                const rows = await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({});
                assert.ok(rows.some((r) => r.op === "SEND" && r.status_rx === 202), `the empty [102] was recorded as a 202 park; got ${JSON.stringify(rows)}`);
                const errBefore = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: parked.modelWorkerId! });
                assert.equal(errBefore.filter((r) => /engine\/rail\/idle-turn/.test(r.rx)).length, 0, "no idle strike while the stream was in flight");
                const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: parked.turnIds![3]! }))!.packet);
                const log = (packet.sections as Array<{ name: string; content: string }>).find((s) => s.name === "log")?.content ?? "";
                const sendRows = log.split("\n").filter((line) => /"path":"log:\/\/\/1\/\d+\/\d+\/SEND"/.test(line));
                const sendRow = sendRows.find((line) => /"status":202/.test(line));
                assert.ok(sendRow !== undefined && /waits like \[202\]/.test(sendRow), `the wake packet shows the shifted SEND[202] carrying the correction; SEND rows: ${JSON.stringify(sendRows)}`);
                // The same worker, nothing in flight: an empty [102] is idleness and strikes as before.
                const idle = await runLoopToTerminal(ws, 3, { prompt: "sit", policy: { proposals: "accept" } });
                assert.equal(idle.result.status, 200);
                const errAfter = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: idle.modelWorkerId! });
                assert.equal(errAfter.filter((r) => /engine\/rail\/idle-turn/.test(r.rx)).length, 1, "exactly one idle-turn 409, for the turn with nothing to wait on");
            } finally { ws.close(); }
        });
    } finally {
        if (priorWait === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = priorWait;
        await rm(releaseDir, { recursive: true, force: true });
    }
});
