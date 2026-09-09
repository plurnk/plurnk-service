import test from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Common, { RUNTIME_TAGS } from "./Common.ts";
import type { ExecArgs, ExecResult } from "@plurnk/plurnk-execs";

const present = (bin: string): boolean => spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin]).status === 0;

const make = (tag: string): Common => new Common({ runtime: tag, glyph: "•" });

const run = async (tag: string, command: string, options: Partial<Pick<ExecArgs, "target" | "metadata">> = {}): Promise<{ result: ExecResult; out: Record<string, string> }> => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const args: ExecArgs = {
        metadata: null,
        runtime: tag, body: command, cwd: null, target: null,
        signal: new AbortController().signal,
        write: (c, chunk) => { out[c] = (out[c] ?? "") + chunk; },
        setState: () => {}, emit: () => {},
        interact: async () => ({ status: "cancelled" }),
        ...options,
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
        "sh", "node", "python3", "perl", "ruby", "lua", "deno", "bun", "tcl", "bc", "awk",
    ]);
    const [shell, ...alternatives] = pkg.plurnk.runtimes as Array<{
        name: string;
        invocation: { example?: { body?: string; target?: string }; signature?: string };
    }>;
    assert.deepEqual(shell?.invocation.example, { body: "git status --short" }, "the shell retains its ordinary command witness");
    assert.ok(
        alternatives.every(({ invocation }) => typeof invocation.example?.body === "string"
            && invocation.example.body.length > 0 && !invocation.example.body.includes("\n")
            && invocation.example.target === undefined && invocation.signature === undefined),
        "each interpreter supplies one concise inline-program example, without a script target",
    );
});

test("{§executor-tool-document}: declared interpreter examples execute as raw inline programs", async (t) => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const runtime of pkg.plurnk.runtimes.filter(({ name }: { name: string }) => name !== "sh")) {
        await t.test(runtime.name, async (t) => {
            const body = runtime.invocation.example?.body;
            assert.ok(typeof body === "string" && body.length > 0, "the advertised inline example has a body");
            const availability = await make(runtime.name).probe();
            if (!availability.available) {
                t.skip(availability.detail);
                return;
            }
            const { result, out } = await run(runtime.name, body);
            assert.equal(result.status, 200, out.stderr);
            assert.equal(out.stdout.trim(), "42", "the declared example evaluates and prints its result");
        });
    }
});

test("spawnArgs: the subprocess floor (sh/node/python3)", () => {
    // @ts-expect-error exercise the protected hook
    assert.deepEqual(make("sh").spawnArgs("sh", "echo hi"), { cmd: "sh", args: ["-c", "echo hi"], useShell: false });
    // @ts-expect-error
    assert.deepEqual(make("node").spawnArgs("node", "console.log(1)"), { cmd: "node", args: ["-e", "console.log(1)"], useShell: false });
    // @ts-expect-error
    assert.deepEqual(make("python3").spawnArgs("python3", "print(1)"), { cmd: "python3", args: ["-c", "print(1)"], useShell: false });
});

test("spawnArgs: a target selects the interpreter's script-file form and body is stdin", () => {
    // @ts-expect-error protected hook
    assert.deepEqual(make("sh").spawnArgs("sh", "stdin body", "./run.sh"), { cmd: "sh", args: ["./run.sh"], useShell: false, stdin: "stdin body" });
    // @ts-expect-error
    assert.deepEqual(make("python3").spawnArgs("python3", "data", "t.py"), { cmd: "python3", args: ["t.py"], useShell: false, stdin: "data" });
    // @ts-expect-error protected hook
    assert.deepEqual(make("awk").spawnArgs("awk", "data", "t.awk"), { cmd: "awk", args: ["-f", "t.awk"], useShell: false, stdin: "data" });
});

test("{§executor-subprocess-routing}: awk reads the target script and consumes raw body as stdin", { skip: !present("awk") }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "execs-awk-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, "script with spaces.awk");
    await fs.writeFile(target, '{ print "READ:" $0 }\n');
    const { result, out } = await run("awk", "first\nsecond\n", { target });
    assert.equal(result.status, 200, out.stderr);
    assert.equal(out.stdout, "READ:first\nREAD:second\n");
});

for (const [tag, body] of [
    ["sh", 'printf "%s\\n" "$0" "$1" "$2" "$3"'],
    ["node", 'console.log(process.argv.slice(1).join("\\n"))'],
    ["python3", 'import sys; print("\\n".join(sys.argv[1:]))'],
] as const) {
    test(`{§executor-metadata}: inline ${tag} preserves arguments using native interpreter conventions`, { skip: !present(tag) }, async () => {
        const argv = ["first", "two words", "", "$(touch forbidden)"];
        const { result, out } = await run(tag, body, { metadata: [`args=${JSON.stringify(argv)}`] });
        assert.equal(result.status, 200, out.stderr);
        assert.equal(out.stdout, `${argv.join("\n")}\n`);
    });
}

// An EDIT-created script has no exec bit, and
// a file target still runs — the interpreter reads it; execve never happens.
test("a file target runs without +x; transient exec never mutates its mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-transient-"));
    try {
        const script = path.join(dir, "greet.sh");
        await fs.writeFile(script, "read name; echo \"hi $name\"\n", { mode: 0o644 });
        const out: string[] = [];
        const args: ExecArgs = {
            metadata: null,
            runtime: "sh", body: "plurnk", cwd: dir, target: script,
            signal: new AbortController().signal,
            write: (_c, chunk) => { out.push(chunk); },
            setState: () => {}, emit: () => {},
            interact: async () => ({ status: "cancelled" }),
        };
        const result = await make("sh").run(args);
        assert.equal(result.status, 200);
        assert.match(out.join(""), /hi plurnk/, "the non-executable script ran with the body as stdin");
        assert.equal(((await fs.stat(script)).mode & 0o111), 0, "the exec bit was never set — zero mutation");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
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

// The PLURNK_EXECS_<tag>=0 / _ONLY kill-switch moved to the framework's
// discover() ({§executor-policy}) — a disabled tag is never registered, so probe() no
// longer sees it. Covered in plurnk-execs' policy.test.ts / discover.test.ts.

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
