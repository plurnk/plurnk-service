import test from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import Common, { RUNTIME_TAGS } from "./Common.ts";
import type { ExecArgs, ExecResult } from "@plurnk/plurnk-execs";

const present = (bin: string): boolean => spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin]).status === 0;

const make = (tag: string): Common => new Common({ runtime: tag, glyph: "•" });

const run = async (tag: string, command: string): Promise<{ result: ExecResult; out: Record<string, string> }> => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const args: ExecArgs = {
        runtime: tag, command, cwd: null, target: null,
        signal: new AbortController().signal,
        write: (c, chunk) => { out[c] = (out[c] ?? "") + chunk; },
        setState: () => {}, emit: () => {},
    };
    const result = await make(tag).run(args);
    return { result, out };
};

test("manifest declares the candidate common-REPL tags, matching RUNTIME_TAGS", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    const manifest = pkg.plurnk.runtimes.map((r: { name: string }) => r.name);
    assert.deepEqual(manifest, [...RUNTIME_TAGS]);
    assert.deepEqual(manifest, [
        "sh", "bash", "node", "python",
        "perl", "ruby", "php", "lua", "deno", "bun", "tcl", "bc", "awk",
    ]);
});

test("spawnArgs: the subprocess floor (sh/node/python)", () => {
    // @ts-expect-error exercise the protected hook
    assert.deepEqual(make("sh").spawnArgs("sh", "echo hi"), { cmd: "sh", args: ["-c", "echo hi"], useShell: false });
    // @ts-expect-error
    assert.deepEqual(make("node").spawnArgs("node", "console.log(1)"), { cmd: "node", args: ["-e", "console.log(1)"], useShell: false });
    // @ts-expect-error
    assert.deepEqual(make("python").spawnArgs("python", "print(1)"), { cmd: "python3", args: ["-c", "print(1)"], useShell: false });
});

test("spawnArgs: a target runs the program with body as stdin — shell via -c, interpreter as a script file (#15)", () => {
    // @ts-expect-error protected hook
    assert.deepEqual(make("sh").spawnArgs("sh", "stdin body", "./run.sh"), { cmd: "sh", args: ["-c", "./run.sh"], useShell: false, stdin: "stdin body" });
    // @ts-expect-error
    assert.deepEqual(make("python").spawnArgs("python", "data", "t.py"), { cmd: "python3", args: ["t.py"], useShell: false, stdin: "data" });
});

test("probe: node is always available (not PATH-gated) and reports its version", async () => {
    const r = await make("node").probe();
    assert.equal(r.available, true);
    assert.equal(r.detail, process.version);
});

test("live: sh runs a shell command", async () => {
    const { result, out } = await run("sh", "echo plurnk");
    assert.equal(result.status, 200);
    assert.equal(out.stdout, "plurnk\n");
});

test("live: node runs -e", async () => {
    const { result, out } = await run("node", "process.stdout.write(String(6*7))");
    assert.equal(result.status, 200);
    assert.equal(out.stdout, "42");
});

test("spawnArgs: eval-flag interpreters carry the command via their flag", () => {
    // @ts-expect-error exercise the protected hook directly
    assert.deepEqual(make("perl").spawnArgs("perl", "print 1"), { cmd: "perl", args: ["-e", "print 1"], useShell: false });
    // @ts-expect-error
    assert.deepEqual(make("php").spawnArgs("php", "echo 1;"), { cmd: "php", args: ["-r", "echo 1;"], useShell: false });
    // @ts-expect-error
    assert.deepEqual(make("deno").spawnArgs("deno", "console.log(1)"), { cmd: "deno", args: ["eval", "console.log(1)"], useShell: false });
});

test("spawnArgs: filters feed the command via stdin; awk is bare-program + empty stdin", () => {
    // @ts-expect-error
    assert.deepEqual(make("bc").spawnArgs("bc", "6*7"), { cmd: "bc", args: [], useShell: false, stdin: "6*7\n" });
    // @ts-expect-error
    assert.deepEqual(make("tcl").spawnArgs("tcl", "puts 1"), { cmd: "tclsh", args: [], useShell: false, stdin: "puts 1\n" });
    // @ts-expect-error
    assert.deepEqual(make("awk").spawnArgs("awk", "BEGIN{print 42}"), { cmd: "awk", args: ["BEGIN{print 42}"], useShell: false, stdin: "" });
});

test("effect: every common interpreter is host (subprocess, proposal-gated)", () => {
    assert.equal(make("perl").effect(null), "host");
    assert.equal(make("bc").effect(null), "host");
});

test("probe: reflects PATH presence per tag", async () => {
    for (const tag of ["perl", "ruby", "bc", "awk"]) {
        const bin = tag === "tcl" ? "tclsh" : tag;
        const r = await make(tag).probe();
        assert.equal(r.available, present(bin), `${tag} availability should track \`command -v ${bin}\``);
    }
});

test("probe: PLURNK_EXECS_<TAG>=0 disables a tag even when installed", async () => {
    process.env.PLURNK_EXECS_BC = "0";
    const r = await make("bc").probe();
    delete process.env.PLURNK_EXECS_BC;
    assert.equal(r.available, false);
    assert.match(String(r.detail), /disabled/);
});

test("unclaimed runtime tag is fail-hard in spawnArgs", async () => {
    await assert.rejects(run("nope", "x"), /unclaimed runtime tag 'nope'/);
});

// Live evaluation against whichever interpreters this host actually has.
test("live: bc evaluates an expression from stdin", { skip: !present("bc") }, async () => {
    const { result, out } = await run("bc", "6 * 7");
    assert.equal(result.status, 200);
    assert.equal(out.stdout.trim(), "42");
});

test("live: awk runs a BEGIN program with no input", { skip: !present("awk") }, async () => {
    const { result, out } = await run("awk", "BEGIN { print 6 * 7 }");
    assert.equal(result.status, 200);
    assert.equal(out.stdout.trim(), "42");
});

test("live: perl evaluates -e", { skip: !present("perl") }, async () => {
    const { result, out } = await run("perl", "print 6 * 7");
    assert.equal(result.status, 200);
    assert.equal(out.stdout.trim(), "42");
});
