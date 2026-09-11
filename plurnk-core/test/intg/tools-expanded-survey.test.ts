import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser, Validator } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { logEntries, openMigrated, packetSection } from "./_helpers.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal } from "./_rpc.ts";

const fixture = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/echo-server.mjs", import.meta.url));

test("{§tools-resource-discovery} turn 0 exposes executable inline-program bodies in interpreter summaries", { timeout: 30_000 }, async () => {
    const provider = new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse(
        PlurnkParser.frame("TASK", JSON.stringify([{ content: "Inspected the tools.", status: "completed" }])),
    )] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(import.meta.dirname, "../../node_modules") });
    await daemon.start();
    const ws = await connect({ daemon });
    try {
        await rpcCall(ws, 1, "workspace.create", { name: "interpreter-summary-bodies", settings: { filesItems: -1 } });
        const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Inspect the available tools." });
        assert.equal(finalStatus, 200);
        const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds![1]! });
        const survey = logEntries(JSON.parse(row!.packet)).find((entry) => entry.target === "worker:///_plurnk/plurnk/*.md");
        assert.ok(survey && typeof survey.body === "string", "turn 0 carries the generated tool catalog");
        const body = survey.body.replace(/^ *\d+:/gm, "");
        const groups = JSON.parse(body) as Array<Array<{ path: string; aside?: string }>>;
        const node = groups.flat().find(({ path }) => path.endsWith("/node.md"));
        const aside = node?.aside;
        assert.ok(typeof aside === "string" && aside.includes("\\n"), "Node's aside includes its inline body, not just an empty invocation");
        const parsed = PlurnkParser.parseStatements(aside.replaceAll("\\n", "\n"));
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0];
        assert.ok(item?.kind === "statement" && item.statement.op === "EXEC");
        assert.equal(item.statement.executor, "node");
        assert.equal(item.statement.target, null, "the program is not a script path or metadata modifier");
        assert.ok(typeof item.statement.body === "string" && item.statement.body.length > 0);
        assert.ok(item.statement.aside?.includes("JavaScript"), "the description stays on the invocation line");
    } finally {
        ws.close();
        await daemon.stop();
        await db.close();
    }
});

test("{§tools-resource-materialization} turn 0 surveys an expanded server's tools without narrating its self-describing target", { timeout: 30_000 }, async () => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse("```SEND\nsurveyed\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```")] });
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
            const survey = entries.find((e) => e.target === "worker:///_plurnk/tools/fixture.md");
            assert.ok(survey, `the expanded server is surveyed; got ${JSON.stringify(entries.map((e) => [e.path, e.target]))}`);
            assert.match(String(survey.path), /\/FIND$/, "the survey is a FIND, not a document READ");
            assert.equal(survey.aside, undefined, "the target and +tools classification already orient the survey");
            const log = packetSection(packet, "log");
            assert.match(log, /"matched":"````fixture \(echo\) <!-- Echo one message\. Schema: worker:\/\/\/_plurnk\/tools\/fixture\/echo\.md -->\\n\{\\"message\\": string\}\\n````"/, "one row per tool: opening fence, aside, preview, schema link, closing fence");
            assert.match(log, /"matched":"````fixture \(fail\) /, "every tool is a row");
            assert.doesNotMatch(log, /"aside":"enabled tools: /, "no redundant survey aside is materialized");
            assert.doesNotMatch(log, /"path":"worker:\/\/\/_plurnk\/tools\/fixture\/echo\.md"/, "schema documents are not individual Turn0 discovery rows");
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
    const target = "worker:///_plurnk/plurnk/mcp/add.md";
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse(`\`\`\`READ (${target}) <1,-1>\`\`\`
\`\`\`TASK
[{"content":"Read the input schema.","status":"in_progress"}]
\`\`\``),
        makeMockResponse("```SEND\nInspected.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
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
        assert.match(body, /^````mcp \(add\)/m, "the family's existing valid example remains on-demand");
    } finally {
        ws.close();
        await daemon.stop();
        await db.close();
    }
});
