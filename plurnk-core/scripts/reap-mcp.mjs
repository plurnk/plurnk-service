#!/usr/bin/env node
// #295 — orphaned-MCP reaper. MCP stdio children survive an unclean parent
// death (no parent-death signal; they demonstrably ignore stdin EOF). This
// reaper kills any process whose parent is gone (ppid 1) AND whose command
// line marks it as plurnk-spawned MCP machinery (browser-mcp, mcp servers,
// their chromium children). Run it from a suite bootstrap or manually:
//   node scripts/reap-mcp.mjs [--dry-run]
import { execSync } from "node:child_process";
const dryRun = process.argv.includes("--dry-run");
const PATTERNS = [
    /possumtech\/browser-mcp/,
    /mcp-server-git/,
    /brave-search-mcp-server/,
    /chrome-devtools-mcp/,
    /github-mcp-server/,
    /@playwright\/mcp/,
];
const MARKER_CHILDREN = [/chromium/i, /chrome-devtools/i, /headless_shell/i];
try {
    const out = execSync(
        "ps -eo pid,ppid,args --no-headers --sort=pid",
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const rows = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
        .map((l) => {
            const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
            return m ? { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] } : null;
        }).filter((r) => r !== null);
    const orphaned = rows.filter((r) => r.ppid === 1);
    // an orphaned MCP server's children are orphans-in-waiting (their parent
    // may still be alive=the server): collect children of doomed parents too.
    const doomed = new Set(orphaned.filter((r) => PATTERNS.some((p) => p.test(r.args))).map((r) => r.pid));
    const victims = [];
    const byPpid = new Map();
    for (const r of rows) {
        if (!byPpid.has(r.ppid)) byPpid.set(r.ppid, []);
        byPpid.get(r.ppid).push(r);
    }
    const collect = (ppid, depth = 0) => {
        for (const child of byPpid.get(ppid) ?? []) {
            if (depth > 6) continue;
            victims.push(child);
            collect(child.pid, depth + 1);
        }
    };
    for (const pid of doomed) collect(pid);
    for (const r of orphaned) {
        if (MARKER_CHILDREN.some((p) => p.test(r.args))) victims.push(r);
    }
    if (victims.length === 0) {
        console.log("reap-mcp: no orphaned plurnk MCP processes found");
        process.exit(0);
    }
    for (const v of victims) {
        console.log(`${dryRun ? "[dry-run] would kill" : "killing"} pid=${v.pid} ${v.args.slice(0, 90)}`);
        if (!dryRun) {
            try { process.kill(v.pid, "SIGKILL"); } catch (e) { console.error(`  pid=${v.pid} kill failed:`, e.message); }
        }
    }
    process.exit(0);
} catch (e) {
    console.error("reap-mcp: ps failed:", e.message);
    process.exit(1);
}
