// note 10 — auto stale-read anti-clobber. A loop auto loop must NOT auto-accept an
// EDIT to a file that changed on disk after the model's prior turn — that silently
// clobbers the ambient change. The engine flags the proposal `staleClobberRisk` (the
// target has a source=file env-delta this turn); auto rejects rather than accepts.
//
// Scenario: turn 1 materializes doc.md=V1; the file changes to V2 out-of-band; the auto
// model EDITs (based on its stale V1 view) to V3. The EDIT must be rejected — never
// written — so the on-disk file keeps V2. (A clobber would write V3 to disk on accept.)

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, subscribeNotifications } from "./_rpc.ts";

const execFileP = promisify(execFile);

test("auto rejects an EDIT to a file that diverged on disk this turn — no silent clobber", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-clobber-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "doc.md"), "V1 original\n");
        await execFileP("git", ["add", "doc.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## SEND0 [200]\nok", 50),                                                  // loop 1: materialize doc.md=V1, terminate
            makeMockResponse("## EDIT0 (file:///doc.md) <1,-1>\nV3 model clobber\n\n## SEND0 [200]\ndone", 50),  // loop 2 turn 1: stale EDIT is rejected
            makeMockResponse("## SEND0 [200]\nstale edit rejected", 50),                                // loop 2 turn 2: model sees the rejection, then concludes
        ] });
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const proposals = subscribeNotifications(ws, "loop/proposal");
                await rpcCall(ws, 1, "workspace.create", { name: "clobber", projectRoot: root });
                // loop 1 — first sight materializes doc.md = V1 (no divergence).
                const first = await runLoopToTerminal(ws, 2, { prompt: "look", flags: { auto: true } });
                assert.equal(first.result.status, 200, "the materialization loop completed before the anti-clobber exercise");

                // The file changes out-of-band between turns.
                await writeFile(join(root, "doc.md"), "V2 ambient change\n");

                // loop 2 — pre-turn detects the V1→V2 divergence; the auto model EDITs based
                // on its stale (V1) view. The anti-clobber must reject the EDIT, not apply it.
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit it", flags: { auto: true } });
                assert.equal(second.result.status, 200, "the stale EDIT was exercised and the model concluded normally");

                const stale = (proposals() as Array<{
                    staleClobberRisk?: boolean;
                    disposition?: { owner?: string; decision?: string; outcome?: string };
                }>).find((proposal) => proposal.staleClobberRisk === true);
                assert.deepEqual(stale?.disposition, {
                    owner: "loop",
                    decision: "reject",
                    outcome: "stale_read_clobber",
                }, "the same core disposition both reports and enforces the stale rejection");

                const onDisk = await readFile(join(root, "doc.md"), "utf8");
                assert.match(onDisk, /V2 ambient change/, "the ambient on-disk change survives — the stale auto EDIT was rejected, never written");
                assert.doesNotMatch(onDisk, /V3 model clobber/, "the model's stale V3 EDIT did NOT reach disk (no silent clobber)");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
