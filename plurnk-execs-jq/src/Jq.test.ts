import test from "node:test";
import { strict as assert } from "node:assert";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import Jq from "./Jq.ts";
import { SPAWN_USER, SpawnAccounts } from "@plurnk/plurnk-execs";
import type { ExecArgs, ExecResult, Notice } from "@plurnk/plurnk-execs";

const HAS_JQ = spawnSync("jq", ["--version"]).status === 0;

interface Capture { result: ExecResult; out: string | undefined; states: string[]; events: Notice[]; }

const run = async (command: string, target: string | null = null, env?: NodeJS.ProcessEnv, cwd: string | null = null): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const events: Notice[] = [];
    const args: ExecArgs = {
        metadata: null,
        runtime: "jq", body: command, cwd, target, env,
        signal: new AbortController().signal,
        write: (_c, chunk) => { out = (out ?? "") + chunk; },
        setState: (_c, s) => states.push(s),
        emit: (e) => events.push(e),
        interact: async () => ({ status: "cancelled" }),
    };
    const result = await new Jq({ runtime: "jq", glyph: "🧰" }).run(args);
    return { result, out, states, events };
};

const tmpFiles: string[] = [];
const tmp = (): string => { const p = join(tmpdir(), `execs-jq-${process.hrtime.bigint()}.json`); tmpFiles.push(p); return p; };
test.afterEach(async () => { await Promise.all(tmpFiles.splice(0).map((p) => rm(p, { force: true }))); });

test("{§executor-discovery} manifest declares jq", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((r: { name: string }) => r.name), ["jq"]);
});

test("{§executor-default-inventory} channels: results (application/jsonl)", () => {
    assert.deepEqual(new Jq({ runtime: "jq", glyph: "🧰" }).channels, { results: { mimetype: "application/jsonl" } });
});

test("{§executor-default-inventory} effect: inline/-n → pure; file-path data source → read", () => {
    const j = new Jq({ runtime: "jq", glyph: "🧰" });
    assert.equal(j.effect(null), "pure");
    assert.equal(j.effect("./data.json"), "read");
});

test("{§executor-probe} probe: reflects jq on PATH", async () => {
    const r = await new Jq({ runtime: "jq", glyph: "🧰" }).probe();
    assert.equal(r.available, HAS_JQ);
});

test("{§executor-default-inventory} inline (-n): a self-contained program computes with no data source", { skip: !HAS_JQ }, async () => {
    const { result, out, states } = await run("[1,2,3] | add");
    assert.equal(result.status, 200);
    assert.equal(out?.trim(), "6");
    assert.deepEqual(states, ["closed"]);
});

test("{§executor-default-inventory} multi-value object output is one compact JSON value per line — honest JSONL", { skip: !HAS_JQ }, async () => {
    // Without -c this object stream pretty-prints across multiple lines and is
    // A comma-joined stream is neither valid application/json nor valid JSONL.
    const { result, out } = await run("[{a:1},{a:2}] | .[]");
    assert.equal(result.status, 200);
    const lines = out!.trim().split("\n");
    assert.equal(lines.length, 2, "each value on its own line");
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { a: 2 }], "every line is a standalone JSON value");
});

test("{§executor-default-inventory} a file-path target is filtered", { skip: !HAS_JQ }, async () => {
    const p = tmp();
    await writeFile(p, JSON.stringify({ users: [{ name: "ada" }, { name: "alan" }] }));
    const { result, out } = await run(".users[].name", p);
    assert.equal(result.status, 200);
    assert.deepEqual(out!.trim().split("\n"), ['"ada"', '"alan"']);
});

test("{§executor-subprocess-routing} a relative target resolves against cwd, not the process dir", { skip: !HAS_JQ }, async () => {
    const full = tmp();
    await writeFile(full, JSON.stringify([{ x: 1 }, { x: 2 }, { x: 3 }]));
    // cwd = the file's dir, target = only its basename → resolves solely because
    // jq runs in cwd (the workspace); against the process dir it'd be not-found.
    const { result, out } = await run("length", basename(full), undefined, tmpdir());
    assert.equal(result.status, 200);
    assert.equal(out?.trim(), "3", "jq resolved the relative target inside cwd");
});

