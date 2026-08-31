import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitOutputMaxBytes, hermeticGitEnv } from "./git-env.ts";

export interface GitSnapshot {
    root: string;
    ref: string | null;
    commit: string;
}

// A host without git cannot validate, create, or restore a branch at all; that is a
// condition of the host, never a verdict on the name (#384).
export class GitUnavailableError extends Error {
    constructor(cause: unknown) {
        super("git is not installed or not on PATH", { cause });
        this.name = "GitUnavailableError";
    }
}

export default class GitBranch {
    static #execFile = promisify(execFile);

    static async validate(branch: string, command = "git"): Promise<void> {
        if (branch.length === 0) throw new Error("Git branch name must not be empty");
        try {
            await GitBranch.#execFile(command, ["check-ref-format", "--branch", branch], {
                env: hermeticGitEnv(),
                encoding: "utf8",
                maxBuffer: gitOutputMaxBytes(),
            });
        } catch (cause) {
            if ((cause as { code?: unknown }).code === "ENOENT") throw new GitUnavailableError(cause);
            const detail = (cause as { stderr?: string }).stderr?.trim();
            throw new Error(
                `git check-ref-format rejected '${branch}'${detail === undefined || detail.length === 0 ? "" : `: ${detail}`}`,
                { cause },
            );
        }
    }

    static async snapshot(root: string): Promise<GitSnapshot> {
        const commit = await GitBranch.#text(root, ["rev-parse", "--verify", "HEAD"]);
        let ref: string | null = null;
        try {
            ref = await GitBranch.#text(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        } catch (error) {
            if (GitBranch.#exitCode(error) !== 1) throw error;
        }
        return { root, ref, commit };
    }

    // {§branch-tracked-clean} (#396) — delegation cleanliness is TRACKED cleanliness.
    // Plurnk never runs `git add` ({§membership-baseline}: creations are picked, not
    // staged), so engine-created member files are untracked by design; untracked
    // files belong to no branch and ride branch switches untouched. Staged or
    // modified tracked state is real uncommitted work and refuses with its paths.
    static async trackedDirtyPaths(root: string): Promise<string[]> {
        const status = await GitBranch.#text(root, ["status", "--porcelain=v1", "--untracked-files=no"]);
        // #text trims the whole output, so the first line may have lost the leading
        // status space; take everything after the first space run instead of a
        // fixed-width slice.
        return status.length === 0 ? [] : status.split("\n")
            .map((line) => line.slice(line.indexOf(" ") + 1).trimStart());
    }

    static async assertTrackedClean(root: string): Promise<void> {
        const dirty = await GitBranch.trackedDirtyPaths(root);
        if (dirty.length > 0) {
            const shown = dirty.slice(0, 8).join(", ");
            const more = dirty.length > 8 ? ` (+${dirty.length - 8} more)` : "";
            throw new Error(`Git checkout '${root}' has uncommitted tracked changes: ${shown}${more}`);
        }
    }

    static async assertClean(root: string): Promise<void> {
        const status = await GitBranch.#text(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
        if (status.length > 0) {
            throw new Error(`Git checkout '${root}' is not clean (staged, unstaged, or nonignored untracked changes exist)`);
        }
    }

    static async branchExists(root: string, branch: string): Promise<boolean> {
        try {
            await GitBranch.#git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
            return true;
        } catch (error) {
            if (GitBranch.#exitCode(error) === 1) return false;
            throw error;
        }
    }

    static async create(root: string, branch: string, commit: string): Promise<void> {
        await GitBranch.#git(root, ["branch", "--", branch, commit]);
    }

    static async switch(root: string, branch: string): Promise<void> {
        await GitBranch.#git(root, ["switch", "--quiet", branch]);
    }

    static async restore(snapshot: GitSnapshot): Promise<void> {
        if (snapshot.ref === null) {
            await GitBranch.#git(snapshot.root, ["switch", "--quiet", "--detach", snapshot.commit]);
        } else {
            await GitBranch.#git(snapshot.root, ["switch", "--quiet", snapshot.ref]);
        }
        const actual = await GitBranch.#text(snapshot.root, ["rev-parse", "--verify", "HEAD"]);
        if (actual !== snapshot.commit) {
            throw new Error(`Git checkout '${snapshot.root}' restored '${snapshot.ref ?? snapshot.commit}' at ${actual}, expected ${snapshot.commit}`);
        }
    }

    static tip(root: string, branch: string): Promise<string> {
        return GitBranch.#text(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    }

    static head(root: string): Promise<string> {
        return GitBranch.#text(root, ["rev-parse", "--verify", "HEAD"]);
    }

    static async currentBranch(root: string): Promise<string | null> {
        try {
            return await GitBranch.#text(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        } catch (error) {
            if (GitBranch.#exitCode(error) === 1) return null;
            throw error;
        }
    }

    static async delete(root: string, branch: string): Promise<void> {
        await GitBranch.#git(root, ["branch", "-D", "--", branch]);
    }

    static async #text(root: string, args: string[]): Promise<string> {
        const { stdout } = await GitBranch.#git(root, args);
        return stdout.trim();
    }

    static async #git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
        try {
            return await GitBranch.#execFile("git", args, {
                cwd: root,
                env: hermeticGitEnv(),
                encoding: "utf8",
                maxBuffer: gitOutputMaxBytes(),
            });
        } catch (cause) {
            const detail = (cause as { stderr?: string }).stderr?.trim();
            throw new Error(
                `git ${args[0] ?? "command"} failed in '${root}'${detail === undefined || detail.length === 0 ? "" : `: ${detail}`}`,
                { cause },
            );
        }
    }

    static #exitCode(error: unknown): number | undefined {
        const cause = error instanceof Error ? error.cause : undefined;
        return (cause as { code?: number } | undefined)?.code;
    }
}
