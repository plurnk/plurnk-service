// {§git-isomorphic-opt-in} — differential coverage for the optional
// GitIso backend. Fixtures are seeded with native Git, then read through both
// backends. Native is the production default; isomorphic Git must be selected.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import GitIso, { GitIsoError } from "../../src/core/git-iso.ts";
import GitMembership from "../../src/core/git-membership.ts";
import GitState from "../../src/core/git-state.ts";
import { openMigrated, insertWorkspace, rootWorkspace } from "./_helpers.ts";

const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env: hermeticGitEnv(), maxBuffer: 1 << 26 }).toString();

const seedRepo = async (prefix: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    git(root, "init", "-q");
    git(root, "config", "user.email", "fixture@plurnk.invalid");
    git(root, "config", "user.name", "t");
    return root;
};
const commit = (root: string, msg: string): void => { git(root, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", msg); };
const withIsomorphicGit = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prior = process.env.PLURNK_SERVICE_GIT_ISO;
    process.env.PLURNK_SERVICE_GIT_ISO = "1";
    try {
        return await fn();
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_GIT_ISO;
        else process.env.PLURNK_SERVICE_GIT_ISO = prior;
    }
};

// A rich working tree: tracked (subdir + space-in-name), staged-only, unstaged edit,
// untracked (incl. an untracked DIRECTORY that must descend to its files), gitignored,
// and a submodule gitlink (never a member of the superproject).
const seedRich = async (): Promise<{ root: string }> => {
    const sub = await seedRepo("iso-submod-");
    await writeFile(join(sub, "inner.txt"), "inner\n");
    git(sub, "add", ".");
    commit(sub, "sub seed");

    const root = await seedRepo("iso-rich-");
    await mkdir(join(root, "src/deep"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a\n");
    await writeFile(join(root, "sp ace.txt"), "s\n");
    await writeFile(join(root, "src/deep/b.txt"), "b\n");
    await writeFile(join(root, ".gitignore"), "*.tmp\nignored-dir/\n");
    git(root, "add", ".");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendored");
    commit(root, "seed");
    await writeFile(join(root, "a.txt"), "a edited\n");                       // unstaged M
    await writeFile(join(root, "staged.txt"), "st\n"); git(root, "add", "staged.txt");  // staged A
    await writeFile(join(root, "loose.txt"), "l\n");                          // untracked
    await mkdir(join(root, "newdir/deep"), { recursive: true });
    await writeFile(join(root, "newdir/deep/x.txt"), "x\n");                  // untracked, in an untracked dir
    await writeFile(join(root, "z.tmp"), "z\n");                              // ignored
    await mkdir(join(root, "ignored-dir"));
    await writeFile(join(root, "ignored-dir/y.txt"), "y\n");                  // ignored dir
    await rm(sub, { recursive: true, force: true });
    return { root };
};

// Native truth for the same repo: ls-files --stage (gitlinks filtered) + --others --exclude-standard.
const nativeTracked = (root: string): string[] =>
    git(root, "ls-files", "--stage", "-z").split("\0").filter((e) => e.length > 0)
        .filter((e) => e.slice(0, e.indexOf(" ")) !== "160000").map((e) => e.slice(e.indexOf("\t") + 1)).sort();
const nativeUntracked = (root: string): string[] =>
    git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter((e) => e.length > 0).sort();

test("iso tracked/untracked match native ls-files on the same repo — gitlinks filtered, gitignore honored, untracked dirs descended", async () => {
    const { root } = await seedRich();
    try {
        const cache = {};
        const isoTracked = (await GitIso.trackedFiles(root, cache)).sort();
        const isoUntracked = (await GitIso.untrackedFiles(root, cache)).sort();
        assert.deepEqual(isoTracked, nativeTracked(root), "tracked sets are identical (submodule gitlink excluded from both)");
        assert.deepEqual(isoUntracked, nativeUntracked(root), "untracked sets are identical (ignored pruned, untracked dir descended)");
        assert.ok(!isoTracked.includes("vendored"), "the submodule gitlink is not a member");
        assert.ok(isoTracked.includes("sp ace.txt"), "a space-in-name path survives");
        assert.ok(isoUntracked.includes("newdir/deep/x.txt"), "a file inside an untracked directory is enumerated");
        assert.ok(!isoUntracked.includes("z.tmp") && !isoUntracked.includes("ignored-dir/y.txt"), "gitignore filters both file and dir patterns");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitState.status via iso: branch + staged/unstaged/untracked counts match the working tree", async () => {
    await withIsomorphicGit(async () => {
        const { root } = await seedRich();
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `iso-${crypto.randomUUID()}`);
            await rootWorkspace(db, workspaceId, root);
            const status = await GitState.status(db, workspaceId, undefined);
            assert.ok(status !== null, "a git worktree yields status metadata");
            assert.equal(status.branch, git(root, "symbolic-ref", "--short", "HEAD").trim(), "branch matches native");
            assert.equal(status.staged, 1, "staged.txt is the one staged change");
            assert.equal(status.unstaged, 1, "a.txt's edit is the one unstaged change");
            assert.equal(status.untracked, 2, "loose.txt + newdir/deep/x.txt (ignored files never count)");
            assert.equal(status.ahead, 0);
            assert.equal(status.behind, 0);
        } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
    });
});

test("ahead/behind vs the configured upstream — exact counts via merge-base walk", async () => {
    await withIsomorphicGit(async () => {
        const root = await seedRepo("iso-ab-");
        const db = await openMigrated();
        try {
            await writeFile(join(root, "f.txt"), "1\n"); git(root, "add", "."); commit(root, "c1");
            const c1 = git(root, "rev-parse", "HEAD").trim();
            // The "remote" diverges: one commit from c1 on a side branch becomes origin's tip (behind=1).
            const branch = git(root, "symbolic-ref", "--short", "HEAD").trim();
            git(root, "checkout", "-q", "-b", "side", c1);
            await writeFile(join(root, "r.txt"), "r\n"); git(root, "add", "."); commit(root, "remote-only");
            const remoteTip = git(root, "rev-parse", "HEAD").trim();
            git(root, "checkout", "-q", branch);
            // Local advances two commits past c1 (ahead=2).
            await writeFile(join(root, "f.txt"), "2\n"); git(root, "add", "."); commit(root, "c2");
            await writeFile(join(root, "f.txt"), "3\n"); git(root, "add", "."); commit(root, "c3");
            git(root, "update-ref", `refs/remotes/origin/${branch}`, remoteTip);
            git(root, "config", `branch.${branch}.remote`, "origin");
            git(root, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);

            const workspaceId = await insertWorkspace(db, `iso-ab-${crypto.randomUUID()}`);
            await rootWorkspace(db, workspaceId, root);
            const status = await GitState.status(db, workspaceId, undefined);
            assert.ok(status !== null);
            assert.equal(status.ahead, 2, "two local commits past the merge base");
            assert.equal(status.behind, 1, "one remote-only commit past the merge base");
        } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
    });
});

test("a linked worktree workspace root resolves membership + status through iso (the gitdir-file shape)", async () => {
    await withIsomorphicGit(async () => {
        const main = await seedRepo("iso-wt-main-");
        const db = await openMigrated();
        const linked = join(main, "..", `iso-wt-linked-${crypto.randomUUID()}`);
        try {
            await writeFile(join(main, "tracked.md"), "# t\n"); git(main, "add", "."); commit(main, "seed");
            git(main, "worktree", "add", "-q", linked, "-b", "wt-branch");
            const workspaceId = await insertWorkspace(db, `iso-wt-${crypto.randomUUID()}`);
            await rootWorkspace(db, workspaceId, linked);
            const members = await GitMembership.resolveGitMembership(db, workspaceId, undefined);
            assert.ok(members.includes("tracked.md"), "membership resolves through the .git gitdir-file");
            const status = await GitState.status(db, workspaceId, undefined);
            assert.equal(status?.branch, "wt-branch", "status reads the linked worktree's own HEAD");
        } finally {
            await db.close();
            await rm(linked, { recursive: true, force: true });
            await rm(main, { recursive: true, force: true });
        }
    });
});

test("an unsupported isomorphic-git repository fails with the native-backend remedy on membership and status", async () => {
    const root = await seedRepo("iso-index-v3-");
    const db = await openMigrated();
    const prior = process.env.PLURNK_SERVICE_GIT_ISO;
    try {
        await writeFile(join(root, "tracked.md"), "# tracked\n");
        git(root, "add", "tracked.md");
        commit(root, "seed");
        // Extended index flags force Git to retain index format v3. isomorphic-git
        // 1.40 rejects that real repository shape with "Unsupported dircache version: 3".
        git(root, "update-index", "--index-version", "3");
        git(root, "update-index", "--skip-worktree", "tracked.md");

        const workspaceId = await insertWorkspace(db, `iso-v3-${crypto.randomUUID()}`);
        // Do not use rootWorkspace: it deliberately performs creation-time
        // membership resolution, which is one of the failures asserted below.
        await db.test_set_workspace_root.run({ id: workspaceId, project_root: root });
        process.env.PLURNK_SERVICE_GIT_ISO = "1";

        const actionable = (error: unknown): boolean => {
            assert.ok(error instanceof GitIsoError);
            assert.match(error.message, /Unsupported dircache version: 3/);
            assert.match(error.message, /Disable PLURNK_SERVICE_GIT_ISO/);
            assert.ok(error.cause instanceof Error, "the isomorphic-git failure is preserved as the cause");
            return true;
        };
        await assert.rejects(
            () => GitMembership.resolveGitMembership(db, workspaceId, undefined),
            actionable,
            "workspace membership surfaces the shared backend error",
        );
        await assert.rejects(
            () => GitState.status(db, workspaceId, undefined),
            actionable,
            "status does not swallow the same repository incompatibility",
        );

        delete process.env.PLURNK_SERVICE_GIT_ISO;
        assert.ok(
            (await GitMembership.resolveGitMembership(db, workspaceId, undefined)).includes("tracked.md"),
            "the documented native backend reads the same repository",
        );
        assert.ok(await GitState.status(db, workspaceId, undefined), "native status succeeds too");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_GIT_ISO;
        else process.env.PLURNK_SERVICE_GIT_ISO = prior;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// The gitignore edge-case corpus is the differential gate for the pruning-walk untracked
// scan. Native `ls-files --others --exclude-standard` is the oracle; the walk must reproduce it
// byte-for-byte across: negations, anchored patterns, dir-vs-glob patterns (`build/**` + re-include
// vs `node_modules/` prune), NESTED .gitignore precedence, `.git/info/exclude`, a submodule
// boundary (gitlink — never descended), and an embedded plain repo (its own .git, not a submodule).
test("untracked scan reproduces native --exclude-standard across the gitignore edge-case corpus", async () => {
    const inner = await seedRepo("iso-corpus-sub-");
    await writeFile(join(inner, "inner.txt"), "i\n"); git(inner, "add", "."); commit(inner, "sub seed");
    const root = await seedRepo("iso-corpus-");
    try {
        await writeFile(join(root, ".gitignore"), "*.tmp\n!keep.tmp\nnode_modules/\n/root-only.log\nbuild/**\n!build/keep.txt\n");
        await writeFile(join(root, ".git/info/exclude"), "*.secret\n");
        await mkdir(join(root, "sub"));
        await writeFile(join(root, "sub/.gitignore"), "*.log\n!important.log\n");
        await writeFile(join(root, "a.txt"), "a\n");
        await writeFile(join(root, "sub/s.txt"), "s\n");
        git(root, "add", ".");
        git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendored");
        commit(root, "seed");

        // The untracked working set, expected verdicts per native semantics:
        await writeFile(join(root, "loose.txt"), "l\n");                    // listed
        await writeFile(join(root, "x.tmp"), "x\n");                        // ignored (*.tmp)
        await writeFile(join(root, "keep.tmp"), "k\n");                     // LISTED (negation re-include)
        await mkdir(join(root, "node_modules/pkg"), { recursive: true });
        await writeFile(join(root, "node_modules/pkg/m.js"), "m\n");        // ignored (dir pattern — pruned, cannot re-include under)
        await writeFile(join(root, "root-only.log"), "r\n");                // ignored (anchored at root)
        await writeFile(join(root, "sub/root-only.log"), "r\n");            // LISTED (anchor does not reach sub/)... unless sub/.gitignore *.log — it DOES: ignored
        await writeFile(join(root, "sub/app.log"), "a\n");                  // ignored (nested .gitignore *.log)
        await writeFile(join(root, "sub/important.log"), "i\n");            // LISTED (nested negation)
        await writeFile(join(root, "sub/plain.txt"), "p\n");                // listed
        await mkdir(join(root, "build"));
        await writeFile(join(root, "build/junk.txt"), "j\n");               // ignored (build/**)
        await writeFile(join(root, "build/keep.txt"), "k\n");               // LISTED (glob pattern leaves the dir itself unignored, so the re-include works)
        await writeFile(join(root, "hidden.secret"), "h\n");                // ignored (.git/info/exclude)
        await mkdir(join(root, "newdir/deep"), { recursive: true });
        await writeFile(join(root, "newdir/deep/y.txt"), "y\n");            // listed (untracked dir descent)
        await writeFile(join(root, "vendored/untracked-inner.txt"), "u\n"); // NOT listed (submodule boundary)
        const embedded = join(root, "embedded");
        await mkdir(embedded);
        git(embedded, "init", "-q");
        await writeFile(join(embedded, "e.txt"), "e\n");                    // embedded plain repo — match whatever native does

        const oracle = nativeUntracked(root);
        const walk = (await GitIso.untrackedFiles(root, {})).sort();
        assert.deepEqual(walk, oracle, "the untracked scan reproduces native ls-files --others --exclude-standard exactly");
        // Pin the interesting verdicts explicitly so the oracle itself is validated:
        assert.ok(oracle.includes("keep.tmp"), "negation re-includes a file");
        assert.ok(oracle.includes("build/keep.txt"), "re-include works under a glob'd (not dir-excluded) directory");
        assert.ok(oracle.includes("sub/important.log"), "nested .gitignore negation wins for its subtree");
        assert.ok(!oracle.includes("sub/app.log"), "nested .gitignore ignores its subtree");
        assert.ok(!oracle.includes("hidden.secret"), ".git/info/exclude participates");
        assert.ok(!oracle.includes("root-only.log"), "anchored pattern ignores at root");
        assert.ok(!oracle.some((p) => p.startsWith("node_modules/")), "dir pattern prunes");
        assert.ok(!oracle.some((p) => p.startsWith("vendored/")), "submodule contents are never the superproject's untracked");
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(inner, { recursive: true, force: true });
    }
});

test("native Git is the default; PLURNK_SERVICE_GIT_ISO=1 selects the matching portability backend", async () => {
    const { root } = await seedRich();
    const db = await openMigrated();
    const prior = process.env.PLURNK_SERVICE_GIT_ISO;
    try {
        const workspaceId = await insertWorkspace(db, `iso-flag-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        delete process.env.PLURNK_SERVICE_GIT_ISO;
        const nativeMembers = (await GitMembership.resolveGitMembership(db, workspaceId, undefined)).sort();
        const nativeStatus = await GitState.status(db, workspaceId, undefined);
        process.env.PLURNK_SERVICE_GIT_ISO = "1";
        const isoMembers = (await GitMembership.resolveGitMembership(db, workspaceId, undefined)).sort();
        const isoStatus = await GitState.status(db, workspaceId, undefined);
        assert.deepEqual(nativeMembers, isoMembers, "both backends resolve the identical member set");
        assert.deepEqual(nativeStatus, isoStatus, "both backends report the identical status");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_GIT_ISO; else process.env.PLURNK_SERVICE_GIT_ISO = prior;
        await db.close(); await rm(root, { recursive: true, force: true });
    }
});
