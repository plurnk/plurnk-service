import assert from "node:assert/strict";
import test from "node:test";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import Daemon from "../../src/server/Daemon.ts";
import StreamMock from "./_stream-mock.ts";
import { logEntries, openMigrated } from "./_helpers.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal } from "./_rpc.ts";

// {§exec-stream-page} {§stream-observation-result} — the complete MCP transport →
// execution → invocation receipt → automatic observation → explicit recovery path.
for (const body of [null, '{"query":"fixture"}']) {
    test(`MCP ${body === null ? "bodyless" : "one-line JSON"} invocation and output retain distinct readable extents`, { timeout: 30_000 }, async (t) => {
        const output = Array.from({ length: 40 }, (_, index) => `result ${index + 1}`).join("\n");
        let calls = 0;
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name: "receipt-fixture", version: "1.0.0" });
            server.registerTool("inspect", {
                description: "Return forty result lines.",
                inputSchema: fromJsonSchema({ type: "object", properties: { query: { type: "string" } }, additionalProperties: false }),
            }, async (args) => {
                calls += 1;
                assert.deepEqual(args, body === null ? {} : JSON.parse(body));
                return { content: [{ type: "text", text: output }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        const frame = PlurnkParser.frame;
        const provider = new StreamMock({ contextWindow: 100_000, responses: [
            frame("fixture (inspect)", body),
            frame("READ ($INVOCATION) <17,40>", null),
            frame("READ ($STREAM) <17,40>", null),
            frame("SEND", "The output's tail is result 40."),
        ].map(makeMockResponse) });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider });
        daemon.registerModule(McpModule.init({ env: {
            PLURNK_MCP_FIXTURE: served.url, PLURNK_MCP_ENABLED: '["fixture"]',
            PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
        } }));
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const ws = await connect({ daemon });
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { name: "mcp-receipt-recovery" });
        const result = await runLoopToTerminal(ws, 2, { prompt: "Inspect the tool result.", policy: { proposals: "accept" } });
        assert.equal(result.finalStatus, 200);
        assert.equal(calls, 1, "READs retrieve retained output without repeating the MCP tool call");
        const packet = async (index: number) => {
            const stored = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds![index]! });
            assert.ok(stored);
            return logEntries(JSON.parse(stored.packet));
        };
        const observed = await packet(2);
        const invocation = observed.find((row) => String(row.logPath).endsWith("/fixture"));
        assert.ok(invocation);
        assert.equal(invocation.lines, body === null ? undefined : 1);
        assert.equal(invocation.path, "inspect", "the invoked MCP tool remains distinct from its output");
        const automatic = observed.find((row) => row.path === invocation.stream && String(row.logPath).endsWith("/READ"));
        assert.ok(automatic);
        assert.equal(automatic.source, undefined);
        assert.equal(automatic.stream, undefined);
        assert.equal(automatic.range, "<1,16> of 40 lines");
        const failed = (await packet(3)).find((row) => row.path === invocation.logPath && row.status === 416);
        assert.ok(failed);
        assert.equal((failed.problem as { range: { total: number } }).range.total, body === null ? 0 : 1);
        if (body === null) assert.equal((failed.problem as { stream: string }).stream, invocation.stream);
        const explicit = (await packet(4)).find((row) => row.path === invocation.stream && row.origin === undefined);
        assert.ok(explicit, "the actual MCP output is read at the address advertised in the packet");
        assert.equal(explicit.terminal, true, "MCP's JSON channel declaration does not hide its lifecycle");
        assert.equal(explicit.range, "<17,40> of 40 lines");
        assert.match(String(explicit.body), /40:result 40\n$/u);
    });
}
