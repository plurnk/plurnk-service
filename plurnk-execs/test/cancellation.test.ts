import test from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import SubprocessExecutor from "../src/SubprocessExecutor.ts";
import type { ExecArgs, ExecResult } from "../src/types.ts";

// A condition the test waits on, polled until it holds; the bound only keeps a hang from outliving the test.
const until = async (what: string, predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};
// The processes whose command line names `marker`, a test's unique duration.
const running = (marker: string): string => spawnSync("pgrep", ["-f", marker]).stdout.toString().trim();

// {§executor-cancellation} Assert the process-group contract, not its implementation.

const run = async (command: string, signal: AbortSignal): Promise<ExecResult> => {
    const args: ExecArgs = {
        metadata: null,
        runtime: "sh", body: command, cwd: null, target: null, signal,
        write: () => {}, setState: () => {}, emit: () => {},
        interact: async () => ({ status: "cancelled" }),
    };
    return new SubprocessExecutor({ runtime: "sh", glyph: "🐚" }).run(args);
};

test("{§executor-cancellation} C1: aborting a running command settles with status 499", async () => {
    const c = new AbortController();
    const p = run("sleep 5", c.signal);
    c.abort();
    assert.equal((await p).status, 499);
});

test("{§executor-cancellation} C2: abort terminates the whole process group — no shell grandchild survives", async () => {
    const dur = `9999.${process.hrtime.bigint().toString().slice(-9)}`;
    const c = new AbortController();
    const p = run(`sleep ${dur}`, c.signal);
    await until("the command's process to run", () => running(dur) !== "");
    c.abort();
    await p;
    // Every member of the group goes, within a bound that only stops a leak hanging the test.
    let survivors = running(dur);
    await until("the group to exit", () => (survivors = running(dur)) === "").catch(() => undefined);
    if (survivors) spawnSync("pkill", ["-f", dur]);
    assert.equal(survivors, "", `leaked process(es): ${survivors}`);
});

test("{§executor-cancellation} C3: a command aborted before launch never spawns and settles 499", async () => {
    const c = new AbortController();
    c.abort();
    assert.equal((await run("echo should-not-run", c.signal)).status, 499);
});
