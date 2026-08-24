import test, { after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import git from "isomorphic-git";
import Isogit from "./Isogit.ts";
import { discover, type ExecArgs, type ExecResult } from "@plurnk/plurnk-execs";

interface Capture {
    result: ExecResult;
    out: string | undefined;
    states: string[];
}

const run = async (command: string, cwd: string, signal = new AbortController().signal): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const args: ExecArgs = {
        runtime: "isogit",
        body: command,
        cwd,
        target: null,
        signal,
        write: (_channel, chunk) => { out = (out ?? "") + chunk; },
        setState: (_channel, state) => states.push(state),
        emit: () => {},
        interact: async () => ({ status: "cancelled" }),
    };
    const result = await new Isogit({ runtime: "isogit", glyph: "git" }).run(args);
    return { result, out, states };
};

const dirs: string[] = [];
const configuredRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "isogit-exec-"));
    dirs.push(dir);
    await git.init({ fs, dir });
    await git.setConfig({ fs, dir, path: "user.name", value: "Test Author" });
    await git.setConfig({ fs, dir, path: "user.email", value: "author@example.com" });
    return dir;
};
const seedCommit = async (dir: string): Promise<string> => {
    await writeFile(join(dir, "a.txt"), "first\n");
    await git.add({ fs, dir, filepath: "a.txt" });
    return git.commit({ fs, dir, message: "first", author: { name: "Test Author", email: "author@example.com" } });
};
after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("manifest declares only the explicit isogit runtime, disabled by its shipped default", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((runtime: { name: string }) => runtime.name), ["isogit"]);
    assert.deepEqual(pkg.plurnk.runtimes[0].invocation, {
        body: { role: "isogit command and arguments", required: true },
        target: { role: "repository directory", required: false, kind: "path" },
        example: { target: ".", body: "status" },
    });
    assert.match(await readFile(new URL("../.env.defaults", import.meta.url), "utf8"), /^PLURNK_EXECS_ISOGIT=0$/m);
});

test("runtime discovery omits isogit by default and registers it only when explicitly enabled", async () => {
    const prior = process.env.PLURNK_EXECS_ISOGIT;
    const packageDir = fileURLToPath(new URL("..", import.meta.url));
    try {
        process.env.PLURNK_EXECS_ISOGIT = "0";
        const disabled = await discover({ packageDirs: [packageDir] });
        assert.equal(disabled.registry.has("isogit"), false);
        assert.deepEqual(disabled.disabled, ["isogit"]);

        process.env.PLURNK_EXECS_ISOGIT = "1";
        const enabled = await discover({ packageDirs: [packageDir] });
        assert.equal(enabled.registry.get("isogit")?.packageName, "@plurnk/plurnk-execs-isogit");
        assert.deepEqual(enabled.disabled, []);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_EXECS_ISOGIT;
        else process.env.PLURNK_EXECS_ISOGIT = prior;
    }
});

test("isogit is in-process, JSON-returning, and host-effecting", async () => {
    const executor = new Isogit({ runtime: "isogit", glyph: "git" });
    assert.deepEqual(executor.channels, { results: { mimetype: "application/json" } });
    assert.deepEqual(await executor.probe(), { available: true, detail: "isomorphic-git (in-process subset)" });
    assert.equal(executor.effect(null), "host");
});

test("status, add, commit, and log implement the documented JSON subset", async () => {
    const dir = await configuredRepo();
    await writeFile(join(dir, "a.txt"), "first\n");
    const status = await run("status", dir);
    assert.deepEqual(JSON.parse(status.out!), {
        branch: await git.currentBranch({ fs, dir, fullname: false }),
        changes: [{ path: "a.txt", status: "untracked" }],
    });
    assert.equal((await run("add a.txt", dir)).result.status, 200);
    const commit = await run('commit -m "first commit"', dir);
    assert.equal(commit.result.status, 200);
    assert.equal(JSON.parse(commit.out!).message, "first commit");
    const log = await run("log -n 1", dir);
    assert.equal(JSON.parse(log.out!)[0].message, "first commit");
});

test("branch and checkout remain separate operations", async () => {
    const dir = await configuredRepo();
    await seedCommit(dir);
    const create = await run("branch feature/example", dir);
    assert.deepEqual(JSON.parse(create.out!), { created: "feature/example" });
    assert.notEqual(await git.currentBranch({ fs, dir, fullname: false }), "feature/example");
    const checkout = await run("checkout feature/example", dir);
    assert.deepEqual(JSON.parse(checkout.out!), { checkedOut: "feature/example" });
    assert.equal(await git.currentBranch({ fs, dir, fullname: false }), "feature/example");
});

test("native checkout -b syntax is rejected precisely instead of misread as a ref", async () => {
    const dir = await configuredRepo();
    await seedCommit(dir);
    const { result, out, states } = await run("checkout -b feature/example", dir);
    assert.equal(result.status, 400);
    assert.equal(out, undefined);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/isogit/bad-arguments");
    assert.match(result.problem?.detail ?? "", /accepts one existing branch or object reference/);
    assert.equal(
        result.problem?.recovery,
        "Use 'branch <name>' then 'checkout <name>', or use `## EXEC0 [git]` for native Git syntax.",
    );
    assert.deepEqual(states, ["errored"]);
});

test("unknown operations name the subset and direct native work to the Git EXEC heading", async () => {
    const dir = await configuredRepo();
    const { result } = await run("push origin main", dir);
    assert.equal(result.status, 400);
    assert.deepEqual(
        result.problem?.availableOperations,
        ["init", "status", "add", "commit", "log", "branch", "checkout"],
    );
    assert.equal(result.problem?.recovery, "Use a supported isogit operation or `## EXEC0 [git]` for native Git.");
});

test("a pre-aborted operation returns 499 without touching the repo", async () => {
    const dir = await configuredRepo();
    const controller = new AbortController();
    controller.abort();
    const { result, states } = await run("status", dir, controller.signal);
    assert.equal(result.status, 499);
    assert.deepEqual(states, ["errored"]);
});
