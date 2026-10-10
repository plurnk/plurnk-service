import { serverProposals } from "./_approval.ts";
// {§exec-tool-fall-through} — a bare shell command whose program is the name of an enabled
// runtime's tool dies with the shell's exit 127; the failure receipt says so at the failure site
// and names the invocation the registry actually publishes, so recovery takes one turn.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";
import { connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { MCP_CONTROLS, mcpFixture, stdioEntry } from "./_mcp-config.ts";

test("{§exec-tool-fall-through} {§diagnostic-observation} a bare execution of a tool's name fails with a receipt that names the tool and its document", { timeout: 60_000 }, async (t) => {
    serverProposals(t, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nfail {\"message\":\"boom\"}\n````\n\n````WAIT\nwaiting on the shell\n````", 10),
            makeMockResponse("````SEND [200]\nseen\n````", 10),
        ],
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs") });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `tool-fall-through-${crypto.randomUUID()}` });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "try the tool by name" }, { timeoutMs: 30_000 });
            assert.equal(finalStatus, 200);
            // {§exec-stream}: the spawn's execution row is `started`; the process's conclusion is the receipt
            // on the stream's terminal READ — one per channel with content, and the shell's complaint is on stderr alone.
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const receipts = rows.filter((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.equal(receipts.length, 1, "one terminal READ, on the channel that holds the shell's complaint");
            assert.deepEqual((JSON.parse(receipts[0]!.rx) as { channels?: unknown }).channels, { "#stdout": 0 }, "the empty stdout is a fact on that receipt");
            assert.equal(receipts[0]!.status_rx, 404, "the named program did not run");
            const receipt = JSON.parse(receipts[0]!.rx) as { exitCode?: number; problem?: { type?: string; detail?: string; recovery?: string; toolRuntimes?: string[]; tool?: string } };
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem?.type, "https://problems.plurnk.xyz/scheme/exec/program-is-a-tool");
            assert.equal(receipt.problem?.detail, "'sh' exited with code 127; `fail` is a registered tool of `fixture`."); // {§pinned-wording-core}
            assert.equal(
                receipt.problem?.recovery,
                "`fail`'s contract: worker:///_plurnk/tools/fixture/fail.json.",
            );
            assert.deepEqual(receipt.problem?.toolRuntimes, ["fixture"]);
            assert.equal(receipt.problem?.tool, "fail");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§exec-tool-fall-through} a program the registry does not know keeps the shell's own answer", { timeout: 60_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nno_such_program_zq --help\n````\n\n````WAIT\nwaiting\n````", 10),
            makeMockResponse("````SEND [200]\nseen\n````", 10),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `plain-127-${crypto.randomUUID()}` });
            const { loopId } = await runLoopToTerminal(ws, 2, { prompt: "run nothing" }, { timeoutMs: 30_000 });
            const terminal = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; scheme: string; status_rx: number; rx: string }>({ loop_id: loopId }))
                .find((row) => row.op === "READ" && row.origin === "_plurnk" && row.scheme === "sh");
            assert.ok(terminal);
            const receipt = JSON.parse(terminal.rx) as { exitCode?: number; problem?: unknown };
            assert.equal(terminal.status_rx, 200);
            assert.equal(receipt.exitCode, 127);
            assert.equal(receipt.problem, undefined, "no tool is invented for a program the registry does not know");
        } finally { ws.close(); }
    } finally {
        await daemon.stop();
        await db.close();
    }
});
