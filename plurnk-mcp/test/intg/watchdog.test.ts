// #295 acceptance — no stdio MCP server (or its children) outlives a SIGKILLed
// parent. The watchdog wrapper must group-kill the server tree when the parent
// dies by any path, including one where close() never runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const holder = fileURLToPath(new URL("../watchdog-holder.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../../src/fixtures/echo-server.mjs", import.meta.url));

const descendantsAlive = async (rootPid: number): Promise<number> => {
    // Count processes whose args mention the fixture path AND that were not
    // alive before the holder started (identified by parentage: watchdog ->
    // fixture server; both carry the fixture path or the watchdog path).
    const { execSync } = await import("node:child_process");
    try {
        const out = execSync("ps -eo pid,args --no-headers", { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        return out.split("\n").filter((line) => line.includes("echo-server.mjs") || line.includes("mcp-watchdog.mjs") || line.includes("watchdog-holder.mjs"))
            .filter((line) => !line.includes("ps -eo"))
            .length;
    } catch {
        return 0;
    }
};

test("#295: a SIGKILLed parent takes its stdio MCP server tree with it", { timeout: 30_000 }, async () => {
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

    // The tree exists: holder + watchdog + echo server (>= 3 matching lines).
    const before = await descendantsAlive(child.pid ?? 0);
    assert.ok(before >= 3, `expected holder+watchdog+server alive, saw ${before}`);

    // SIGKILL the parent: no close() ever runs. The watchdog must notice and
    // group-kill the server within its poll interval (2s) plus slack.
    process.kill(child.pid!, "SIGKILL");
    let after = -1;
    const gone = Date.now() + 8_000;
    while (Date.now() < gone) {
        after = await descendantsAlive(child.pid ?? 0);
        if (after === 0) break;
        await delay(250);
    }
    assert.equal(after, 0, "the SIGKILLed parent left MCP processes behind");
});
