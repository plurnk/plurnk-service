import assert from "node:assert/strict";
import test from "node:test";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { ownWorker, serverProposals, TEST_OWNER } from "./_approval.ts";
import { insertWorker, openMigrated } from "./_db.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";
import { makeRawMockResponse } from "./_mock.ts";
import { waitForDb } from "./_rpc.ts";

for (const scenario of ["add", "inline", "accept", "reject", "cancel", "invalid", "enable", "disable", "remove", "deny", "quoted"] as const) {
    test(`{§executor-heading} {§op-execution-order}: ${scenario} resolves a new MCP invocation at its execution point`, { timeout: 30_000 }, async (t) => {
        const manual = scenario === "accept" || scenario === "reject" || scenario === "cancel";
        serverProposals(t, manual ? "review" : "accept");
        const received: unknown[] = [];
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name: "ordered-fixture", version: "1.0.0" });
            server.registerTool("inspect", {
                inputSchema: fromJsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async (args) => {
                received.push(args);
                return { content: [{ type: "text", text: "ordered-tool-result" }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        const definition = { name: "fresh", ...httpEntry(served.url) };
        const { hostPaths, env } = await mcpFixture(t, scenario === "enable" ? { fresh: definition } : {});
        if (scenario === "enable") env.PLURNK_MCP_fresh_ENABLED = "0";
        const command = scenario === "enable" ? "enable" : "add";
        const params = command === "enable" ? { alias: "fresh" }
            : { alias: "fresh", definition: scenario === "invalid" ? { type: "not-a-transport" } : definition };
        const args = '{"query":"unchanged"}';
        const invocation = PlurnkParser.frame("FrEsH (inspect)", args);
        const source = [
            PlurnkParser.frame(`mcp (${command})`, JSON.stringify(params)),
            ...(scenario === "disable" || scenario === "remove" ? [PlurnkParser.frame(`mcp (${scenario})`, '{"alias":"fresh"}')] : []),
            scenario === "inline" ? `\`\`\`FrEsH (inspect) ${args}\n\`\`\``
                : scenario === "quoted" ? PlurnkParser.frame("markdown", invocation) : invocation,
            PlurnkParser.frame("NOTE", "Observe the result."),
        ].join("\n\n");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeRawMockResponse(source), makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Finished.")),
        ] });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, hostPaths });
        daemon.registerModule(McpModule.init({ env }), "@plurnk/plurnk-mcp");
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `ordered-${scenario}` });
        const workerId = await insertWorker(db, workspaceId, null, "reader", "model");
        if (manual) await ownWorker(db, workspaceId, workerId);
        if (scenario === "deny") await daemon.setWorkspaceCapabilities({ workspaceId, policy: { deny: [{ runtime: "fresh", tool: "inspect" }] } });
        assert.ok(!daemon.executorTags(workspaceId).includes("fresh"), "the parser is not preloaded with the new runtime");
        const loop = await daemon.runLoop({ workspaceId, workerId, prompt: "Configure the server and inspect it.", maxTurns: 2 });
        if (manual) {
            const proposals = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
            assert.deepEqual(received, [], "the invocation cannot run while addition awaits approval");
            assert.ok(!daemon.executorTags(workspaceId).includes("fresh"));
            if (scenario === "cancel") await daemon.cancelWorker({ workspaceId, workerId, reason: "cancelled before approval" });
            else await daemon.resolveProposal(proposals[0].logEntryId, { decision: scenario }, { workspaceId, address: TEST_OWNER });
        }
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
        if (scenario === "cancel") {
            await waitForDb(() => daemon.readLog({ workspaceId, workerId }), (rows) =>
                rows.some((row) => row.origin === "model" && row.op === "mcp" && row.status_rx === 499));
        }
        const succeeds = !["reject", "cancel", "invalid", "disable", "remove", "deny", "quoted"].includes(scenario);
        assert.deepEqual(received, succeeds ? [{ query: "unchanged" }] : [], "only the actually published capability can be invoked");
        const rows = await daemon.readLog({ workspaceId, workerId, limit: Number.MAX_SAFE_INTEGER });
        const invoked = rows.filter((row) => row.origin === "model" && row.op === "fresh");
        const configured = rows.filter((row) => row.origin === "model" && row.op === "mcp");
        assert.ok(configured.length > 0);
        if (scenario === "quoted" || scenario === "cancel") {
            assert.deepEqual(invoked, [], "quotation and cancellation never admit an invocation");
        } else {
            assert.equal(invoked.length, 1, "the new invocation is admitted exactly once, never relegated to outside text");
            assert.equal(invoked[0].status_rx, succeeds ? 200 : scenario === "deny" ? 403 : 400);
            if (!succeeds && scenario !== "deny") {
                const result = invoked[0].rx as OperationResult;
                assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");
                assert.equal(result.problem?.requestedRuntime, "fresh");
            }
            assert.ok(configured.every((row) => row.turn_id === invoked[0].turn_id), "configuration and invocation occurred in the same real turn");
        }
        if (scenario === "cancel") {
            assert.equal(configured[0].status_rx, 499);
            assert.ok(!daemon.executorTags(workspaceId).includes("fresh"));
            assert.equal(provider.received.length, 1, "cancellation never resumes inference");
        } else if (scenario === "reject") {
            assert.equal(configured[0].status_rx, 400);
            assert.equal((configured[0].rx as OperationResult).problem?.type, "https://problems.plurnk.xyz/proposal/rejected");
        } else if (scenario === "invalid") assert.equal(configured[0].status_rx, 400);
        else assert.ok(configured.every((row) => row.status_rx !== null && row.status_rx >= 200 && row.status_rx < 300));
        assert.equal(await lifecycle.status(loop.loopId), scenario === "cancel" ? 499 : 200);
    });
}
