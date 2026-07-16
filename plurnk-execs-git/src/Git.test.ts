import test, { after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import Git from "./Git.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

interface Capture {
    result: ExecResult;
    out: string | undefined;
    states: string[];
    events: TelemetryEvent[];
}

const run = async (command: string, cwd: string | null = null, target: string | null = null): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime: "git", command, cwd, target,
        signal: new AbortController().signal,
        write: (_channel, chunk) => { out = (out ?? "") + chunk; },
        setState: (_channel, state) => states.push(state),
        emit: (event) => events.push(event),
    };
    const result = await new Git({ runtime: "git", glyph: "🔀" }).run(args);
    return { result, out, states, events };
};

// Real temp repos, torn down together at the end of the suite.
const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "git-exec-"));
    dirs.push(dir);
    return dir;
};
const initRepo = async (): Promise<string> => {
    const dir = await tempDir();
    await git.init({ fs, dir });
    return dir;
};
// isomorphic-git reads ONLY the repo-local config — seed user.name/user.email there.
const configuredRepo = async (): Promise<string> => {
    const dir = await initRepo();
    await git.setConfig({ fs, dir, path: "user.name", value: "Test Author" });
    await git.setConfig({ fs, dir, path: "user.email", value: "author@example.com" });
    return dir;
};
const seedCommit = async (dir: string, name: string, message: string): Promise<void> => {
    await writeFile(join(dir, name), `${message}\n`);
    await git.add({ fs, dir, filepath: name });
    await git.commit({ fs, dir, message, author: { name: "Test Author", email: "author@example.com" } });
};
after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("manifest declares exactly the git runtime (gh is gone) with <<-delimited examples", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((r: { name: string }) => r.name), ["git"]);
    const example: string = pkg.plurnk.runtimes[0].example;
    assert.ok(example.length > 0);
    for (const line of example.split("\n")) assert.match(line, /^<<EXEC\[git\]:.+:EXEC$/);
});

test("declares a single results channel (application/json)", () => {
    assert.deepEqual(new Git({ runtime: "git", glyph: "🔀" }).channels, {
        results: { mimetype: "application/json" },
    });
});

test("probe: always available — in-process, nothing on PATH to check", async () => {
    assert.deepEqual(await new Git({ runtime: "git", glyph: "🔀" }).probe(), {
        available: true, detail: "isomorphic-git (in-process)",
    });
});

test("effect: inherited host regardless of target — mutating verbs exist, every op proposes", () => {
    const ex = new Git({ runtime: "git", glyph: "🔀" });
    assert.equal(ex.effect(null), "host");
    assert.equal(ex.effect("some/repo"), "host");
});

test("init: creates .git, returns {initialized} JSON, 200, channel closed", async () => {
    const dir = await tempDir();
    const { result, out, states, events } = await run("init", dir);
    assert.deepEqual(result, { status: 200 });
    assert.deepEqual(JSON.parse(out!), { initialized: dir });
    assert.deepEqual(states, ["closed"]);
    assert.equal(events.length, 0);
    assert.ok((await stat(join(dir, ".git"))).isDirectory());
});

test("status: fresh repo + one untracked file → {branch, changes:[untracked]}", async () => {
    const dir = await initRepo();
    await writeFile(join(dir, "notes.txt"), "hello\n");
    const { result, out } = await run("status", dir);
    assert.equal(result.status, 200);
    const { branch, changes } = JSON.parse(out!);
    assert.ok(["master", "main"].includes(branch));
    assert.deepEqual(changes, [{ path: "notes.txt", status: "untracked" }]);
});

test("add + status: a staged new file reports as added", async () => {
    const dir = await initRepo();
    await writeFile(join(dir, "a.txt"), "one\n");
    const add = await run("add a.txt", dir);
    assert.equal(add.result.status, 200);
    assert.deepEqual(JSON.parse(add.out!), { staged: ["a.txt"] });
    const status = await run("status", dir);
    assert.deepEqual(JSON.parse(status.out!).changes, [{ path: "a.txt", status: "added" }]);
});

test("commit: repo-config author → {oid, message}, oid is 40-hex", async () => {
    const dir = await configuredRepo();
    await writeFile(join(dir, "a.txt"), "one\n");
    await run("add a.txt", dir);
    const { result, out, states } = await run('commit -m "first commit"', dir);
    assert.deepEqual(result, { status: 200 });
    const { oid, message } = JSON.parse(out!);
    assert.match(oid, /^[0-9a-f]{40}$/);
    assert.equal(message, "first commit");
    assert.deepEqual(states, ["closed"]);
});

