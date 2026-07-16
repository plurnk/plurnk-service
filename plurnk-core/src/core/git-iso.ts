// The in-process git READ backend (#461, isomorphic-git) — the portable default behind every
// core git read. No subprocess, and hermetic BY CONSTRUCTION: isomorphic-git takes an explicit
// `dir` and never reads GIT_* env, ~/.gitconfig, or the system config, so the escape class
// hermeticGitEnv scrubs on the native path (#401/#428) cannot exist here. A sandboxed or
// git-less host gets identical membership + telemetry. `PLURNK_SERVICE_GIT_NATIVE=1` routes
// the callers (GitMembership, GitState) to system git instead — the untracked scan is pure-JS
// workdir hashing (statusMatrix), measured ~55x native at 20k files, so a large-repo host with
// a git binary can buy the hot path back; every other read here is within ~3x of native.

import git, { STAGE } from "isomorphic-git";
import fs from "node:fs";
import type { GitStatus } from "./git-state.ts";

export default class GitIso {
    // Tracked files, workspace-relative — parity with `git ls-files --stage -z` + the gitlink
    // filter: only blob entries (files + symlinks) are members; a `commit` entry is a submodule
    // boundary (a separate declared repo) and a `tree` is walk hierarchy, never a file.
    static async trackedFiles(root: string, cache: object): Promise<string[]> {
        const files = await git.walk({
            fs, dir: root, cache, trees: [STAGE()],
            map: async (filepath, [stage]) => {
                if (filepath === "." || stage === null) return undefined;
                return (await stage.type()) === "blob" ? filepath : undefined;
            },
        }) as string[];
        return files;
    }

    // Untracked-but-not-ignored files — parity with `git ls-files --others --exclude-standard`.
    // statusMatrix walks the workdir honoring .gitignore (ignored rows never appear) and
    // descends untracked directories to their files, exactly as --others does. Row shape is
    // [filepath, HEAD, WORKDIR, STAGE]; [_, 0, 2, 0] = present on disk, absent from HEAD and
    // index = untracked. This is the one pure-JS-slow read (workdir hashing) — the reason
    // PLURNK_SERVICE_GIT_NATIVE exists.
    static async untrackedFiles(root: string, cache: object): Promise<string[]> {
        const matrix = await git.statusMatrix({ fs, dir: root, cache });
        return matrix.filter(([, head, workdir, stage]) => head === 0 && stage === 0 && workdir === 2).map(([filepath]) => filepath);
    }

    // The enclosing worktree root of a directory — parity with `git rev-parse --show-toplevel`,
    // linked worktrees + submodules included (findRoot accepts a `.git` FILE — the gitdir
    // pointer — as readily as a directory). Not inside any git tree → null.
    static async repoToplevel(dir: string): Promise<string | null> {
        try {
            return await git.findRoot({ fs, filepath: dir });
        } catch {
            return null;  // not a git tree (or the dir is gone) — contributes nothing
        }
    }

    // Working-tree status — parity with `git status --porcelain --branch`: branch, ahead/behind
    // the configured upstream, and staged/unstaged/untracked counts. Throws on a non-repo /
    // unborn-HEAD root (no commit yet); the caller maps that to null = no telemetry, the same
    // fail-closed contract the native arm's catch applies.
    static async status(root: string): Promise<GitStatus> {
        const cache = {};
        const branch = await git.currentBranch({ fs, dir: root, fullname: false }) ?? "HEAD";  // detached → HEAD, as porcelain renders it
        const matrix = await git.statusMatrix({ fs, dir: root, cache });
        let staged = 0;
        let unstaged = 0;
        let untracked = 0;
        for (const [, head, workdir, stage] of matrix) {
            if (head === 0 && stage === 0 && workdir === 2) { untracked++; continue; }
            if (head === 1 ? stage !== 1 : stage !== 0) staged++;            // index differs from HEAD → X column
            if ((workdir === 2 && stage !== 2) || (workdir === 0 && stage !== 0)) unstaged++;  // workdir differs from index → Y column
        }
        const { ahead, behind } = await GitIso.#aheadBehind(root, branch, cache);
        return { branch, ahead, behind, staged, unstaged, untracked };
    }

    // ahead/behind vs the branch's configured upstream (branch.<name>.remote + .merge →
    // refs/remotes/<remote>/<branch>). No upstream configured or never fetched → 0/0, the
    // same absence porcelain's header shows. Counting walks parents from each tip and stops
    // at the merge base, so the cost is proportional to the DIVERGENCE, never history depth.
    static async #aheadBehind(root: string, branch: string, cache: object): Promise<{ ahead: number; behind: number }> {
        const none = { ahead: 0, behind: 0 };
        if (branch === "HEAD") return none;  // detached — porcelain shows no upstream either
        try {
            const remote = await git.getConfig({ fs, dir: root, path: `branch.${branch}.remote` }) as string | undefined;
            const merge = await git.getConfig({ fs, dir: root, path: `branch.${branch}.merge` }) as string | undefined;
            if (remote === undefined || merge === undefined) return none;
            const tip = await git.resolveRef({ fs, dir: root, ref: "HEAD" });
            const up = await git.resolveRef({ fs, dir: root, ref: `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, "")}` });
            if (tip === up) return none;
            const stop = new Set(await git.findMergeBase({ fs, dir: root, oids: [tip, up], cache }) as string[]);
            return {
                ahead: await GitIso.#countToBase(root, tip, stop, cache),
                behind: await GitIso.#countToBase(root, up, stop, cache),
            };
        } catch {
            return none;  // upstream ref missing (configured but never fetched) — porcelain omits too
        }
    }

    static async #countToBase(root: string, tip: string, stop: ReadonlySet<string>, cache: object): Promise<number> {
        let count = 0;
        const queue = [tip];
        const seen = new Set<string>();
        while (queue.length > 0) {
            const oid = queue.pop() as string;
            if (seen.has(oid) || stop.has(oid)) continue;
            seen.add(oid);
            count++;
            const { commit } = await git.readCommit({ fs, dir: root, oid, cache });
            queue.push(...commit.parent);
        }
        return count;
    }
}
