// {§membership-git-hermetic} — fixture and production Git spawns ignore a hostile
// launch environment, bind repository identity to cwd, and never consume global hooks.
import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import GitMembership from "../../src/core/git-membership.ts";
import GitState from "../../src/core/git-state.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { openMigrated, insertWorkspace, rootWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { initializeDemoRepository } from "../demo/_git.ts";

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP("git", args, { cwd, env: hermeticGitEnv() });
const seed = (cwd: string) => execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd, env: hermeticGitEnv() });

test("demo fixture + production git spawns ignore a hook's absolute GIT_DIR — the victim worktree stays untouched", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-hermetic-"));
    const victim = join(base, "victim");
    const priorGitDir = process.env.GIT_DIR;
    const db = await openMigrated();
    try {
        // The victim: a primary repo + a linked worktree — the shape whose hook env poisons.
        await git(["init", "-q", victim], base);
        await git(["config", "user.email", "victim@plurnk.invalid"], victim);
        await git(["config", "user.name", "v"], victim);
        await writeFile(join(victim, "victim-file.md"), "precious\n");
        await git(["add", "victim-file.md"], victim);
        await seed(victim);
        await git(["worktree", "add", "-q", join(base, "lane"), "-b", "lane"], victim);
        const victimHead = (await git(["rev-parse", "HEAD"], join(base, "lane"))).stdout.trim();

        // The hostile env: exactly what git exports to a pre-push hook in a worktree.
        process.env.GIT_DIR = join(victim, ".git", "worktrees", "lane");

        // Fixture class: a sandbox init + seed commit must land in the SANDBOX.
        const sandbox = join(base, "sandbox");
        await mkdir(sandbox);
        await writeFile(join(sandbox, "tracked.md"), "# sandbox truth\n");
        initializeDemoRepository(sandbox, "seed");
        const sandboxLog = (await git(["log", "--oneline"], sandbox)).stdout;
        assert.match(sandboxLog, /seed/, "the sandbox owns its seed commit");

        const emptySandbox = join(base, "empty-sandbox");
        await mkdir(emptySandbox);
        initializeDemoRepository(emptySandbox, "empty seed", false);
        const emptyLog = (await git(["log", "--oneline"], emptySandbox)).stdout;
        assert.match(emptyLog, /empty seed/, "the empty-workspace fixture owns its seed commit");

        // Production class: membership resolution against the sandbox must read the SANDBOX.
        const workspaceId = await insertWorkspace(db, `hermetic-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, sandbox);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, functionalityWorkerId: workerId, loopId, turnId,
            writer: "_plurnk", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await GitMembership.indexGitMembership(ctx);
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", authority: "", pathname: "tracked.md" });
        assert.ok(member, "membership read the sandbox's ls-files, not the victim's");
        const leak = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", authority: "", pathname: "victim-file.md" });
        assert.equal(leak, undefined, "no victim file leaked into membership");

        // The victim is pristine: same HEAD, clean tree, no seed stacked on the lane branch.
        const laneHead = (await git(["rev-parse", "HEAD"], join(base, "lane"))).stdout.trim();
        assert.equal(laneHead, victimHead, "no commit landed on the victim's lane branch");
        const status = (await git(["status", "--short"], join(base, "lane"))).stdout.trim();
        assert.equal(status, "", "the victim's working tree is untouched — no deleted tracked files");
    } finally {
        if (priorGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = priorGitDir;
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

test("a spawn under hermeticGitEnv severs a hostile GLOBAL core.hooksPath — it never fires or escapes", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-hooksesc-"));
    const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
    try {
        // A HOSTILE machine global config: core.hooksPath → a hook dir whose pre-commit fires a marker.
        // A real global core.hooksPath is the hostile machine-config vector under test.
        const evilHooks = join(base, "evil-hooks"); await mkdir(evilHooks);
        const marker = join(base, "PWNED");
        await writeFile(join(evilHooks, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`); await chmod(join(evilHooks, "pre-commit"), 0o755);
        const hostileGlobal = join(base, "hostile-gitconfig");
        await writeFile(hostileGlobal, `[core]\n\thooksPath = ${evilHooks}\n`);
        process.env.GIT_CONFIG_GLOBAL = hostileGlobal; // the machine's global config is now hostile

        const commit = async (repo: string, env: NodeJS.ProcessEnv): Promise<void> => {
            await mkdir(repo, { recursive: true });
            const g = (args: string[]) => execFileP("git", args, { cwd: repo, env });
            await g(["init", "-q"]); await g(["config", "user.email", "fixture@plurnk.invalid"]); await g(["config", "user.name", "t"]);
            await writeFile(join(repo, "f.md"), "x"); await g(["add", "f.md"]);
            await g(["commit", "-q", "-m", "c"]); // NO --no-verify, NO -c hooksPath — a global hook WOULD fire if read
        };

        // CONTROL: a GIT_*-scrubbed env + the hostile global DOES fire the hook — proves the vector is
        // real, not a tautology. The scrub is essential and self-referential: raw process.env would
        // inherit a pre-push hook's absolute GIT_DIR (this test runs inside the drill) and the control
        // commit would escape into the worktree. Scrubbing GIT_*
        // (what hermeticGitEnv also does) confines the commit to its own repo while the hostile
        // GIT_CONFIG_GLOBAL still routes the hook.
        const scrubbedGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
        await commit(join(base, "raw"), { ...scrubbedGit, GIT_CONFIG_GLOBAL: hostileGlobal });
        assert.ok(existsSync(marker), "control: under the hostile global config, the hook fires");

        // THE FIX: the same commit under hermeticGitEnv (GIT_CONFIG_GLOBAL → /dev/null) does NOT read it.
        const marker2 = join(base, "PWNED2");
        await writeFile(join(evilHooks, "pre-commit"), `#!/bin/sh\ntouch "${marker2}"\n`); await chmod(join(evilHooks, "pre-commit"), 0o755);
        await commit(join(base, "hermetic"), hermeticGitEnv());
        assert.ok(!existsSync(marker2), "hermeticGitEnv severed the global config — the hostile hooksPath never fired");
    } finally {
        if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
        await rm(base, { recursive: true, force: true });
    }
});

