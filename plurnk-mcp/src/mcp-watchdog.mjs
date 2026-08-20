#!/usr/bin/env node
// #295 crash-only child lifecycle — the parent-death watchdog wrapper.
// plurnk-mcp spawns stdio servers through this wrapper so no server (or its
// grandchildren, e.g. chromium) can outlive the daemon:
//
//   - the real server is spawned DETACHED (its own process group), so the
//     wrapper can group-kill the whole tree, grandchildren included;
//   - the wrapper dies when its stdin pipe closes (parent gone) or when a
//     ppid poll notices the parent vanished, and group-SIGKILLs on the way
//     out — covering SIGKILL of the daemon, where no close() ever runs;
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

const child = spawn(command, rest, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
    detached: true, // own process group: kill(-pid) reaches grandchildren
});
const childGroup = () => process.kill(-child.pid, "SIGKILL");
let exiting = false;
const die = (reason) => {
    if (exiting) return;
    exiting = true;
    try { childGroup(); } catch { /* already gone */ }
    process.stderr.write(`mcp-watchdog: exiting (${reason})\n`);
    process.exit(0);
};

// Parent-death signal 1: the daemon holds our stdin; when it dies (any exit,
// including SIGKILL), the pipe closes and stdin ends.
process.stdin.on("end", () => die("stdin closed"));
process.stdin.on("close", () => die("stdin closed"));
process.stdin.resume();

// Parent-death signal 2: poll the ppid. Covers a reparented-but-open-fd edge
// (e.g. a grandchild accidentally inheriting our stdin) at 2s granularity.
const alive = () => {
    try { process.kill(parentPid, 0); return true; } catch { return false; }
};
const poll = setInterval(() => {
    if (!alive()) die("parent gone");
}, 2_000);
poll.unref();

// Forward the protocol verbatim.
process.stdin.on("data", (chunk) => child.stdin.write(chunk));
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stdout.on("end", () => { if (!exiting) process.stdout.end(); });

child.on("exit", (code, signal) => {
    clearInterval(poll);
    if (exiting) return;
    exiting = true;
    process.exit(code ?? (signal === null ? 0 : 128 + 1));
});
child.on("error", (error) => {
    process.stderr.write(`mcp-watchdog: spawn failed: ${error.message}\n`);
    process.exit(66);
});