test("empty body defaults to the identity filter `.`", { skip: !HAS_JQ }, async () => {
    const p = tmp();
    await writeFile(p, '{"a":1}');
    const { result, out } = await run("", p);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(out!), { a: 1 });
});

test("{§executor-sinks} env: honors a scoped env; vars the consumer dropped read as null", { skip: !HAS_JQ }, async () => {
    // PATH is needed for spawn to locate jq; FOO is the only data var exposed.
    const seen = await run("env.FOO", null, { PATH: process.env.PATH, FOO: "bar" });
    assert.equal(seen.result.status, 200);
    assert.equal(JSON.parse(seen.out!), "bar");
    // A var absent from the scoped env is invisible to the jq program.
    const dropped = await run("env.PLURNK_SECRET", null, { PATH: process.env.PATH });
    assert.equal(JSON.parse(dropped.out!), null);
});

test("{§problems-executor-jq}: a jq program error → durable Problem, errored channel, 500", { skip: !HAS_JQ }, async () => {
    const { result, events, states } = await run("this is not valid jq");
    assert.equal(result.status, 500);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/jq/jq-error");
    assert.match(result.problem?.detail ?? "", /compile error|syntax error/i);
    assert.equal(events.length, 0);
    assert.equal(states.at(-1), "errored");
});

// {§executor-spawn-account} — jq is a subprocess runtime like any other: the configured account is
// the one it is probed and run as. This host's own account stands in, so no privilege is needed.
const withSpawnUser = async <T>(value: string, body: () => Promise<T>): Promise<T> => {
    const saved = process.env[SPAWN_USER];
    process.env[SPAWN_USER] = value;
    try { return await body(); } finally {
        if (saved === undefined) delete process.env[SPAWN_USER];
        else process.env[SPAWN_USER] = saved;
    }
};

test("{§executor-spawn-account}: jq is probed and run as the configured account, whose name its environment carries", { skip: !HAS_JQ }, async () => {
    const me = userInfo();
    const scoped = { PATH: process.env.PATH, USER: "placeholder", LOGNAME: "placeholder", HOME: "/nowhere" };
    const unset = await withSpawnUser("", () => run("[env.USER, env.LOGNAME, env.HOME]", null, scoped));
    assert.deepEqual(JSON.parse(unset.out!), ["placeholder", "placeholder", "/nowhere"], "unset, the scoped environment is run as handed");
    const account = SpawnAccounts.resolve(me.username);
    await withSpawnUser(me.username, async () => {
        const named = await run("[env.USER, env.LOGNAME, env.HOME]", null, scoped);
        assert.equal(named.result.status, 200);
        assert.deepEqual(JSON.parse(named.out!), [me.username, me.username, account.home ?? "/nowhere"], "the account's name and home replace the scoped ones");
        assert.equal((await new Jq({ runtime: "jq", glyph: "🧰" }).probe()).available, true, "the probe runs as that account too");
    });
    const bare = await withSpawnUser(`${me.uid}:${me.gid}`, () => run("[env.USER, env.HOME]", null, scoped));
    assert.deepEqual(JSON.parse(bare.out!), ["placeholder", "/nowhere"], "a bare id sets the identity and leaves the environment alone");
});

test("{§executor-spawn-account}: an account the daemon may not assume fails the spawn; jq never runs as the daemon's own account in its place", { skip: !HAS_JQ || process.getuid?.() === 0 }, async () => {
    // Any other user's id: an unprivileged daemon may not assume it.
    const other = `${userInfo().uid + 1}:${userInfo().gid + 1}`;
    await withSpawnUser(other, async () => {
        await assert.rejects(new Jq({ runtime: "jq", glyph: "🧰" }).probe(), /EPERM/u, "the probe carries the host's own error");
        let wrote = false;
        const args: ExecArgs = {
            metadata: null, runtime: "jq", body: ".", cwd: null, target: null, env: { PATH: process.env.PATH },
            signal: new AbortController().signal, write: () => { wrote = true; }, setState: () => {}, emit: () => {},
            interact: async () => ({ status: "cancelled" }),
        };
        await assert.rejects(new Jq({ runtime: "jq", glyph: "🧰" }).run(args), /EPERM/u);
        assert.equal(wrote, false, "no output: nothing ran");
    });
});
