// {§exec-timeout} — `<-1>` outlives the loop (#494): a detached spawn survives its loop's own 200,
// is no obligation for that TERM, and still ends with the daemon.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Mock } from "@plurnk/plurnk-providers";
import { viableWindow } from "./_helpers.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitForDb } from "./_rpc.ts";

process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const mockTurn = (dsl: string) => ({
    assistant: { content: `# PLAN0\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A host exec that never exits on its own and leaves a heartbeat the test can read from outside.
const heartbeat = (file: string) => `while true; do date +%s%N > ${file}; sleep 0.05; done`;
const beat = async (file: string): Promise<string> => (await readFile(file, "utf8").catch(() => "")).trim();
const beating = async (file: string, ms: number): Promise<boolean> => {
    const before = await beat(file);
    await delay(ms);
    return before !== await beat(file);
};

test("{§exec-timeout} a `<-1>` spawn outlives its loop's 200, gates no TERM, and ends with the daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-detached-"));
    const file = join(dir, "beat");
    try {
        const mock = new Mock({
            contextWindow: viableWindow(),
            responses: [mockTurn(`## EXEC0 <-1>\n${heartbeat(file)}\n\n## SEND0 (TERM)\nthe server stays up`)],
        });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "exec-detached" });
                const concluded = subscribeNotifications(ws, "stream/concluded");
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "leave a server running", policy: { proposals: "accept" } });
                const loopId = (run.result as { loopId: number }).loopId;

                // The TERM lands as 200 with the detached stream still open: it is nobody's obligation.
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 200,
                    { timeoutMs: 10000 },
                );
                await waitForDb(() => beat(file), (b) => b !== "", { timeoutMs: 5000 });
                assert.equal(await beating(file, 400), true, "the detached spawn keeps running after the loop's 200");
                assert.equal(
                    (concluded() as Array<{ scheme: string }>).some((c) => c.scheme === "sh"),
                    false,
                    "no reap concluded the detached stream at loop end",
                );
            } finally { ws.close(); }
        });
        // withDaemon stopped the daemon: a detached spawn does not outlive it.
        await waitForDb(() => beating(file, 300), (moving) => moving === false, { timeoutMs: 10000 });
    } finally { await rm(dir, { recursive: true, force: true }); }
});
