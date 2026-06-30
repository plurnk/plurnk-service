import test from "node:test";
import { strict as assert } from "node:assert";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Jq from "./Jq.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

const HAS_JQ = spawnSync("jq", ["--version"]).status === 0;

interface Capture { result: ExecResult; out: string | undefined; states: string[]; events: TelemetryEvent[]; }

const run = async (command: string, cwd: string | null = null, env?: NodeJS.ProcessEnv): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime: "jq", command, cwd, env,
        signal: new AbortController().signal,
        write: (_c, chunk) => { out = (out ?? "") + chunk; },
        setState: (_c, s) => states.push(s),
        emit: (e) => events.push(e),
    };
    const result = await new Jq({ runtime: "jq", glyph: "🧰" }).run(args);
    return { result, out, states, events };
};

const tmpFiles: string[] = [];
const tmp = (): string => { const p = join(tmpdir(), `execs-jq-${process.hrtime.bigint()}.json`); tmpFiles.push(p); return p; };
test.afterEach(async () => { await Promise.all(tmpFiles.splice(0).map((p) => rm(p, { force: true }))); });

test("manifest declares jq", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((r: { name: string }) => r.name), ["jq"]);
});

test("channels: results (application/jsonl)", () => {
    assert.deepEqual(new Jq({ runtime: "jq", glyph: "🧰" }).channels, { results: { mimetype: "application/jsonl" } });
});

test("effect: inline/-n → pure; file-path data source → read", () => {
    const j = new Jq({ runtime: "jq", glyph: "🧰" });
    assert.equal(j.effect(null), "pure");
    assert.equal(j.effect("./data.json"), "read");
});

test("probe: reflects jq on PATH", async () => {
    const r = await new Jq({ runtime: "jq", glyph: "🧰" }).probe();
    assert.equal(r.available, HAS_JQ);
});

test("inline (-n): a self-contained program computes with no data source", { skip: !HAS_JQ }, async () => {
    const { result, out, states } = await run("[1,2,3] | add");
    assert.equal(result.status, 200);
    assert.equal(out?.trim(), "6");
    assert.deepEqual(states, ["closed"]);
});

test("multi-value object output is one compact JSON value per line — honest JSONL (#2)", { skip: !HAS_JQ }, async () => {
    // Without -c this object stream pretty-prints across multiple lines and is
    // neither valid application/json nor valid JSONL — the bug in #2.
    const { result, out } = await run("[{a:1},{a:2}] | .[]");
    assert.equal(result.status, 200);
    const lines = out!.trim().split("\n");
    assert.equal(lines.length, 2, "each value on its own line");
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { a: 2 }], "every line is a standalone JSON value");
});

test("a file-path target is filtered", { skip: !HAS_JQ }, async () => {
    const p = tmp();
    await writeFile(p, JSON.stringify({ users: [{ name: "ada" }, { name: "alan" }] }));
    const { result, out } = await run(".users[].name", p);
    assert.equal(result.status, 200);
    assert.deepEqual(out!.trim().split("\n"), ['"ada"', '"alan"']);
});

test("empty body defaults to the identity filter `.`", { skip: !HAS_JQ }, async () => {
    const p = tmp();
    await writeFile(p, '{"a":1}');
    const { result, out } = await run("", p);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(out!), { a: 1 });
});

test("env: honors a scoped env; vars the consumer dropped read as null (#8)", { skip: !HAS_JQ }, async () => {
    // PATH is needed for spawn to locate jq; FOO is the only data var exposed.
    const seen = await run("env.FOO", null, { PATH: process.env.PATH, FOO: "bar" });
    assert.equal(seen.result.status, 200);
    assert.equal(JSON.parse(seen.out!), "bar");
    // A var absent from the scoped env is invisible to the jq program.
    const dropped = await run("env.PLURNK_SECRET", null, { PATH: process.env.PATH });
    assert.equal(JSON.parse(dropped.out!), null);
});

test("a jq program error → jq_error telemetry, errored channel, 500", { skip: !HAS_JQ }, async () => {
    const { result, events, states } = await run("this is not valid jq");
    assert.equal(result.status, 500);
    assert.equal(events[0].source, "exec:jq");
    assert.equal(events[0].kind, "jq_error");
    assert.equal(states.at(-1), "errored");
});
