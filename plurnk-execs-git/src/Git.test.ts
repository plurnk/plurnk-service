import test, { after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Git from "./Git.ts";
import type { ExecArgs, ExecResult } from "@plurnk/plurnk-execs";

interface Capture {
    result: ExecResult;
    out: Record<string, string>;
    states: Record<string, string[]>;
}

const present = (): boolean => spawnSync("git", ["--version"]).status === 0;
const make = (): Git => new Git({ runtime: "git", glyph: "git" });
const run = async (
    command: string,
    cwd: string | null = null,
    target: string | null = null,
    env?: NodeJS.ProcessEnv,
): Promise<Capture> => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const states: Record<string, string[]> = { stdout: [], stderr: [] };
    const args: ExecArgs = {
        runtime: "git",
        command,
        cwd,
        target,
        env,
        signal: new AbortController().signal,
        write: (channel, chunk) => { out[channel] = (out[channel] ?? "") + chunk; },
        setState: (channel, state) => { (states[channel] ??= []).push(state); },
        emit: () => {},
    };
    const result = await make().run(args);
    return { result, out, states };
};

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "git-exec-"));
    dirs.push(dir);
    return dir;
};
after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("manifest declares the native git runtime with valid examples", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((runtime: { name: string }) => runtime.name), ["git"]);
    const examples = pkg.plurnk.runtimes[0].example.split("\n\n");
    assert.equal(examples.length, 2);
    for (const example of examples) {
        assert.match(example, /^## EXEC0 \[git\]\n.+$/);
    }
});

test("native Git exposes stdout/stderr streams and remains host-effecting", () => {
    const executor = make();
    assert.deepEqual(executor.channels, {
        stdout: { mimetype: "text/stream" },
        stderr: { mimetype: "text/stream" },
    });
    assert.equal(executor.effect(null), "host");
    assert.equal(executor.effect("some/repo"), "host");
});

test("native Git receives familiar argv directly, with target mapped to -C", () => {
    const executor = make();
    // @ts-expect-error Exercise the protected translation seam.
    assert.deepEqual(executor.spawnArgs("git", 'commit -m "costs $5"', null), {
        cmd: "git",
        args: ["commit", "-m", "costs $5"],
        useShell: false,
    });
    // @ts-expect-error Exercise the protected translation seam.
    assert.deepEqual(executor.spawnArgs("git", "status --short", "./subrepo"), {
        cmd: "git",
        args: ["-C", "./subrepo", "status", "--short"],
        useShell: false,
    });
});

test("malformed quoted argv returns a durable input Problem", async () => {
    const { result, states } = await run('commit -m "unterminated');
    assert.equal(result.status, 400);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/executor/subprocess/invalid-command");
    assert.equal(result.problem?.detail, "Could not parse the 'git' command: unterminated double quote.");
    assert.deepEqual(states, { stdout: ["errored"], stderr: ["errored"] });
});

test("probe reflects native Git availability", async () => {
    assert.equal((await make().probe()).available, present());
});

test("native Git binds repository identity to cwd despite an inherited hook GIT_DIR", { skip: !present() }, async () => {
    const victim = await tempDir();
    const sandbox = await tempDir();
    assert.equal((await run("init -q", victim)).result.status, 200);

    const inheritedHookEnv = { ...process.env, GIT_DIR: join(victim, ".git") };
    assert.equal((await run("init -q", sandbox, null, inheritedHookEnv)).result.status, 200);
    assert.equal((await run("config user.email sandbox@plurnk.invalid", sandbox, null, inheritedHookEnv)).result.status, 200);

    await access(join(sandbox, ".git"));
    assert.match(await readFile(join(sandbox, ".git", "config"), "utf8"), /sandbox@plurnk\.invalid/);
    assert.doesNotMatch(await readFile(join(victim, ".git", "config"), "utf8"), /sandbox@plurnk\.invalid/);
});

test("native checkout -b works through the executor without syntax translation", { skip: !present() }, async () => {
    const dir = await tempDir();
    assert.equal((await run("init -q", dir)).result.status, 200);
    assert.equal((await run("config user.email fixture@plurnk.invalid", dir)).result.status, 200);
    assert.equal((await run('config user.name "Plurnk Fixture"', dir)).result.status, 200);
    await writeFile(join(dir, "a.txt"), "first\n");
    assert.equal((await run("add a.txt", dir)).result.status, 200);
    assert.equal((await run('-c commit.gpgsign=false commit --no-verify -m "first commit"', dir)).result.status, 200);

    const checkout = await run("checkout -b feature/module-loading", dir);
    assert.equal(checkout.result.status, 200);
    assert.match(checkout.out.stderr, /feature\/module-loading/);
    assert.deepEqual(checkout.states, { stdout: ["closed"], stderr: ["closed"] });

    const branch = await run("branch --show-current", null, dir);
    assert.equal(branch.result.status, 200);
    assert.equal(branch.out.stdout.trim(), "feature/module-loading");
});
