// {§mcp-stdio-process-ownership} — no stdio MCP server or descendant outlives a SIGKILLed
// parent. The watchdog wrapper must group-kill the server tree when the parent
// dies by any path, including one where close() never runs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const holder = fileURLToPath(new URL("../watchdog-holder.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../../src/fixtures/echo-server.mjs", import.meta.url));
const watchdog = fileURLToPath(new URL("../../src/mcp-watchdog.mjs", import.meta.url));
const gracefulChild = fileURLToPath(new URL("../watchdog-graceful-child.mjs", import.meta.url));

interface ProcessRow { pid: number; ppid: number; state: string }

const processRows = (): ProcessRow[] => execFileSync(
    "ps",
    ["-eo", "pid=,ppid=,stat="],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), state: match[3] }];
});

const descendants = (rootPid: number): number[] => {
    const byParent = Map.groupBy(processRows(), ({ ppid }) => ppid);
    const found: number[] = [];
    const visit = (pid: number): void => {
        for (const child of byParent.get(pid) ?? []) {
            found.push(child.pid);
            visit(child.pid);
        }
    };
    visit(rootPid);
    return found;
};

const alive = (pids: number[]): number[] => {
    const selected = new Set(pids);
    return processRows()
        .filter(({ pid, state }) => selected.has(pid) && !state.startsWith("Z"))
        .map(({ pid }) => pid);
};

test("{§mcp-stdio-process-ownership}: a SIGKILLed parent takes its stdio MCP server tree with it", { timeout: 30_000 }, async () => {
    // Pre-existing noise (e.g. this test file's own path in a ps line) is
    // excluded by matching only the fixture/watchdog/holder basenames above.
    const child = spawn(process.execPath, ["--conditions=plurnk-dev", holder, fixture], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { ready += chunk; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !ready.includes("HOLDER-READY")) await delay(100);
    assert.ok(ready.includes("HOLDER-READY"), `holder never became ready (saw: ${ready.slice(0, 200)})`);

    const owned = descendants(child.pid ?? 0);
    assert.ok(owned.length >= 2, `expected watchdog+server descendants, saw ${owned.length}`);

    // SIGKILL the parent: no close() ever runs. The watchdog must notice and
    // group-kill the server within its poll interval (2s) plus slack.
    process.kill(child.pid!, "SIGKILL");
    let survivors = owned;
    const gone = Date.now() + 8_000;
    while (Date.now() < gone) {
        survivors = alive(owned);
        if (survivors.length === 0) break;
        await delay(250);
    }
    assert.deepEqual(survivors, [], "the SIGKILLed parent left MCP descendants behind");
});

test("{§mcp-transports}: ordinary transport EOF gives the server a graceful shutdown", { timeout: 10_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-watchdog-close-"));
    const marker = join(root, "closed");
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = spawn(process.execPath, [
        watchdog,
        String(process.pid),
        "--",
        process.execPath,
        gracefulChild,
        marker,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const readyBy = Date.now() + 5_000;
    while (!output.includes("READY") && Date.now() < readyBy) await delay(20);
    assert.match(output, /READY/, "watchdog child became ready");

    child.stdin.end();
    const closedBy = Date.now() + 5_000;
    while (child.exitCode === null && Date.now() < closedBy) await delay(20);
    assert.equal(child.exitCode, 0, "watchdog settled after graceful child shutdown");
    assert.equal(await readFile(marker, "utf8"), "closed\n", "server observed stdin EOF before termination");
});
