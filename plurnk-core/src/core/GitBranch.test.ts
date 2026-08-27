import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import GitBranch, { GitUnavailableError } from "./GitBranch.ts";
import { hermeticGitEnv } from "./git-env.ts";

const execFileP = promisify(execFile);

const git = (root: string, args: string[]) =>
    execFileP("git", args, { cwd: root, env: hermeticGitEnv() });

const seed = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-branch-"));
    await git(root, ["init", "--quiet"]);
    await writeFile(join(root, "seed.txt"), "seed\n");
    await git(root, ["add", "seed.txt"]);
    await git(root, [
        "-c", "user.name=Plurnk Test",
        "-c", "user.email=test@plurnk.xyz",
        "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null",
        "commit", "--no-verify", "--quiet", "-m", "test: seed",
    ]);
    return root;
};

test("GitBranch creates, checks, and restores an ordinary branch", async () => {
    const root = await seed();
    try {
        const snapshot = await GitBranch.snapshot(root);
        await GitBranch.validate("feature/example");
        await GitBranch.create(root, "feature/example", snapshot.commit);
        assert.equal(await GitBranch.branchExists(root, "feature/example"), true);
        await GitBranch.switch(root, "feature/example");
        assert.equal(await GitBranch.currentBranch(root), "feature/example");
        await GitBranch.restore(snapshot);
        assert.deepEqual(await GitBranch.snapshot(root), snapshot);
        await GitBranch.delete(root, "feature/example");
        assert.equal(await GitBranch.branchExists(root, "feature/example"), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("GitBranch cleanliness includes nonignored untracked files", async () => {
    const root = await seed();
    try {
        await GitBranch.assertClean(root);
        await writeFile(join(root, "untracked.txt"), "not committed\n");
        await assert.rejects(
            GitBranch.assertClean(root),
            /staged, unstaged, or nonignored untracked changes/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("GitBranch reports a missing git binary as unavailable, never as a rejected ref (#384)", async () => {
    await GitBranch.validate("issues-a");
    await assert.rejects(
        GitBranch.validate("issues-a", "/nonexistent/plurnk-git"),
        (error: unknown) => error instanceof GitUnavailableError && /not installed or not on PATH/.test(error.message),
    );
});

test("GitBranch rejects invalid refs", async () => {
    await assert.rejects(GitBranch.validate("bad..branch"), /check-ref-format rejected/);
});
