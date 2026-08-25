// {§tools-resource-materialization} — a PLURNK_MCP_EXPANDED server is surveyed tool by tool at
// turn 0: one FIND row per `## EXEC0` heading of its family document, each carrying the heading,
// annotation, and signature as `matched`. No document is delivered unasked (#359).

import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { logEntries, openMigrated, packetSection } from "./_helpers.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal } from "./_rpc.ts";

const fixture = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/echo-server.mjs", import.meta.url));

test("turn 0 surveys an expanded server's tools as FIND rows carrying heading, annotation, and signature", { timeout: 30_000 }, async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse("## SEND0 [200]\nsurveyed")] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(import.meta.dirname, "../../node_modules") });
    daemon.registerModule(McpModule.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_FIXTURE: process.execPath,
            PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixture]),
            PLURNK_MCP_ENABLED: JSON.stringify(["fixture"]),
            PLURNK_MCP_EXPANDED: JSON.stringify(["fixture"]),
        },
    }));
    await daemon.start();
    try {
        const ws = await connect({ daemon });
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "tools-expanded-survey" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "look around", flags: { auto: true } });
            assert.equal(finalStatus, 200);
            const first = turnIds![1]!;
            const row = await db.test_get_packet.get<{ packet: string }>({ id: first });
            const packet = JSON.parse(row!.packet);
            const entries = logEntries(packet);
            const survey = entries.find((e) => e.annotation === "enabled tools: fixture");
            assert.ok(survey, `the expanded server is surveyed; got ${JSON.stringify(entries.map((e) => [e.path, e.annotation]))}`);
            assert.match(String(survey.path), /\/FIND$/, "the survey is a FIND, not a document READ");
            const log = packetSection(packet, "log");
            assert.match(log, /"matched":"## EXEC0 \[fixture\] \(echo\) <!-- Echo one message\. -->\\n\{\\"message\\": string\}"/, "one row per tool: heading, annotation, signature");
            assert.match(log, /"matched":"## EXEC0 \[fixture\] \(fail\) /, "every tool is a row");
            assert.doesNotMatch(log, /\/READ","annotation":"enabled tools: /, "no family document is delivered unasked");
            assert.doesNotMatch(log, /"path":"worker:\/\/~\/_plurnk\/tools\/fixture\/echo\.md"/, "no child document exists");
        } finally {
            ws.close();
        }
    } finally {
        await daemon.stop();
        await db.close();
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});
