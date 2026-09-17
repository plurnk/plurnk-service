import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { insertWorker, openMigrated, fixtureExecutors } from "./_helpers.ts";
import { makeMockResponse, waitForDb } from "./_rpc.ts";

process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "60000";

const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");
const read = (uri: string) => PlurnkParser.frame(`READ (fixture://${resourcePath(uri)}) <1,-1>`, null);

test("{§mcp-host-composition} {§actor-boundary-lineage-attention} resource updates refresh a later READ without changing history or waking unrelated workers", { timeout: 20_000 }, async (t) => {
    const alpha = "fixture://alpha";
    const beta = "fixture://beta";
    const documents = new Map([[alpha, "alpha-version-one"], [beta, "beta-version-one"]]);
    const reads = new Map([[alpha, 0], [beta, 0]]);
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "resource-observation", version: "1.0.0" }, {
            capabilities: { resources: { subscribe: true } },
        });
        for (const [uri] of documents) {
            server.registerResource(uri, uri, {
                mimeType: "text/plain", cacheHint: { ttlMs: 60_000, cacheScope: "private" },
            }, async () => {
                reads.set(uri, reads.get(uri)! + 1);
                return { contents: [{ uri, mimeType: "text/plain", text: documents.get(uri)! }] };
            });
        }
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler);
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        `${read(alpha)}\n\n${read(beta)}\n\n${step("NOTE")}`,
        step("SEND"),
        step("SEND"),
        `${read(alpha)}\n\n${step("NOTE")}`,
        step("SEND"),
    ].map(makeMockResponse) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules") });
    daemon.registerModule(McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
        PLURNK_MCP_FIXTURE: served.url, PLURNK_MCP_ENABLED: '["fixture"]',
    } }));
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-resource-observation" });
    const alice = await insertWorker(db, workspaceId, null, "alice", "model");
    const bob = await insertWorker(db, workspaceId, null, "bob", "model");
    const client = await insertWorker(db, workspaceId, null, "viewer", "client");
    const lifecycle = new LoopLifecycle(db);
    const run = async (workerId: number) => {
        const result = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect the resource.", policy: { proposals: "accept" } });
        await waitForDb(() => lifecycle.status(result.loopId), (status) => status === 200);
        return result;
    };
    const packet = (index: number) => provider.received[index]!.map(chatMessageText).join("\n");
    const look = (uri: string) => {
        const source = read(uri);
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement");
        if (item?.kind !== "statement") throw new Error("Expected one READ");
        return daemon.look({ workspaceId, workerId: client, statement: item.statement });
    };
    const first = await run(alice);
    assert.equal(provider.received.length, 2);
    assert.match(packet(1), /alpha-version-one/u);
    assert.match(packet(1), /beta-version-one/u);
    const history = await db.test_log_entries_by_loop.all({ loop_id: first.loopId });
    assert.equal((await look(alpha)).content, "alpha-version-one");
    assert.equal((await look(beta)).content, "beta-version-one");
    assert.deepEqual([...reads.values()], [1, 1], "a second actor reads the same workspace attachment's cached resources");
    const subscriptions = served.requests.flatMap(({ body }) => {
        const message = body as { method?: string; params?: { notifications?: { resourceSubscriptions?: string[] } } };
        return message.method === "subscriptions/listen" ? [message.params?.notifications?.resourceSubscriptions ?? []] : [];
    });
    assert.deepEqual(subscriptions.at(-1), [alpha, beta], "both READs joined the acknowledged resource filter");

    documents.set(alpha, "alpha-version-two");
    for (let index = 0; index < 32; index++) handler.notify.resourceUpdated(alpha);
    const refreshed = await waitForDb(() => look(alpha), (result) => result.content === "alpha-version-two");
    assert.equal(refreshed.status, 200);
    assert.equal((await look(beta)).content, "beta-version-one");
    assert.deepEqual([...reads.values()], [2, 1], "the selected resource is invalidated; the other cached body stays valid");
    assert.equal(provider.received.length, 2, "neither resource notifications nor client READs invoke a model");
    assert.deepEqual(await db.test_log_entries_by_loop.all({ loop_id: first.loopId }), history,
        "refreshing a source never rewrites the earlier operation receipts");
    assert.deepEqual(await db.test_loops_statuses_by_worker.all({ worker_id: bob }), [], "an unrelated worker acquired no loop");

    await run(bob);
    assert.equal(provider.received.length, 3);
    assert.doesNotMatch(packet(2), /(?:alpha|beta)-version-/u, "ordinary remote changes create no ambient resource rows");
    await run(alice);
    assert.equal(provider.received.length, 5);
    assert.match(packet(3), /alpha-version-one/u, "the next loop still sees its own original observation");
    assert.doesNotMatch(packet(3), /alpha-version-two/u, "updated content is not pushed into the worker's packet");
    assert.match(packet(4), /alpha-version-two/u, "an explicit model READ receives the updated source");
    assert.deepEqual([...reads.values()], [2, 1], "the model shares the refreshed cache rather than fetching again");
    assert.deepEqual(await db.test_log_entries_by_loop.all({ loop_id: first.loopId }), history);
});
