// Delegation ping/pong with a real model ({§worker-scheme-spawn}, {§worker-obligations}): the parent names
// a worker, gives it a task, waits for its answer, then addresses the same worker again by name, which is a
// message to it rather than a second worker, and waits again. Read friction first: a refused or failed model
// operation in either worker is a failure here even when the final reply is right, and so is a second
// worker where one was named.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import { failAfterCleanup } from "../live-failure.ts";
import { rpcCall } from "../intg/_rpc.ts";
import ResourceState from "../intg/resource-state.ts";

interface LogRow { op: string | null; origin: string; status_rx: number; rx: string; tx: string }

test("delegation: ping/pong with one named worker — spawn, answer, message by name, answer again", { timeout: 600_000 }, async (t) => {
    const fixture = await seedDemoFixture("ping-pong");
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `demo-ping-pong-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(s, 2, {
            prompt: "Play ping pong with one helper. Create a worker named pong whose only job is to answer each 'ping N' with 'pong N'. "
                + "Send it 'ping 1' and wait for its answer. Then send 'ping 2' to the same worker, by its name, and wait for that answer too. "
                + "Finally reply to me with both of pong's answers, verbatim.",
            maxTurns: 14,
        }, { signal: t.signal });
        const workers = ((await rpcCall(s.ws, 3, "workspace.workers", {})).result as { workers: Array<{ id: number; name: string; origin: string }> }).workers
            .filter((worker) => worker.origin === "model");
        const pong = workers.filter((worker) => worker.name === "pong");
        const logs = new Map<string, LogRow[]>();
        for (const worker of workers) {
            logs.set(worker.name, await s.db.engine_render_log.all<LogRow>({ worker_id: worker.id }));
        }
        // Friction first: every model operation of every worker succeeded.
        const refused = [...logs.entries()].flatMap(([name, rows]) => rows
            .filter((row) => row.origin === "model" && row.status_rx >= 400)
            .map((row) => `${name}: ${row.op} ${row.status_rx} ${(JSON.parse(row.rx) as { problem?: { type?: string } }).problem?.type?.split("/").slice(-2).join("/") ?? ""}`));
        assert.deepEqual(refused, [], "no model operation was refused or failed in either worker");
        assert.deepEqual(await ResourceState.check(s.db), [], "the workspace stays lawful");

        assert.equal(loop.finalStatus, 200, "the parent concluded");
        assert.equal(pong.length, 1, `one worker named pong; workers ${JSON.stringify(workers.map((worker) => worker.name))}`);
        assert.equal(workers.length, 2, "the parent and pong, nothing else");
        const parent = workers.find((worker) => worker.id === loop.modelWorkerId)!;
        const targetOf = (row: LogRow): string => { try { return (JSON.parse(row.tx) as { target?: { raw?: string } }).target?.raw ?? ""; } catch { return ""; } };
        const toPong = (logs.get(parent.name) ?? []).filter((row) => row.origin === "model" && (row.op === "WORK" || row.op === "SEND") && targetOf(row).includes("worker://pong"));
        assert.ok(toPong.length >= 2, `the parent addressed pong at least twice; saw ${toPong.length}`);
        assert.ok(toPong.some((row) => row.op === "SEND" || row.rx.includes("\"delivered\":\"message\"")), "the second address was a message to the live worker, not a second spawn");
        const answered = await s.db.test_message_completions_from.all<{ status: number }>({ workspace_id: s.workspaceId, source: `worker://${parent.name}` });
        assert.ok(answered.filter((row) => row.status === 200).length >= 1, "pong completed at least the message it was sent by name");
        assert.match(loop.lastContent, /pong\s*1/iu, "the first answer reaches the client");
        assert.match(loop.lastContent, /pong\s*2/iu, "and the second");
        await cleanup();
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
});
