// The in-process git READ backend (#461/#463, isomorphic-git + the `ignore` lib) — the portable
// default behind every core git read. No subprocess, and hermetic BY CONSTRUCTION: isomorphic-git
// takes an explicit `dir` and never reads GIT_* env, ~/.gitconfig, or the system config, so the
// escape class hermeticGitEnv scrubs on the native path (#401/#428) cannot exist here. A sandboxed
// or git-less host gets identical membership + telemetry. `PLURNK_SERVICE_GIT_NATIVE=1` routes the
// callers (GitMembership, GitState) to system git instead — the membership pass measures ~8x native
// (~130ms at 20k files); the status read is pure-JS workdir hashing (statusMatrix, ~55x), the
// flag's main case on a large repo.

import git, { STAGE, type WalkerEntry } from "isomorphic-git";
import fs from "node:fs";
import ignore, { type Ignore } from "ignore";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GitStatus } from "./git-state.ts";

export default class GitIso {
    // One STAGE walk serves both member classes: `blob` entries are the tracked files
    // (parity with `ls-files --stage` sans mode-160000), `commit` entries are submodule
    // gitlinks — repo boundaries the untracked scan must never descend. Memoized on the
    // caller's per-pass cache: trackedFiles + untrackedFiles in one membership pass share
    // one walk, and the cache dies with the pass, so a rewritten index can't serve stale.
    static #stageMemo = new WeakMap<object, Map<string, Promise<{ blobs: string[]; gitlinks: string[] }>>>();
    static #stageEntries(root: string, cache: object): Promise<{ blobs: string[]; gitlinks: string[] }> {
        let perCache = GitIso.#stageMemo.get(cache);
        if (perCache === undefined) { perCache = new Map(); GitIso.#stageMemo.set(cache, perCache); }
        let entry = perCache.get(root);
        if (entry === undefined) { entry = GitIso.#stageWalk(root, cache); perCache.set(root, entry); }
        return entry;
    }

    static async #stageWalk(root: string, cache: object): Promise<{ blobs: string[]; gitlinks: string[] }> {
        const blobs: string[] = [];
        const gitlinks: string[] = [];
        await git.walk({
            fs, dir: root, cache, trees: [STAGE()],
            // Explicit param types (#469): a TS7031 fired on a box whose inference didn't flow the
            // WalkerMap contextual type into the destructured param — annotate, never rely on it.
            map: async (filepath: string, [stage]: Array<WalkerEntry | null>) => {
                if (filepath === "." || stage === null) return undefined;
                const type = await stage.type();
                if (type === "blob") blobs.push(filepath);
                if (type === "commit") gitlinks.push(filepath);
                return undefined;
            },
        });
        return { blobs, gitlinks };
    }

    // Tracked files, workspace-relative — parity with `git ls-files --stage -z` + the gitlink
    // filter: only blob entries (files + symlinks) are members; a `commit` entry is a submodule
    // boundary (a separate declared repo) and a `tree` is walk hierarchy, never a file.
    static async trackedFiles(root: string, cache: object): Promise<string[]> {
        return (await GitIso.#stageEntries(root, cache)).blobs;
    }

    // Untracked-but-not-ignored files — parity with `git ls-files --others --exclude-standard`,
    // differential-gated against it across the gitignore edge-case corpus (#463). A pruning
    // fs-walk with the `ignore` lib: rules load ONCE per .gitignore (per-file `git.isIgnored`
    // re-parses every call — measured 237x native; statusMatrix hashes the workdir — 55x, and
    // crosses embedded-repo boundaries; the whole membership pass measures ~8x). Precedence is
    // git's: `.git/info/exclude` lowest, then .gitignore
    // root→deep, deeper opinions winning for their subtree. An ignored DIRECTORY is pruned
    // whole (git: no re-include under an excluded dir — while `dir/**` glob patterns leave the
    // dir itself unignored, so their re-includes work). Submodule gitlinks are never descended,
    // and a directory carrying its own `.git` (an embedded plain repo) is a boundary listed as
    // the single entry `dir/`, exactly as native does.
    static async untrackedFiles(root: string, cache: object): Promise<string[]> {
        const { blobs, gitlinks } = await GitIso.#stageEntries(root, cache);
        const tracked = new Set(blobs);
        const boundaries = new Set(gitlinks);
        // Matchers in precedence order; each carries the dir it applies to ("" = root).
        const matchers: Array<{ base: string; ig: Ignore }> = [];
        const excludes = await GitIso.#infoExclude(root);
        if (excludes !== null) matchers.push({ base: "", ig: ignore().add(excludes) });
        const ignored = (rel: string, isDir: boolean): boolean => {
            let verdict = false;
            for (const { base, ig } of matchers) {
                if (base.length > 0 && !rel.startsWith(`${base}/`)) continue;
                const local = base.length > 0 ? rel.slice(base.length + 1) : rel;
                const t = ig.test(isDir ? `${local}/` : local);
                if (t.ignored) verdict = true;
                else if (t.unignored) verdict = false;
            }
            return verdict;
        };
        const untracked: string[] = [];
        const walkDir = async (rel: string): Promise<void> => {
            const gi = join(root, rel, ".gitignore");
            const depth = matchers.length;
            if (existsSync(gi)) matchers.push({ base: rel, ig: ignore().add(await readFile(gi, "utf8")) });
            for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
                if (entry.name === ".git") continue;
                const r = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
                if (boundaries.has(r)) continue;  // submodule — a separate declared repo
                const isDir = entry.isDirectory();
                if (ignored(r, isDir)) continue;  // pruned: ignored dirs are never descended
                if (isDir) {
                    // An embedded plain repo (its own .git, no gitlink) is a boundary too:
                    // native lists it as the one entry `dir/` and never claims its files.
                    if (existsSync(join(root, r, ".git"))) { untracked.push(`${r}/`); continue; }
                    await walkDir(r);
                } else if (!tracked.has(r)) {
                    untracked.push(r);
                }
            }
            matchers.length = depth;  // leaving the dir pops its .gitignore
        };
        await walkDir("");
        return untracked;
    }

    // `.git/info/exclude`, linked-worktree-aware: a worktree's `.git` is a FILE pointing at
    // the per-worktree gitdir, whose `commondir` names the shared gitdir where info/exclude
    // actually lives. Absent at any step → null (no exclude rules).
    static async #infoExclude(root: string): Promise<string | null> {
        try {
            let gitdir = join(root, ".git");
            if ((await fs.promises.stat(gitdir)).isFile()) {
                const pointer = (await readFile(gitdir, "utf8")).trim();
                if (!pointer.startsWith("gitdir:")) return null;
                gitdir = pointer.slice("gitdir:".length).trim();
            }
            const commondir = join(gitdir, "commondir");
            if (existsSync(commondir)) gitdir = join(gitdir, (await readFile(commondir, "utf8")).trim());
            return await readFile(join(gitdir, "info/exclude"), "utf8");
        } catch {
            return null;
        }
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
