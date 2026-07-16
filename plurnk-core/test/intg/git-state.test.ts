// SPEC §telemetry — git working-tree state in the telemetry section. GitState shells
// `git status` (service-side, the same surface membership uses), gated by
// PLURNK_SERVICE_GIT_ALLOWED (the hard service ceiling) + a git worktree.

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import GitState from "../../src/core/git-state.ts";
import { openMigrated, insertWorkspace, rootWorkspace } from "./_helpers.ts";

const execFileP = promisify(execFile);

test("GitState.status reads the working tree, gated by PLURNK_SERVICE_GIT_ALLOWED (§telemetry git telemetry)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-gitstate-"));
    const db = await openMigrated();
    const orig = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "t@t.t"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "untracked.txt"), "loose\n");          // 1 untracked
        await writeFile(join(root, "tracked.md"), "# tracked\n\nedit\n");  // 1 unstaged

        const workspaceId = await insertWorkspace(db, `gitstate-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);

        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const status = await GitState.status(db, workspaceId, undefined);
        assert.notEqual(status, null, "a worktree yields git state");
        assert.equal(status!.untracked, 1, "the loose file is counted untracked");
        assert.equal(status!.unstaged, 1, "the edited tracked file is counted unstaged");
        assert.equal(status!.staged, 0, "nothing staged");
        assert.ok(status!.branch.length > 0, "a branch name is reported");

        // The hard ceiling flatly disables it.
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "0";
        assert.equal(await GitState.status(db, workspaceId, undefined), null, "PLURNK_SERVICE_GIT_ALLOWED=0 disables git telemetry");
    } finally {
        if (orig === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = orig;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
