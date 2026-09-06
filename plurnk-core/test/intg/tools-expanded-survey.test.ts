// {§tools-resource-materialization} — a PLURNK_MCP_EXPANDED server is surveyed tool by tool at
// turn 0: one FIND row per `### EXEC0` heading of its family document, each carrying the tool
// heading, annotation, and signature as `matched`. The survey operation itself needs no
// annotation because its target and tags name the family. No document is delivered unasked (#359).

import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock } from "@plurnk/plurnk-providers";
import { Validator } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { logEntries, openMigrated, packetSection } from "./_helpers.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal } from "./_rpc.ts";

const fixture = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/echo-server.mjs", import.meta.url));

test("turn 0 surveys an expanded server's tools without narrating its self-describing target", { timeout: 30_000 }, async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse("### SEND0 (TERM)\nsurveyed")] });
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
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "look around", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            const first = turnIds![1]!;
            const row = await db.test_get_packet.get<{ packet: string }>({ id: first });
            const packet = JSON.parse(row!.packet);
            const entries = logEntries(packet);
            const survey = entries.find((e) => e.target === "worker://~/_plurnk/tools/fixture.md");
            assert.ok(survey, `the expanded server is surveyed; got ${JSON.stringify(entries.map((e) => [e.path, e.target]))}`);
            assert.match(String(survey.path), /\/FIND$/, "the survey is a FIND, not a document READ");
            assert.equal(survey.annotation, undefined, "the target and +tools classification already orient the survey");
            const log = packetSection(packet, "log");
            assert.match(log, /"matched":"### EXEC0 \[fixture\] \(echo\) <!-- Echo one message\. Schema: worker:\/\/~\/_plurnk\/tools\/fixture\/echo\.md -->\\n\{\\"message\\": string\}"/, "one row per tool: heading, annotation, preview, schema link");
            assert.match(log, /"matched":"### EXEC0 \[fixture\] \(fail\) /, "every tool is a row");
            assert.doesNotMatch(log, /"annotation":"enabled tools: /, "no redundant survey annotation is materialized");
            assert.doesNotMatch(log, /"path":"worker:\/\/~\/_plurnk\/tools\/fixture\/echo\.md"/, "schema documents are not individual Turn0 discovery rows");
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

test("{§functionality-model-projection} the model READs the complete installed MCP add schema with its transport and auth contracts", { timeout: 30_000 }, async () => {
    const target = "worker://~/_plurnk/plurnk/mcp/add.md";
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse(`## PLAN0\n[]\n### READ0 (${target}) <1,-1>\n### SEND0 (NEXT)\nRead the input schema.`),
        makeMockResponse("## PLAN0\n[]\n### SEND0 (TERM)\nInspected."),
    ] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(import.meta.dirname, "../../node_modules") });
    daemon.registerModule(McpModule.init({ env: {} }));
    await daemon.start();
    const ws = await connect({ daemon });
    try {
        await rpcCall(ws, 1, "workspace.create", { name: "tools-schema-read" });
        const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Inspect the MCP add input schema." });
        assert.equal(finalStatus, 200);
        const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds!.at(-1)! });
        const read = logEntries(JSON.parse(row!.packet)).find((entry) => entry.target === target);
        assert.ok(read && typeof read.body === "string", "ordinary READ delivers the linked input document to the next model packet");
        const body = read.body.replace(/^(?: *\d+:|@[0-9A-Za-z]{5} +\d+:)/gm, "");
        const schemas = [...body.matchAll(/^```json\n([\s\S]*?)\n```/gm)].map((match) => JSON.parse(match[1]!));
        assert.deepEqual(schemas[0].required, ["definition"]);
        const definition = schemas.find((schema) => schema.$id === "https://schemas.plurnk.xyz/v0/McpServerDefinition.json");
        assert.ok(definition);
        assert.equal(definition.properties.authorization.oneOf.length, 5);
        assert.ok(Object.values(definition.properties).every((field) => typeof (field as { description?: unknown }).description === "string"));
        assert.deepEqual(definition, Validator.schemaByRef("https://schemas.plurnk.xyz/v0/McpServerDefinition.json"));
        assert.match(body, /### EXEC0 \[mcp\] \(add\)/, "the family's existing valid example remains on-demand");
    } finally {
        ws.close();
        await daemon.stop();
        await db.close();
    }
});