test("commit: no user.name/user.email in repo config → git_no_author, 500, errored", async () => {
    const dir = await initRepo();
    await writeFile(join(dir, "a.txt"), "one\n");
    await run("add a.txt", dir);
    const { result, out, states, events } = await run('commit -m "anonymous"', dir);
    assert.equal(result.status, 500);
    assert.equal(out, undefined);
    assert.equal(events[0].source, "exec:git");
    assert.equal(events[0].kind, "git_no_author");
    assert.deepEqual(states, ["errored"]);
});

test("commit without -m → git_bad_arguments, 400", async () => {
    const dir = await configuredRepo();
    const { result, out, states, events } = await run("commit", dir);
    assert.equal(result.status, 400);
    assert.equal(out, undefined);
    assert.equal(events[0].kind, "git_bad_arguments");
    assert.deepEqual(states, ["errored"]);
});

test("log: two commits → [{oid, message, author, date}] newest-first; -n 1 truncates", async () => {
    const dir = await configuredRepo();
    await seedCommit(dir, "a.txt", "first");
    await seedCommit(dir, "b.txt", "second");
    const { result, out } = await run("log", dir);
    assert.equal(result.status, 200);
    const commits = JSON.parse(out!);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map((c: { message: string }) => c.message), ["second", "first"]);
    for (const c of commits) {
        assert.match(c.oid, /^[0-9a-f]{40}$/);
        assert.equal(c.author, "Test Author");
        assert.equal(new Date(c.date).toISOString(), c.date);
    }
    const limited = await run("log -n 1", dir);
    assert.deepEqual(JSON.parse(limited.out!).map((c: { message: string }) => c.message), ["second"]);
});

test("branch: bare lists {current, branches}; `branch feature` creates without switching", async () => {
    const dir = await configuredRepo();
    await seedCommit(dir, "a.txt", "first");
    const list = await run("branch", dir);
    assert.equal(list.result.status, 200);
    const { current, branches } = JSON.parse(list.out!);
    assert.ok(["master", "main"].includes(current));
    assert.deepEqual(branches, [current]);
    const create = await run("branch feature", dir);
    assert.equal(create.result.status, 200);
    assert.deepEqual(JSON.parse(create.out!), { created: "feature" });
    assert.ok((await git.listBranches({ fs, dir })).includes("feature"));
    assert.equal(await git.currentBranch({ fs, dir, fullname: false }), current);
});

test("checkout: switches the current branch", async () => {
    const dir = await configuredRepo();
    await seedCommit(dir, "a.txt", "first");
    await run("branch feature", dir);
    const { result, out } = await run("checkout feature", dir);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(out!), { checkedOut: "feature" });
    assert.equal(await git.currentBranch({ fs, dir, fullname: false }), "feature");
});

test("unknown verb (push is unsupported day-one) → git_unknown_op, 400, names the verb set", async () => {
    const dir = await initRepo();
    const { result, out, states, events } = await run("push origin main", dir);
    assert.equal(result.status, 400);
    assert.equal(out, undefined);
    assert.equal(events[0].source, "exec:git");
    assert.equal(events[0].kind, "git_unknown_op");
    assert.match(String(events[0].message), /'push'/);
    assert.match(String(events[0].message), /init, status, add, commit, log, branch, checkout/);
    assert.deepEqual(states, ["errored"]);
});

test("a relative target resolves the repo dir against cwd — ops hit the subdir, not cwd (#15)", async () => {
    const parent = await tempDir();
    await mkdir(join(parent, "repo"));
    const init = await run("init", parent, "repo");
    assert.equal(init.result.status, 200);
    assert.deepEqual(JSON.parse(init.out!), { initialized: join(parent, "repo") });
    assert.ok((await stat(join(parent, "repo", ".git"))).isDirectory());
    await assert.rejects(stat(join(parent, ".git")), { code: "ENOENT" });
    await writeFile(join(parent, "repo", "f.txt"), "x\n");
    const status = await run("status", parent, "repo");
    assert.deepEqual(JSON.parse(status.out!).changes, [{ path: "f.txt", status: "untracked" }]);
});

// SPEC §6 — must honor args.signal. A pre-aborted signal is honored at entry:
// nothing is written, no repo is touched, and the channel closes errored with 499.
test("pre-aborted signal → 499 errored, no write, repo untouched", async () => {
    const dir = await tempDir();
    const ac = new AbortController();
    ac.abort();
    const states: string[] = [];
    let wrote = false;
    const args: ExecArgs = {
        runtime: "git", command: "init", cwd: dir, target: null,
        signal: ac.signal,
        write: () => { wrote = true; },
        setState: (_channel, state) => states.push(state),
        emit: () => {},
    };
    const result = await new Git({ runtime: "git", glyph: "🔀" }).run(args);
    assert.equal(result.status, 499);
    assert.equal(wrote, false);
    assert.deepEqual(states, ["errored"]);
    await assert.rejects(stat(join(dir, ".git")), { code: "ENOENT" });
});
