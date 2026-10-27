import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { workingDirectory } from "../working-directory.ts";

// The referee's `conformance` bin, wherever npm placed the package; its placement in the tree is npm's.
const REFEREE = path.join(path.dirname(createRequire(import.meta.url).resolve("@modelcontextprotocol/conformance/package.json")), "dist/index.js");

const run = (
    command: string,
    args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: path.resolve(import.meta.dirname, "../../.."),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
    });

interface Check {
    readonly source: string;
    readonly status?: string;
    readonly id?: string;
    readonly description?: string;
    readonly errorMessage?: string;
}

const readChecks = async (directory: string): Promise<Check[]> => {
    const result: Check[] = [];
    for await (const relative of glob("**/checks.json", { cwd: directory })) {
        const checks = JSON.parse(await readFile(path.join(directory, relative), "utf8")) as Omit<Check, "source">[];
        result.push(...checks.map((check) => ({ ...check, source: relative.replace(/\/checks\.json$/, "") })));
    }
    return result;
};

for (const { name, selection, requiredChecks } of [
    {
        name: "{§mcp-model-projection} official 2026-07-28 client requirements exercise the Plurnk host",
        selection: ["--requirements", "2026-07-28"],
        requiredChecks: [],
    },
    {
        name: "{§oauth-continuation} official client-secret extension checks exercise the Plurnk grant",
        selection: ["--scenario", "auth/client-credentials-basic"],
        requiredChecks: ["client-credentials-basic-auth", "valid-bearer-token"],
    },
]) {
test(`{§mcp-model-projection} ${name}`, {
    timeout: 120_000,
}, async (t) => {
    const output = await mkdtemp(path.join(tmpdir(), "plurnk-mcp-conformance-"));
    t.after(() => rm(output, { recursive: true, force: true }));

    const result = await run(process.execPath, [
        REFEREE,
        "client",
        "--command",
        `${process.execPath} --conditions=plurnk-dev --env-file=plurnk-mcp/.env.defaults plurnk-mcp/test/conformance-client.ts`,
        ...selection,
        "--output-dir",
        output,
    ]);

    const checks = await readChecks(output);
    const failures = checks.filter(({ status }) => status === "FAILURE");
    const report = failures.map((check) => [
        check.source, check.id ?? "unknown-check", check.description, check.errorMessage,
    ].filter(Boolean).join(": ")).join("\n");
    // {§mcp-model-projection}: the official verdict owns required vs not_scored checks.
    assert.equal(
        result.code,
        0,
        `official MCP conformance failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nreport:\n${report}`,
    );
    assert.ok(checks.some(({ status }) => status === "SUCCESS"), `no successful checks were recorded; a skipped run is not a pass\n${result.stdout}`);
    for (const id of requiredChecks) {
        assert.ok(checks.some((check) => check.id === id && check.status === "SUCCESS"), `required check '${id}' did not pass`);
    }
});
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdio Process Ownership & Watchdog ({§mcp-transports}, {§mcp-transports})
// ─────────────────────────────────────────────────────────────────────────────

const holder = fileURLToPath(new URL("../watchdog-holder.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/echo-server.mjs", import.meta.url));
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

test("{§mcp-transports}: a SIGKILLed parent takes its stdio MCP server tree with it", { timeout: 30_000 }, async (t) => {
    const child = spawn(process.execPath, ["--conditions=plurnk-dev", holder, fixture, workingDirectory], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let ready = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { ready += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && child.exitCode === null && !ready.includes("HOLDER-READY")) await delay(100);
    assert.ok(ready.includes("HOLDER-READY"), `holder never became ready (stdout: ${ready.slice(0, 200)}; stderr: ${errors.slice(0, 200)})`);

    const owned = descendants(child.pid ?? 0);
    assert.ok(owned.length >= 2, `expected watchdog+server descendants, saw ${owned.length}`);

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
