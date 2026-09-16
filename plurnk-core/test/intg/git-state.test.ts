// SPEC {§packet-git-status} — one Git snapshot supplies the compact packet
// summary and exact per-path state for causal filesystem observations. GitState shells
// `git status` (service-side, the same surface membership uses), gated by
// PLURNK_SERVICE_GIT_ALLOWED (the hard service ceiling) + a git worktree.

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import GitState from "../../src/core/git-state.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { openMigrated, insertWorkspace, rootWorkspace } from "./_helpers.ts";

const execFileP = promisify(execFile);

test("{§packet-git-status}: unborn and detached heads are not invented branch names", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-head-"));
    const db = await openMigrated();
    const orig = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const git = (...args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    try {
        await git("init", "-q", "-b", "main");
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const workspaceId = await insertWorkspace(db, `git-head-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const unborn = await GitState.status(db, workspaceId, undefined);
        assert.equal(unborn?.branch, "main");
        assert.match(PacketWire.renderGit(unborn), /branch `main` \(no commits\)/);

        await git("-c", "user.name=fixture", "-c", "user.email=fixture@plurnk.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "seed");
        assert.match(PacketWire.renderGit(await GitState.status(db, workspaceId, undefined)), /branch `main` —/);
        await git("checkout", "--detach", "-q");
        const detached = await GitState.status(db, workspaceId, undefined);
        assert.equal(detached?.branch, null);
        assert.match(PacketWire.renderGit(detached), /detached HEAD —/);
        assert.doesNotMatch(PacketWire.renderGit(detached), /branch/);
    } finally {
        if (orig === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = orig;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("GitState.status reads the working tree, gated by PLURNK_SERVICE_GIT_ALLOWED", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-gitstate-"));
    const db = await openMigrated();
    const orig = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "untracked.txt"), "loose\n");          // 1 untracked
        await writeFile(join(root, "tracked.md"), "# tracked\n\nedit\n");  // 1 unstaged
        await writeFile(join(root, "staged.txt"), "indexed\n");
        await execFileP("git", ["add", "staged.txt"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `gitstate-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);

        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const status = await GitState.status(db, workspaceId, undefined);
        assert.notEqual(status, null, "a worktree yields git state");
        assert.equal(status!.untracked, 1, "the loose file is counted untracked");
        assert.equal(status!.unstaged, 1, "the edited tracked file is counted unstaged");
        assert.equal(status!.staged, 1, "the indexed addition is counted staged");
        assert.ok(status!.branch !== null && status!.branch.length > 0, "a branch name is reported");
        assert.deepEqual(
            status!.files,
            [
                { path: "staged.txt", status: "A " },
                { path: "tracked.md", status: " M" },
                { path: "untracked.txt", status: "??", member: null },
            ],
            "per-path metadata preserves both porcelain coordinates instead of collapsing staged and unstaged M",
        );

        // The hard ceiling flatly disables it.
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "0";
        assert.equal(await GitState.status(db, workspaceId, undefined), null, "PLURNK_SERVICE_GIT_ALLOWED=0 disables git status metadata");
    } finally {
        if (orig === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = orig;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§packet-git-status}: tracking, renames, conflicts, and NUL-safe paths survive porcelain v2", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-paths-"));
    const db = await openMigrated();
    const orig = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const git = (...args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    const commit = (message: string) => git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", message);
    try {
        await git("init", "-q", "-b", "main");
        await git("config", "user.email", "fixture@plurnk.invalid");
        await git("config", "user.name", "fixture");
        await mkdir(join(root, "sub"));
        await writeFile(join(root, "conflict.txt"), "base\n");
        await writeFile(join(root, "sub", "old  name\t.txt"), "rename me\n");
        await git("add", ".");
        await commit("seed");
        await git("checkout", "-q", "-b", "upstream");
        await writeFile(join(root, "conflict.txt"), "upstream\n");
        await commit("upstream change");
        await git("checkout", "-q", "main");
        await writeFile(join(root, "conflict.txt"), "local\n");
        await commit("local change");
        await git("branch", "--set-upstream-to=upstream");
        await git("mv", "sub/old  name\t.txt", "sub/new\nname.txt");
        await writeFile(join(root, "sub", "new\nname.txt"), "rename me\nmodified after staging\n");
        await writeFile(join(root, "sub", "  loose\nfile.txt"), "loose\n");
        const workspaceId = await insertWorkspace(db, `git-paths-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, join(root, "sub"));
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const status = await GitState.status(db, workspaceId, undefined);
        assert.ok(status);
        assert.equal(status.branch, "main");
        assert.equal(status.ahead, 1);
        assert.equal(status.behind, 1);
        assert.equal(status.staged, 1, "a rename counts once, not once per path");
        assert.equal(status.unstaged, 1);
        assert.equal(status.untracked, 1);
        assert.deepEqual(status.files.toSorted((a, b) => a.path < b.path ? -1 : 1), [
            { path: "  loose\nfile.txt", status: "??", member: null },
            { path: "new\nname.txt", status: "RM" },
            { path: "old  name\t.txt", status: "RM" },
        ]);
        await git("add", "sub/new\nname.txt");
        await commit("rename");
        await assert.rejects(git("-c", "commit.gpgsign=false", "merge", "upstream"), { code: 1 });
        const conflicted = await GitState.status(db, workspaceId, undefined);
        assert.ok(conflicted?.files.some(({ path, status }) => path === "../conflict.txt" && status === "UU"));
        assert.equal(conflicted?.staged, 1);
        assert.equal(conflicted?.unstaged, 1);
    } finally {
        if (orig === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = orig;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