// #568 — a supplied repository's OWN config names a program (`core.fsmonitor`); automatic
// inspection (status, membership) must not run it as the daemon. Control first: the vector is real.
test("automatic inspection never runs a repository-supplied core.fsmonitor helper — status and membership stay normal", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-fsmonitor-"));
    const repo = join(base, "supplied");
    const marker = join(base, "HELPER-RAN");
    const db = await openMigrated();
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    try {
        await mkdir(repo);
        await git(["init", "-q"], repo);
        await git(["config", "user.email", "s@plurnk.invalid"], repo);
        await git(["config", "user.name", "s"], repo);
        await writeFile(join(repo, "tracked.md"), "# tracked\n");
        await git(["add", "tracked.md"], repo);
        await seed(repo);
        // The hostile local config: a benign helper that leaves a marker OUTSIDE the repository and
        // then fails, which makes git fall back to a full scan (so status still answers).
        const helper = join(base, "fsmonitor-helper.sh");
        await writeFile(helper, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
        await chmod(helper, 0o755);
        await git(["config", "core.fsmonitor", helper], repo);
        await writeFile(join(repo, "tracked.md"), "# tracked\n\nedit\n");  // give refresh something to look at

        // CONTROL: a GIT_*-scrubbed env without the pin DOES run the repository's helper.
        const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
        await execFileP("git", ["status", "--porcelain=v1", "-z"], { cwd: repo, env: { ...scrubbed, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
        assert.ok(existsSync(marker), "control: without the pin, the supplied repository's fsmonitor helper runs");
        await rm(marker, { force: true });

        // PRODUCTION: GitState.status and membership indexing, both through hermeticGitEnv.
        const workspaceId = await insertWorkspace(db, `fsmonitor-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, repo);
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const status = await GitState.status(db, workspaceId, undefined);
        assert.ok(status, "status still answers under the pinned configuration");
        assert.deepEqual(status.files.map((file) => file.path), ["tracked.md"], "ordinary status content is intact");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, functionalityWorkerId: workerId, loopId, turnId,
            writer: "_plurnk", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await GitMembership.indexGitMembership(ctx);
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", authority: "", pathname: "tracked.md" });
        assert.ok(member, "membership still indexes the tracked file");
        assert.ok(!existsSync(marker), "neither status nor membership ran the repository-supplied helper");
    } finally {
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

// {§membership-git-hermetic} (#568 residual): no key can pin off an arbitrary `filter.<name>` driver,
// so a supplied repository declaring one is refused for automatic inspection — a warning-and-skip.
test("automatic inspection refuses a supplied repository declaring a filter program — status and membership skip, one notice names the key", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-filter-"));
    const repo = join(base, "supplied");
    const marker = join(base, "FILTER-RAN");
    const db = await openMigrated();
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    try {
        await mkdir(repo);
        await git(["init", "-q"], repo);
        await git(["config", "user.email", "s@plurnk.invalid"], repo);
        await git(["config", "user.name", "s"], repo);
        await writeFile(join(repo, ".gitattributes"), "*.md filter=marker\n");
        await writeFile(join(repo, "tracked.md"), "# tracked\n");
        await git(["add", ".gitattributes", "tracked.md"], repo);
        await seed(repo);
        // The hostile local config: a clean driver that leaves a marker OUTSIDE the repository.
        const helper = join(base, "clean-helper.sh");
        await writeFile(helper, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
        await chmod(helper, 0o755);
        await git(["config", "filter.marker.clean", helper], repo);
        await git(["config", "filter.marker.required", "true"], repo);

        // A touched mapped file: its stat data no longer matches the index, so the next status
        // refresh must re-hash it through the clean driver to decide whether it changed.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await writeFile(join(repo, "tracked.md"), "# touched\n");

        // CONTROL: the very status command production runs, under the pinned env, DOES run the driver.
        await execFileP("git", ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], { cwd: repo, env: hermeticGitEnv() });
        assert.ok(existsSync(marker), "control: `git status` on the supplied repository runs its clean driver — no key pins it off");
        await rm(marker, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await writeFile(join(repo, "tracked.md"), "# touched again\n");

        // PRODUCTION: automatic inspection through the shared boundary refuses the repository.
        const workspaceId = await insertWorkspace(db, `filter-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, repo);
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        process.env.PLURNK_SERVICE_GIT_AUTO = "1";
        assert.equal(await GitState.status(db, workspaceId, undefined), null, "status answers as for a non-repository");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const notices: Array<Record<string, unknown>> = [];
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, functionalityWorkerId: workerId, loopId, turnId,
            writer: "_plurnk", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            weigh: (t: string) => Math.ceil(t.length / 4),
            pushNotice: (notice) => { notices.push(notice as Record<string, unknown>); },
        };
        await GitMembership.indexGitMembership(ctx);
        await GitMembership.indexGitMembership(ctx);
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", authority: "", pathname: "tracked.md" });
        assert.equal(member, undefined, "no automatic membership from the refused repository");
        assert.ok(!existsSync(marker), "neither status nor membership ran the repository-supplied driver");
        assert.deepEqual(notices, [{
            source: "engine:membership",
            kind: "git_inspection_refused",
            level: "warn",
            message: "Automatic Git inspection is off for this repository: its config declares filter.marker.clean, a program git status could run. Git status and automatic Git membership are skipped; explicit git commands are unaffected.",
        }], "one notice names the key, announced once across passes");

        // CONTROL: an ordinary repository still indexes and answers status through the same boundary.
        const plain = join(base, "plain");
        await mkdir(plain);
        await git(["init", "-q"], plain);
        await git(["config", "user.email", "s@plurnk.invalid"], plain);
        await git(["config", "user.name", "s"], plain);
        await writeFile(join(plain, "ok.md"), "# ok\n");
        await git(["add", "ok.md"], plain);
        await seed(plain);
        const plainWorkspace = await insertWorkspace(db, `plain-${crypto.randomUUID()}`);
        await rootWorkspace(db, plainWorkspace, plain);
        assert.deepEqual((await GitState.status(db, plainWorkspace, undefined))?.branch !== undefined, true, "an ordinary repository still answers status");
        const plainWorker = await insertWorker(db, plainWorkspace);
        const plainLoop = await insertLoop(db, plainWorker, 1);
        const plainTurn = await insertTurn(db, plainLoop, 1, 102);
        const plainNotices: unknown[] = [];
        await GitMembership.indexGitMembership({
            ...ctx, workspaceId: plainWorkspace, workerId: plainWorker, functionalityWorkerId: plainWorker, loopId: plainLoop, turnId: plainTurn,
            pushNotice: (notice) => { plainNotices.push(notice); },
        });
        const plainMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: plainWorkspace, owner_id: await Owner.commonsId(db, plainWorkspace), scheme: "file", authority: "", pathname: "ok.md" });
        assert.ok(plainMember, "an ordinary repository still indexes its tracked file");
        assert.deepEqual(plainNotices, [], "no refusal notice for an ordinary repository");
    } finally {
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});
