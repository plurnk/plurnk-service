import { serverProposals } from "./_approval.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import { insertWorker, openMigrated } from "./_db.ts";
import { fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";

process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "60000";
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";

const boundaries = ["notification during refresh", "aborted publication", "failed listing"] as const;
const verifyRefresh = async (t: TestContext, boundary: typeof boundaries[number]): Promise<void> => {
    let tool = "first";
    let pauseNextList = false;
    let failNextList = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondQueued = Promise.withResolvers<void>();
    const refreshes: Promise<void>[] = [];
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "changing-catalog", version: "1.0.0" });
        const name = tool;
        server.registerTool(name, { description: `Observe ${name}.` }, async () => ({
            content: [{ type: "text", text: `Observed ${name} from the server.` }],
        }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler, async (request) => {
        const body = await request.clone().json();
        if (body.method === "tools/list" && failNextList) {
            failNextList = false;
            return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Transient listing failure." } });
        }
        if (body.method !== "tools/list" || !pauseNextList) return null;
        pauseNextList = false;
        const response = await handler.fetch(request);
        entered.resolve();
        await release.promise;
        return response;
    });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        "````fixture (third)\n{}\n````\n\n````WAIT\nObserve the result.\n````",
        "````KILL\nCatalog tool result observed.\n````",
    ].map(makeMockResponse) });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    const mcp = McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "5000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } });
    daemon.registerModule({
        setup: (seam) => mcp.setup({
            readWorkspacePlugins: (workspaceId) => seam.readWorkspacePlugins(workspaceId),
            workspacePaths: (workspaceId) => seam.workspacePaths(workspaceId),
            readWorkspaceEnvironment: (workspaceId) => seam.readWorkspaceEnvironment(workspaceId),
            operatorEnvironment: () => seam.operatorEnvironment(),
            workspaceStateDirectory: (workspaceId, owner) => seam.workspaceStateDirectory(workspaceId, owner),
            registerModuleAction: (registration) => seam.registerModuleAction(registration),
            registerFunctionalityAdapter: (adapter) => {
                const handle = seam.registerFunctionalityAdapter(adapter);
                return { ...handle, refresh: (...args) => {
                    const pending = handle.refresh(...args);
                    refreshes.push(pending);
                    if (refreshes.length === 2) secondQueued.resolve();
                    return pending;
                } };
            },
        }),
        stop: () => mcp.stop(),
    }, "@plurnk/plurnk-mcp");
    t.after(async () => { release.resolve(); await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "catalog-race" });
    const workerId = await insertWorker(db, workspaceId, null, "reader", "model");
    const read = async (path: string) => {
        const source = PlurnkParser.frame(`READ (${path}) <1,-1>`, null);
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement");
        if (item?.kind !== "statement") throw new Error("Expected one READ");
        return daemon.look({ workspaceId, workerId, statement: item.statement });
    };
    const toolsDocument = async (extension = "md"): Promise<string> => {
        const document = await read(`worker:///_plurnk/tools/fixture.${extension}`);
        assert.equal(document.status, 200);
        assert.equal(typeof document.content, "string");
        return document.content as string;
    };
    // {§mcp-configuration} The first read makes the workspace resident.
    assert.match(await toolsDocument(), /fixture \(first\)/);
    // {§executor-tool-catalog} The catalog shares the same refresh and withdrawal boundary.
    const listRequests = () => served.requests.filter(({ body }) => (body as { method?: string }).method === "tools/list").length;
    const beforeRead = listRequests();
    const names = async (): Promise<string[]> => JSON.parse(await toolsDocument("json")).tools.map((entry: { name: string }) => entry.name);
    assert.deepEqual(await names(), ["first"]);
    assert.equal(listRequests(), beforeRead, "catalog READ reuses discovery rather than listing MCP tools again");
    const catalog = async () => (await daemon.invokeModuleAction("workspace.mcp.list", {}, {
        scope: "workspace", workspaceId,
    })) as { definitions: { alias: string; detail: { tools: string[] } }[] };
    assert.deepEqual((await catalog()).definitions.find(({ alias }) => alias === "fixture")?.detail.tools, ["first"]);

    if (boundary === "notification during refresh") {
        tool = "second";
        pauseNextList = true;
        handler.notify.toolsChanged();
        await entered.promise;
        tool = "third";
        handler.notify.toolsChanged();
    } else {
        tool = "third";
        if (boundary === "aborted publication") {
            t.mock.method(daemon, "replaceWorkspaceCapabilities", async () => {
                throw new OperationFailureError(Results.failure("daemon:workspace-functionality", "workspace-busy", 409,
                    "The fixture holds the publication boundary."));
            }, { times: 1 });
        } else {
            failNextList = true;
        }
        handler.notify.toolsChanged();
    }
    await secondQueued.promise;
    release.resolve();
    const settled = await Promise.allSettled(refreshes);
    assert.deepEqual(settled.map(({ status }) => status), boundary === "aborted publication"
        ? ["rejected", "fulfilled"] : ["fulfilled", "fulfilled"]);
    if (settled[0]?.status === "rejected") {
        assert.ok(settled[0].reason instanceof OperationFailureError);
        assert.equal(settled[0].reason.result.status, 409);
    }

    assert.deepEqual((await catalog()).definitions.find(({ alias }) => alias === "fixture")?.detail.tools, ["third"],
        "the second invalidation must not disappear when the earlier catalog commits");
    const document = await toolsDocument();
    assert.match(document, /fixture \(third\)/);
    assert.doesNotMatch(document, /fixture \((?:first|second)\)/);
    assert.deepEqual(await names(), ["third"]);
    assert.equal((await read("worker:///_plurnk/tools/fixture/first.json")).status, 404,
        "refresh removes the old per-tool schema as well as its catalog definition");
    assert.equal(provider.received.length, 0, "catalog updates do not invoke the model");
    const terminated = Promise.withResolvers<void>();
    const unsubscribe = daemon.subscribeToEvents((scope, method) => {
        if (scope === workspaceId && method === "loop/terminated") terminated.resolve();
    });
    t.after(unsubscribe);
    serverProposals(t, "accept");
    const loop = await daemon.runLoop({ workspaceId, workerId, prompt: "Use the current tool." });
    const lifecycle = new LoopLifecycle(db);
    // {§module-workspace-quiescence}: the stored result precedes turn-gate release.
    await terminated.promise;
    assert.equal(await lifecycle.status(loop.loopId), 200);
    assert.equal(provider.received.length, 2);
    assert.match(provider.received[1]!.map(chatMessageText).join("\n"), /Observed third from the server\./);
    await daemon.invokeModuleAction("workspace.mcp.disable", { alias: "fixture" }, { scope: "workspace", workspaceId });
    for (const path of ["fixture.md", "fixture.json", "fixture/third.json"]) {
        assert.equal((await read(`worker:///_plurnk/tools/${path}`)).status, 404,
            `disabled tools leave no generated resource: ${path}`);
    }
};

for (const boundary of boundaries) {
    test(`{§mcp-catalog-refresh-in-place} ${boundary} preserves the current tools, docs, and next model call`,
        { timeout: 15000 }, (t) => verifyRefresh(t, boundary));
}
