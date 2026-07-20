// Headless is forever (§membership): a workspace is born with its workspace pointer or never has
// one, so a 'repo' constraint on a rootless workspace can never resolve — it is refused legibly,
// never recorded as a silent forever-pend. On a rooted workspace, members land immediately and
// their derivations warm at constrain time (like createWorkspace), not at some later turn's pump.
import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";

test("a 'repo' constraint on a HEADLESS workspace is refused — headless is forever, it could never resolve (§membership)", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "rootless-repo" });
            const workspaceId = (created.result as { id: number }).id;
            await assert.rejects(
                () => daemon.constrain(workspaceId, "repo", "*"),
                /headless is forever.*projectRoot/s,
                "the refusal names the contract (pointer at create or never) and the remedy",
            );
            const constraints = await daemon.listConstraints(workspaceId);
            assert.equal(constraints.length, 0, "nothing was recorded — no forever-pending row");
        } finally { ws.close(); }
    });
});

test("a 'repo' constraint on a ROOTED workspace lands members and returns them via FIND-visible catalog", async () => {
    // a real tiny git repo so ls-files has truth to report
    const root = mkdtempSync(join(tmpdir(), "plurnk-root-"));
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: root, env: hermeticGitEnv() });
    writeFileSync(join(root, "hello.md"), "# hi\n");
    // The suite's fixture-repo convention (contract-workspace.test.ts): hermetic by declaration —
    // no inherited operator hooks (commitlint template) or signing; fixture setup, not a project commit.
    execSync("git add hello.md && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --no-verify -qm seed", { cwd: root, env: hermeticGitEnv() });
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "rooted-repo", projectRoot: root });
            const workspaceId = (created.result as { id: number }).id;
            await daemon.constrain(workspaceId, "repo", "*");
            const effects = await daemon.listMembers(workspaceId) as { members: Array<{ path: string; effect: string }> };
            assert.ok(effects.members.length > 0, "the workspace catalog is non-empty after /repo on a rooted workspace");
            assert.ok(effects.members.some((m) => m.path === "hello.md"), "the tracked file is a member");
        } finally { ws.close(); }
    });
});
