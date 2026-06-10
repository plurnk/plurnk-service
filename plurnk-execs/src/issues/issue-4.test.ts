import test from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import SubprocessExecutor from "../SubprocessExecutor.ts";
import type { ExecArgs, ExecResult } from "../types.ts";

// plurnk-execs#4 — "abort leaks shell grandchildren (SIGTERMs only the shell,
// not the process group)". Asserts the contract the fix promised, not the impl.

const run = async (command: string, signal: AbortSignal): Promise<ExecResult> => {
    const args: ExecArgs = {
        runtime: "sh", command, cwd: null, signal,
        write: () => {}, setState: () => {}, emit: () => {},
    };
    return new SubprocessExecutor({ runtime: "sh", glyph: "🐚" }).run(args);
};

test("C1: aborting a running command settles with status 499", async () => {
    const c = new AbortController();
    const p = run("sleep 5", c.signal);
    c.abort();
    assert.equal((await p).status, 499);
});

test("C2: abort terminates the whole process group — no shell grandchild survives", async () => {
    const dur = `9999.${process.hrtime.bigint().toString().slice(-9)}`;
    const c = new AbortController();
    const p = run(`sleep ${dur}`, c.signal);
    await new Promise((r) => setTimeout(r, 300));
    c.abort();
    await p;
    await new Promise((r) => setTimeout(r, 600));
    const survivors = spawnSync("pgrep", ["-f", dur]).stdout.toString().trim();
    if (survivors) spawnSync("pkill", ["-f", dur]);
    assert.equal(survivors, "", `leaked process(es): ${survivors}`);
});

test("C3: a command aborted before launch never spawns and settles 499", async () => {
    const c = new AbortController();
    c.abort();
    assert.equal((await run("echo should-not-run", c.signal)).status, 499);
});
