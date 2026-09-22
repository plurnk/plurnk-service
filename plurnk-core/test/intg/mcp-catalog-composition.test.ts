import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import { insertWorker, openMigrated, fixtureExecutors } from "./_helpers.ts";
import { makeMockResponse, waitForDb } from "./_rpc.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";

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
        "````SEND\nCatalog tool result observed.\n````",
    ].map(makeMockResponse) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    const mcp = McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "5000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000", PLURNK_MCP_ENABLED: "[]",
    } });
    daemon.registerModule({
        setup: (seam) => mcp.setup({
            readWorkspaceEnvironment: (workspaceId) => seam.readWorkspaceEnvironment(workspaceId),
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
        close: () => mcp.close(),
    });
    t.after(async () => { release.resolve(); await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "catalog-race" });
    const workerId = await insertWorker(db, workspaceId, null, "reader", "model");
    await daemon.invokeModuleAction("workspace.mcp.add", {
        alias: "fixture", definition: { name: "fixture", transport: "http", url: served.url },
    }, { scope: "workspace", workspaceId });
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
    const source = PlurnkParser.frame("READ (worker:///_plurnk/tools/fixture.md) <1,-1>", null);
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    const item = parsed.items[0];
    assert.equal(item?.kind, "statement");
    if (item?.kind !== "statement") throw new Error("Expected one READ");
    const document = await daemon.look({ workspaceId, workerId, statement: item.statement });
    assert.equal(document.status, 200);
    assert.equal(typeof document.content, "string");
    assert.match(document.content as string, /fixture \(third\)/);
    assert.doesNotMatch(document.content as string, /fixture \((?:first|second)\)/);
    assert.equal(provider.received.length, 0, "catalog updates do not invoke the model");
    const loop = await daemon.runLoop({ workspaceId, workerId, prompt: "Use the current tool.", policy: { proposals: "accept" } });
    const lifecycle = new LoopLifecycle(db);
    await waitForDb(() => lifecycle.status(loop.loopId), (status) => status === 200);
    assert.equal(provider.received.length, 2);
    assert.match(provider.received[1]!.map(chatMessageText).join("\n"), /Observed third from the server\./);
};

for (const boundary of boundaries) {
    test(`{§mcp-catalog-refresh-in-place} ${boundary} preserves the current tools, docs, and next model call`,
        { timeout: 15000 }, (t) => verifyRefresh(t, boundary));
}
