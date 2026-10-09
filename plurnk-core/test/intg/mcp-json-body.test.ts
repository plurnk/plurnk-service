import { serverProposals } from "./_approval.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import Daemon from "../../src/server/Daemon.ts";
import StreamMock from "./_stream-mock.ts";
import { openMigrated } from "./_db.ts";
import { connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";

// {§pairing-objective} — the shape: an MCP call closed at once, then prose that later
// shows a bare block. The runtime declares an application/json body, so the call ends at its own closer
// and the tool receives exactly the object the model wrote.
for (const [name, source] of [
    ["the prose after it does not extend its JSON body", ["So I can invoke:", "", "```fixture (inspect)", "{\"query\":\"fixture\"}", "```", "", "Then I will check the remote:", "", "```", "git remote -v", "```", "", "Done."].join("\n")],
    ["arguments on its heading line are its body ({§bare-option-object})", "```fixture (inspect) {\"query\":\"fixture\"}\n```"],
] as const) test(`{§pairing-objective}: an MCP call receives exactly the object the model wrote: ${name}`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const received: unknown[] = [];
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "json-body-fixture", version: "1.0.0" });
        server.registerTool("inspect", {
            description: "Echo the query.",
            inputSchema: fromJsonSchema({ type: "object", properties: { query: { type: "string" } }, additionalProperties: false }),
        }, async (args) => {
            received.push(args);
            return { content: [{ type: "text", text: "ok" }] };
        });
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
    const provider = new StreamMock({ contextWindow: 100_000, responses: [
        makeRawMockResponse(source, 10),
        makeMockResponse(PlurnkParser.frame("SEND [200]", "Checked.")),
    ] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ws = await connect({ daemon });
    t.after(() => ws.close());
    await rpcCall(ws, 1, "workspace.create", { name: "mcp-json-body" });
    const result = await runLoopToTerminal(ws, 2, { prompt: "Inspect." });
    assert.equal(result.finalStatus, 200);
    assert.deepEqual(received, [{ query: "fixture" }], "the tool receives the one object the model wrote");
});
