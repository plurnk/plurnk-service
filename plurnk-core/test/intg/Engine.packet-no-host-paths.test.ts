// {§fs-namespace} — host paths do not exist inside the jail. The 2026-08-29 benchlet showed the
// EXEC receipt's absolute `cwd` (and the target-not-found Problem's `root`) in every packet, and
// the model pasting it back as `## EXEC0 (cwd: /host/path)`. This witness renders a real loop's
// packets and asserts the workspace's host root never appears in them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);

test("{§fs-namespace} no packet carries the workspace's host-absolute root: EXEC receipts, failed targets, and stream rows included", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plurnk-jail-")));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), "one\n");
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        // A targetless command (its receipt names the root — the default), a command whose
        // target does not resolve (the Problem used to carry the host root), then a conclusion.
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## EXEC0\nprintf ok\n\n## EXEC0 (cwd: /nowhere)\nprintf never\n\n## SEND0 [102]\nran", 50),
            makeMockResponse("## SEND0 [200]\ndone", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "jail", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "run", policy: { proposals: "accept" } });
                assert.equal(result.result.status, 200);
                const texts: string[] = [];
                for (const id of result.turnIds ?? []) {
                    const row = await db.test_get_packet.get<{ packet: string }>({ id });
                    if (row?.packet) texts.push(row.packet);
                }
                assert.ok(texts.length >= 2, `every turn's packet is inspected; got ${texts.length}`);
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: result.modelWorkerId! });
                const execs = rows.filter(({ op }) => op === "EXEC");
                assert.deepEqual(execs.map(({ status_rx }) => status_rx).toSorted(), [200, 400], "one command ran, one target was refused");
                for (const text of texts) {
                    assert.doesNotMatch(text, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the host root never appears in what the model sees");
                }
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
