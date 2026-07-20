// [§membership-git-hermetic] — #401: a process launched from a git hook inherits GIT_DIR
// (ABSOLUTE in a worktree checkout), which retargets every child git at the enclosing repo
// regardless of cwd. The providers lane's pre-push drill stacked 16 fixture 'seed' commits onto
// her lane branch and deleted tracked files. This pin runs the two spawn classes — a fixture
// sandbox and production membership — under a hostile absolute GIT_DIR aimed at a victim
// worktree, and proves the victim untouched.
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
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, rootWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";

const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP("git", args, { cwd, env: hermeticGitEnv() });
const seed = (cwd: string) => execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd, env: hermeticGitEnv() });

test("[§membership-git-hermetic] fixture + production git spawns ignore a hook's absolute GIT_DIR — the victim worktree stays untouched (#401)", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-hermetic-"));
    const victim = join(base, "victim");
    const priorGitDir = process.env.GIT_DIR;
    const db = await openMigrated();
    try {
        // The victim: a primary repo + a linked worktree — the shape whose hook env poisons.
        await git(["init", "-q", victim], base);
        await git(["config", "user.email", "v@v"], victim);
        await git(["config", "user.name", "v"], victim);
        await writeFile(join(victim, "victim-file.md"), "precious\n");
        await git(["add", "victim-file.md"], victim);
        await seed(victim);
        await git(["worktree", "add", "-q", join(base, "lane"), "-b", "lane"], victim);
        const victimHead = (await git(["rev-parse", "HEAD"], join(base, "lane"))).stdout.trim();

        // The hostile env: exactly what git exports to a pre-push hook in a worktree.
        process.env.GIT_DIR = join(victim, ".git", "worktrees", "lane");

        // Fixture class: a sandbox init + seed commit must land in the SANDBOX.
        const sandbox = await mkdtemp(join(tmpdir(), "plurnk-hermetic-sb-"));
        await git(["init", "-q"], sandbox);
        await git(["config", "user.email", "t@t.t"], sandbox);
        await git(["config", "user.name", "t"], sandbox);
        await writeFile(join(sandbox, "tracked.md"), "# sandbox truth\n");
        await git(["add", "tracked.md"], sandbox);
        await seed(sandbox);
        const sandboxLog = (await git(["log", "--oneline"], sandbox)).stdout;
        assert.match(sandboxLog, /seed/, "the sandbox owns its seed commit");

        // Production class: membership resolution against the sandbox must read the SANDBOX.
        const workspaceId = await insertWorkspace(db, `hermetic-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, sandbox);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, loopId, turnId,
            writer: "plurnk", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            tokenize: (t: string) => Math.ceil(t.length / 4),
        };
        await GitMembership.indexGitMembership(ctx);
        const member = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", pathname: "/tracked.md" });
        assert.ok(member, "membership read the sandbox's ls-files, not the victim's");
        const leak = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", pathname: "/victim-file.md" });
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

test("[§membership-git-hermetic] a spawn under hermeticGitEnv severs a hostile GLOBAL core.hooksPath — it never fires or escapes (#428)", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-hooksesc-"));
    const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
    try {
        // A HOSTILE machine global config: core.hooksPath → a hook dir whose pre-commit fires a marker.
        // This is the #428 vector — a real global core.hooksPath (the dotfiles hook) a sandbox git read.
        const evilHooks = join(base, "evil-hooks"); await mkdir(evilHooks);
        const marker = join(base, "PWNED");
        await writeFile(join(evilHooks, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`); await chmod(join(evilHooks, "pre-commit"), 0o755);
        const hostileGlobal = join(base, "hostile-gitconfig");
        await writeFile(hostileGlobal, `[core]\n\thooksPath = ${evilHooks}\n`);
        process.env.GIT_CONFIG_GLOBAL = hostileGlobal; // the machine's global config is now hostile

        const commit = async (repo: string, env: NodeJS.ProcessEnv): Promise<void> => {
            await mkdir(repo, { recursive: true });
            const g = (args: string[]) => execFileP("git", args, { cwd: repo, env });
            await g(["init", "-q"]); await g(["config", "user.email", "t@t"]); await g(["config", "user.name", "t"]);
            await writeFile(join(repo, "f.md"), "x"); await g(["add", "f.md"]);
            await g(["commit", "-q", "-m", "c"]); // NO --no-verify, NO -c hooksPath — a global hook WOULD fire if read
        };

        // CONTROL: a GIT_*-scrubbed env + the hostile global DOES fire the hook — proves the vector is
        // real, not a tautology. The scrub is essential and self-referential: raw process.env would
        // inherit a pre-push hook's absolute GIT_DIR (this test runs inside the drill) and the control
        // commit would ESCAPE into the worktree — the very #401/#428 class under test. Scrubbing GIT_*
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
