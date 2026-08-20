#!/usr/bin/env node
// {§mcp-stdio-process-ownership} — the parent-death watchdog wrapper.
// plurnk-mcp spawns stdio servers through this wrapper so no server (or its
// grandchildren, e.g. chromium) can outlive the daemon:
//
//   - the real server is spawned DETACHED (its own process group), so the
//     wrapper can group-kill the whole tree, grandchildren included;
//   - ordinary transport closure forwards EOF and gives the server a bounded
//     graceful exit; parent death or an expired grace group-SIGKILLs the tree;
//   - a ppid poll covers SIGKILL of the daemon, where close() never runs;
//   - stdio is forwarded verbatim, so the MCP protocol is untouched.
//
// Usage (internal): mcp-watchdog.mjs <ppid> -- <command> [args...]
// The wrapper is a process-lifecycle tool, not a protocol participant.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep < 1) {
    process.stderr.write("mcp-watchdog: usage: mcp-watchdog.mjs <ppid> -- <command> [args...]\n");
    process.exit(64);
}
const parentPid = Number(args[0]);
const command = args[sep + 1];
const rest = args.slice(sep + 2);
if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || typeof command !== "string" || command.length === 0) {
    process.stderr.write("mcp-watchdog: invalid invocation\n");
    process.exit(64);
}

const SHUTDOWN_GRACE_MS = 2_000;

const child = spawn(command, rest, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
    detached: true, // own process group: kill(-pid) reaches grandchildren
});
const killChildGroup = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
};
let state = "running";
let grace;
const die = (reason, code = 0) => {
    if (state === "exited") return;
    state = "exited";
    clearTimeout(grace);
    killChildGroup();
    process.stderr.write(`mcp-watchdog: exiting (${reason})\n`);
    process.exit(code);
};

const alive = () => {
    try { process.kill(parentPid, 0); return true; } catch { return false; }
};
const closeInput = () => {
    if (state !== "running") return;
    if (!alive()) {
        die("parent gone");
        return;
    }
    state = "closing";
    child.stdin.end();
    grace = setTimeout(() => die("graceful shutdown deadline"), SHUTDOWN_GRACE_MS);
};

// The daemon owns our stdin. Ordinary transport shutdown closes it while the
// daemon remains alive; parent death closes it after the owner disappears.
process.stdin.on("end", closeInput);
process.stdin.on("close", closeInput);
process.stdin.resume();

// Parent-death signal 2: poll the ppid. Covers a reparented-but-open-fd edge
// (e.g. a grandchild accidentally inheriting our stdin) at 2s granularity.
const poll = setInterval(() => {
    if (!alive()) die("parent gone");
}, 2_000);
poll.unref();

// Forward the protocol verbatim.
process.stdin.on("data", (chunk) => {
    if (state === "running") child.stdin.write(chunk);
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stdout.on("end", () => { if (state !== "exited") process.stdout.end(); });
child.stdin.on("error", (error) => {
    if (state === "closing" && error.code === "EPIPE") return;
    die(`server stdin failed: ${error.message}`, 66);
});

child.on("exit", (code, signal) => {
    clearInterval(poll);
    if (state === "exited") return;
    state = "exited";
    clearTimeout(grace);
    // A server that exits does not get to strand descendants in its group.
    killChildGroup();
    process.exit(code ?? (signal === null ? 0 : 1));
});
child.on("error", (error) => {
    die(`spawn failed: ${error.message}`, 66);
});

for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
    process.on(signal, () => die(`received ${signal}`, 128));
}
