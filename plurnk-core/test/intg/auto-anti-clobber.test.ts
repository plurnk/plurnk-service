// Hash-anchored stale-read anti-clobber. The model READs V1, the file changes to V2
// outside Plurnk, and its V1 anchor must reject the later EDIT before proposal.

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import LineAnchors from "../../src/content/line-anchors.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);

test("a stale hash anchor rejects an EDIT before proposal — no silent clobber", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-clobber-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "doc.md"), "V1 original\n");
        await execFileP("git", ["add", "doc.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const staleAnchor = LineAnchors.token("file:///doc.md", 1, "V1 original\n");
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## READ0 (file:///doc.md)\n\n## SEND0 [102]\nReview the file.", 50),
            makeMockResponse("## SEND0 [200]\nRead complete.", 50),
            makeMockResponse(`## EDIT0 (file:///doc.md) <${staleAnchor}>\nV3 model clobber\n\n## SEND0 [200]\ndone`, 50),
            makeMockResponse("## SEND0 [200]\nStale edit rejected.", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "clobber", projectRoot: root });
                // Loop 1 publishes the exact V1 anchor into the model's log.
                const first = await runLoopToTerminal(ws, 2, { prompt: "look", flags: { auto: true } });
                assert.equal(first.result.status, 200, "the V1 READ completed before the anti-clobber exercise");

                // The file changes out-of-band between turns.
                await writeFile(join(root, "doc.md"), "V2 ambient change\n");

                // Loop 2 reconciles V2 before the model attempts its V1-anchored edit.
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit it", flags: { auto: true } });
                assert.equal(second.result.status, 200, "the stale EDIT was exercised and the model concluded normally");
                assert.equal(second.modelWorkerId, first.modelWorkerId, "both loops use the same worker memory");
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({
                    worker_id: second.modelWorkerId!,
                });
                const rejected = rows.find(({ op, status_rx }) => op === "EDIT" && status_rx === 409);
                assert.equal(
                    JSON.parse(rejected?.rx ?? "null")?.problem?.type,
                    "https://problems.plurnk.xyz/engine/edit/edit-collision",
                    "the stale anchor produces the exact edit-collision result before any proposal",
                );

                const onDisk = await readFile(join(root, "doc.md"), "utf8");
                assert.match(onDisk, /V2 ambient change/, "the ambient on-disk change survives — the stale auto EDIT was rejected, never written");
                assert.doesNotMatch(onDisk, /V3 model clobber/, "the model's stale V3 EDIT did NOT reach disk (no silent clobber)");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
