import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser, type FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorker, openMigrated } from "./_helpers.ts";

test("{§workspace-environment-sharing}: MCP definitions belong to the workspace without any conversation worker", async (t) => {
    const server = await serveMcpHttp(t, createMcpHandler(() => {
        const mcp = new McpServer({ name: "shared-fixture", version: "1.0.0" });
        mcp.registerTool("echo", {
            inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
            annotations: { readOnlyHint: true },
        }, async () => ({ content: [{ type: "text", text: "workspace tool" }] }));
        mcp.registerResource("shared-item", "fixture://shared/item", { mimeType: "text/plain" }, async () => ({
            contents: [{ uri: "fixture://shared/item", mimeType: "text/plain", text: "shared resource" }],
        }));
        return mcp;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 1_000_000, responses: [] });
    const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules") });
    daemon.registerModule(McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
    } }));
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "shared-functionality" });
    const other = await daemon.createWorkspace({ name: "other-functionality" });
    const action = (id: number, verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(
        `workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId: id },
    );
    const added = await action(workspaceId, "add", {
        alias: "shared", definition: { name: "shared", transport: "http", url: server.url, read: ["echo"] },
    }) as { status: number };
    assert.equal(added.status, 201);
    const listed = await action(workspaceId, "list") as FunctionalityListResult;
    assert.equal(listed.definitions.find(({ alias }) => alias === "shared")?.state, "active");
    assert.equal((await action(other.workspaceId, "list") as FunctionalityListResult).definitions.length, 0,
        "the workspace boundary remains real");
    const alice = await insertWorker(db, workspaceId, null, "alice", "model");
    const bob = await insertWorker(db, workspaceId, null, "bob", "model");
    assert.deepEqual((await action(workspaceId, "list") as FunctionalityListResult).definitions, listed.definitions,
        "creating workers neither copies nor redefines the shared environment");
    const repeated = await action(workspaceId, "add", {
        alias: "shared", definition: { name: "shared", transport: "http", url: server.url, read: ["echo"] },
    }) as { status: number };
    assert.equal(repeated.status, 200, "a second client's identical configuration reuses the workspace definition");
    const read = PlurnkParser.parseStatements(PlurnkParser.frame("READ (shared:///resources) <1,-1>", null)).items[0];
    assert.equal(read?.kind, "statement");
    if (read?.kind !== "statement") throw new Error("Expected one READ");
    for (const workerId of [alice, bob]) {
        const docs = await daemon.engine.referenceEntries(workspaceId);
        assert.ok(docs.some(({ content }) => content.includes("shared (echo)")), "every worker discovers the same enabled tool");
        const catalog = await daemon.look({ workspaceId, workerId, statement: read.statement });
        assert.equal(catalog.status, 200, JSON.stringify(catalog));
        assert.match(String(catalog.content), /fixture:\/\/shared\/item/u);
    }
    await assert.rejects(() => action(workspaceId, "add", {
        alias: "shared", definition: { name: "shared", transport: "http", url: `${server.url}?different` },
    }), (cause: unknown) => {
        assert.ok(cause instanceof Error && "result" in cause);
        assert.equal((cause.result as { status: number }).status, 409);
        assert.match(JSON.stringify(cause.result), /alias-exists/);
        return true;
    });
    await action(workspaceId, "disable", { alias: "shared" });
    assert.equal((await action(workspaceId, "list") as FunctionalityListResult).definitions[0]?.state, "disabled");
    const docs = await daemon.engine.referenceEntries(workspaceId);
    assert.equal(docs.some(({ content }) => content.includes("shared (echo)")), false, "disable changes the one shared discovery surface");
    assert.equal(provider.received.length, 0, "environment management never invokes a model");
});
