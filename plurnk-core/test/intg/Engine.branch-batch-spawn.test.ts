// #463 regression witness: a turn spawning three WORKers plus an EXEC under [102] must reconcile,
// never freeze dispatch (the run200 shape; the live freeze remains an armed-monitor race).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
const execFileP = promisify(execFile);

test("#463: three WORK spawns + EXEC + [102] does not freeze the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-freeze-"));
    const env = hermeticGitEnv();
    await execFileP("git", ["init", "-q"], { cwd: root, env });
    await execFileP("git", ["config", "user.email", "f@x.invalid"], { cwd: root, env });
    await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
    await writeFile(join(root, "a.txt"), "hello\n");
    await execFileP("git", ["add", "."], { cwd: root, env });
    await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("## WORK0 (worker://alpha)\ninvestigate part A\n\n## WORK0 (worker://beta)\ninvestigate part B\n\n## WORK0 (worker://gamma)\ninvestigate part C\n\n## EXEC0\necho hi\n\n## SEND0 [102]\nspawned three", 50),
        makeMockResponse("## SEND0 [200]\nchild A done", 20),
        makeMockResponse("## SEND0 [200]\nchild B done", 20),
        makeMockResponse("## SEND0 [200]\nchild C done", 20),
        makeMockResponse("## SEND0 [200]\nall reconciled", 20),
        makeMockResponse("## SEND0 [200]\nspare", 20),
        makeMockResponse("## SEND0 [200]\nspare", 20),
    ] });
    try {
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "freeze", projectRoot: root });
                let outcome: "done" | "hang" = "hang";
                const loop = runLoopToTerminal(ws, 2, { prompt: "split the work", policy: { proposals: "accept" } }, { timeoutMs: 40_000 })
                    .then((r) => { outcome = "done"; return r; });
                const timer = new Promise((resolve) => setTimeout(resolve, 45_000));
                const result = await Promise.race([loop, timer]);
                if (outcome === "hang") {
                    const batches = await db.branch_batch_active_for_worker.all<Record<string, unknown>>({ worker_id: 3 }).catch((e: Error) => e.message);
                    assert.fail(`workspace froze (#463). batch state: ${JSON.stringify(batches)}`);
                }
                assert.equal((result as { result: { status: number } }).result.status, 200, "the parent reconciled after the batch");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
