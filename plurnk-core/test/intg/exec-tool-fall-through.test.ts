// {§exec-tool-fall-through} — a bare shell command whose program is the name of an enabled
// runtime's tool dies with the shell's exit 127; the failure receipt says so at the failure site
// and names the invocation the registry actually publishes, so recovery takes one turn.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Mock } from "@plurnk/plurnk-providers";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal } from "./_rpc.ts";

const fixture = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/echo-server.mjs", import.meta.url));

test("a bare EXEC of a tool's name fails with a receipt that names the tool's real invocation", { timeout: 60_000 }, async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("### EXEC_\nfail {\"message\":\"boom\"}\n\n### SEND_ (WAIT)\nwaiting on the shell", 10),
            makeMockResponse("### SEND_ (TERM)\nseen", 10),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000",
        PLURNK_MCP_FIXTURE: process.execPath,
        PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixture]),
        PLURNK_MCP_ENABLED: '["fixture"]',
    } }));
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tool-fall-through-${crypto.randomUUID()}` });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "try the tool by name", policy: { proposals: "accept" } }, { timeoutMs: 30_000 });
            assert.equal(finalStatus, 200);
            // {§exec-stream}: the spawn's EXEC row is `started`; the process's conclusion is the receipt
            // on the stream's terminal READs (one per channel), which is what the next packet shows.
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const receipts = rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.equal(receipts.length, 2, "one terminal READ per stream channel");
            assert.ok(receipts.every((row) => row.status_rx === 500), "the shell's exit 127 is still a 500 receipt");
            const receipt = JSON.parse(receipts[0]!.rx) as { exitCode?: number; problem?: { detail?: string; recovery?: string; toolRuntimes?: string[]; tool?: string } };
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem?.detail, "'sh' exited with code 127: `fail` is not a shell command; it is a tool of [fixture].");
            assert.equal(
                receipt.problem?.recovery,
                "Invoke the tool with `### EXEC_ [fixture] (fail)` and its JSON input as the body; its contract is at worker://~/_plurnk/tools/fixture/fail.md.",
            );
            assert.deepEqual(receipt.problem?.toolRuntimes, ["fixture"]);
            assert.equal(receipt.problem?.tool, "fail");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("an ordinary missing shell command keeps the plain exit-127 receipt", { timeout: 60_000 }, async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("### EXEC_\nno_such_program_zq --help\n\n### SEND_ (WAIT)\nwaiting", 10),
            makeMockResponse("### SEND_ (TERM)\nseen", 10),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `plain-127-${crypto.randomUUID()}` });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "run nothing", policy: { proposals: "accept" } }, { timeoutMs: 30_000 });
            const terminal = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; rx: string }>({ loop_id: loopId }))
                .find((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.ok(terminal);
            const receipt = JSON.parse(terminal.rx) as { exitCode?: number; problem?: { detail?: string; toolRuntimes?: unknown } };
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem?.detail, "'sh' exited with code 127.");
            assert.equal(receipt.problem?.toolRuntimes, undefined, "no tool is invented for a program the registry does not know");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});
