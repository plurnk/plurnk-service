import assert from "node:assert/strict";
import test from "node:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorker, openMigrated, fixtureExecutors } from "./_helpers.ts";

process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "60000";
const uri = "fixture://private-document";

test("{§mcp-host-composition} private caches stay with their authorized workspace attachment across rotation", { timeout: 15000 }, async (t) => {
    const reads: string[] = [];
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "same-server", version: "1.0.0" });
        server.registerResource("document", uri, {}, async () => ({ contents: [{ uri, text: "unused" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }), async (request) => {
        const body = await request.clone().json();
        if (body.method !== "resources/read") return null;
        const identity = request.headers.get("authorization");
        assert.ok(identity !== null && identity.startsWith("Bearer fixture-"));
        reads.push(identity);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
            resultType: "complete", ttlMs: 60000, cacheScope: "private",
            contents: [{ uri, mimeType: "text/plain", text: `Document for ${identity}.` }],
        } });
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule(McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "5000",
    } }));
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const definition = { name: "fixture", transport: "http", url: served.url,
        authorization: { type: "bearer", token: "${ENV_AUTH}" } };
    const workspaces = await Promise.all(["alpha", "beta"].map(async (name) => {
        const { workspaceId } = await daemon.createWorkspace({ name });
        const workerId = await insertWorker(db, workspaceId, null, "reader", "client");
        const otherWorkerId = await insertWorker(db, workspaceId, null, "other", "client");
        const action = (family: string, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        await action("env", "add", { alias: "ENV_AUTH", definition: { value: `fixture-${name}` } });
        await action("mcp", "add", { alias: "fixture", definition });
        const source = PlurnkParser.frame(`READ (fixture://${resourcePath(uri)}) <1,-1>`, null);
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items[0];
        if (item?.kind !== "statement") throw new Error("Expected one READ");
        const read = (reader = workerId) => daemon.look({ workspaceId, workerId: reader, statement: item.statement });
        return { name, action, read, otherWorkerId };
    }));
    for (const workspace of workspaces) {
        assert.equal((await workspace.read()).content, `Document for Bearer fixture-${workspace.name}.`);
        assert.equal((await workspace.read(workspace.otherWorkerId)).content, `Document for Bearer fixture-${workspace.name}.`);
    }
    assert.deepEqual(reads.toSorted(), ["Bearer fixture-alpha", "Bearer fixture-beta"],
        "workers share their workspace cache, not another workspace's identically named authorized attachment");
    const [alpha, beta] = workspaces;
    assert.ok(alpha && beta);
    await alpha.action("env", "remove", { alias: "ENV_AUTH" });
    await alpha.action("env", "add", { alias: "ENV_AUTH", definition: { value: "fixture-rotated" } });
    assert.equal((await alpha.read()).content, "Document for Bearer fixture-alpha.",
        "changing the environment does not silently replace a running attachment");
    await alpha.action("mcp", "disable", { alias: "fixture" });
    await alpha.action("mcp", "enable", { alias: "fixture" });
    assert.equal((await alpha.read()).content, "Document for Bearer fixture-rotated.");
    assert.equal((await beta.read()).content, "Document for Bearer fixture-beta.");
    assert.deepEqual(reads.toSorted(), ["Bearer fixture-alpha", "Bearer fixture-beta", "Bearer fixture-rotated"],
        "rotation uses a fresh cache without invalidating the other attachment");
    for (const workspace of workspaces) {
        const listed = await workspace.action("mcp", "list") as FunctionalityListResult;
        assert.deepEqual(listed.definitions[0]?.definition, definition, "the retained definition stays symbolic");
    }
});
