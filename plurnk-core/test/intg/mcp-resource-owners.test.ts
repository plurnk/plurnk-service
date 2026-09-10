import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolve } from "node:path";
import { McpServer, createMcpHandler, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { insertWorker, openMigrated } from "./_helpers.ts";
import { makeMockResponse, waitForDb } from "./_rpc.ts";

process.env.PLURNK_SERVICE_WORKER_WARM_MS = "0";
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
const uri = "fixture://resource/item";
const guardedUri = "fixture://resource/guarded";
const multipartUri = "fixture://resource/multipart";
const path = resourcePath(uri);
const task = (status: string) => PlurnkParser.frame("TASK", JSON.stringify([{ content: "Inspect the resource.", status }]));

const statement = (source: string) => {
    const parsed = PlurnkParser.parseStatements(source);
    assert.equal(parsed.unparsedTail, undefined);
    assert.equal(parsed.items.length, 1);
    const item = parsed.items[0];
    if (item?.kind !== "statement") throw new Error("Expected one operation");
    return item.statement;
};

const fixture = async (t: TestContext, responses: string[] = []) => {
    const reads: string[] = [];
    const paused = new Map<string, { entered: () => void; released: Promise<void> }>();
    const servers = await Promise.all(["alice", "bob"].map(async (name) => {
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name, version: "1.0.0" });
            server.registerResource("item", uri, { mimeType: "text/plain" }, async () => {
                reads.push(name);
                const pause = paused.get(name);
                pause?.entered();
                await pause?.released;
                return { contents: [{ uri, mimeType: "text/plain", text: `${name}'s resource` }] };
            });
            server.registerResource("multipart", multipartUri, { mimeType: "text/plain" }, async () => ({ contents: [
                { uri: "fixture://part/first.txt", mimeType: "text/plain", text: `${name}:first` },
                { uri: "fixture://part/last.txt", mimeType: "text/plain", text: `${name}:last` },
            ] }));
            server.registerResource("guarded", guardedUri, { mimeType: "text/plain" }, async (_uri, ctx) => {
                const answer = inputResponse(ctx.mcpReq.inputResponses, "read");
                if (answer.kind === "missing") return inputRequired({ inputRequests: {
                    read: inputRequired.elicit({
                        message: `Read ${name}'s resource?`,
                        requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"], additionalProperties: false },
                    }),
                } });
                return { contents: [{ uri: guardedUri, mimeType: "text/plain", text: `${name}:${answer.kind === "elicit" ? answer.action : answer.kind}` }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        return { name, ...served };
    }));
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const provider = new Mock({ contextWindow: 1_000_000, responses: responses.map(makeMockResponse) });
    const daemon = new Daemon({ db, schemes, provider, nodeModulesPath: resolve("node_modules") });
    daemon.registerModule(McpModule.init({ env: {
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
    } }));
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-resource-owners" });
    const alice = await insertWorker(db, workspaceId, null, "alice", "model");
    const bob = await insertWorker(db, workspaceId, null, "bob", "model");
    const carol = await insertWorker(db, workspaceId, null, "carol", "model");
    const client = await insertWorker(db, workspaceId, null, "reader", "client");
    const client2 = await insertWorker(db, workspaceId, null, "reader2", "client");
    const action = (workerId: number, operation: string, params: Record<string, unknown>) => daemon.invokeModuleAction(
        `worker.mcp.${operation}`, params, { scope: "worker", workspaceId, workerId },
    );
    for (const { name, url } of servers) {
        const added = await action(name === "alice" ? alice : bob, "add", {
            alias: "shared", definition: { name: "shared", transport: "http", url },
        }) as { status: number };
        assert.equal(added.status, 201);
    }
    const cool = () => waitForDb(async () => !schemes.has("shared", alice) && !schemes.has("shared", bob), Boolean);
    await cool();
    const read = (target: string, functionalityWorkerId = alice, workerId = client) => daemon.look({
        workspaceId, workerId, functionalityWorkerId, statement: statement(PlurnkParser.frame(`READ (${target}) <1,-1>`, null)),
    });
    return { db, daemon, provider, schemes, workspaceId, alice, bob, carol, client, client2, read, reads, paused, action, cool };
};

test("{§runtime-resource-binding}: cold MCP ownership, catalog links, caller policy, and concurrent connection leases", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    assert.equal(f.provider.received.length, 0, "attaching and cooling never invokes a model");
    const foreign = await f.read(`shared://bob${path}`);
    assert.equal(foreign.content, "bob's resource", JSON.stringify(foreign));
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource");
    assert.equal((await f.read(`shared://bob${path}`, f.carol)).content, "bob's resource", "a reader need not attach the addressed runtime itself");
    assert.equal((await f.read(`shared://missing${path}`)).status, 404);
    assert.equal((await f.read(`shared://carol${path}`)).status, 501);
    const catalog = await f.read("shared://bob/resources", f.carol);
    assert.equal(catalog.status, 200, JSON.stringify(catalog));
    const listed = JSON.parse(String(catalog.content)) as { resources: Array<{ uri: string; address: string }> };
    const linked = listed.resources.find((resource) => resource.uri === uri);
    assert.equal(linked?.address, `shared://bob${path}`);
    assert.equal((await f.read(linked!.address, f.carol)).content, "bob's resource");
    const multi = await f.read(`shared://bob${resourcePath(multipartUri)}`, f.carol);
    const parts = [...String(multi.content).matchAll(/<(shared:\/\/bob\/[^>]+)>/gu)].map((match) => match[1]!);
    assert.equal(parts.length, 2, JSON.stringify(multi));
    assert.equal((await f.read(parts[0]!, f.carol)).content, "bob:first");

    await f.daemon.setWorkerCapabilities({ workspaceId: f.workspaceId, workerId: f.bob, policy: { deny: [{ access: "observe", scheme: "shared" }] } });
    assert.equal((await f.read(`shared://bob${path}`, f.carol)).content, "bob's resource", "resource ownership does not replace caller policy with Bob's");
    await f.daemon.setWorkerCapabilities({ workspaceId: f.workspaceId, workerId: f.carol, policy: { deny: [{ access: "observe", scheme: "shared" }] } });
    const before = f.reads.length;
    const denied = await f.read(`shared://bob${path}`, f.carol);
    assert.equal(denied.status, 403, JSON.stringify(denied));
    assert.match(JSON.stringify(denied.problem), /capability-denied/);
    assert.equal(f.reads.length, before, "denied observation never calls resources/read");
    await f.daemon.setWorkerCapabilities({ workspaceId: f.workspaceId, workerId: f.carol, policy: {} });
    await f.cool();

    const aliceEntered = Promise.withResolvers<void>();
    const bobEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.paused.set("alice", { entered: aliceEntered.resolve, released: release.promise });
    f.paused.set("bob", { entered: bobEntered.resolve, released: release.promise });
    const pending = Promise.all([
        f.read(`shared://alice${path}`, f.carol, f.client),
        f.read(`shared://bob${path}`, f.carol, f.client2),
    ]);
    try {
        await Promise.all([aliceEntered.promise, bobEntered.promise]);
        assert.equal(f.schemes.has("shared", f.alice), true);
        assert.equal(f.schemes.has("shared", f.bob), true);
        await assert.rejects(() => f.action(f.bob, "disable", { alias: "shared" }), (error) => {
            assert.ok(error instanceof Error && "problem" in error);
            const problem = error.problem as { status: number; type: string; activeRequests: number };
            assert.equal(problem.status, 409);
            assert.equal(problem.type, "https://problems.plurnk.xyz/mcp/management/server-busy");
            assert.equal(problem.activeRequests, 1);
            return true;
        });
    } finally { release.resolve(); }
    const [aliceResult, bobResult] = await pending;
    assert.equal(aliceResult.content, "alice's resource");
    assert.equal(bobResult.content, "bob's resource");
    await f.cool();
    assert.equal(f.provider.received.length, 0, "cold and concurrent resource access never runs any model");
});

test("{§runtime-resource-binding}: MCP resource elicitation and its receipt belong to the requesting model operation", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (shared://bob${resourcePath(guardedUri)})`, null)}\n\n${task("in_progress")}`,
        `${PlurnkParser.frame("SEND", "The resource was read.")}\n\n${task("completed")}`,
    ]);
    const run = await f.daemon.runLoop({ workspaceId: f.workspaceId, workerId: f.alice, prompt: "Read Bob's guarded resource." });
    const waiting = await waitForDb(() => f.daemon.pendingClientInteractions(f.workspaceId), (items) => items.length === 1);
    const interaction = waiting[0]!;
    assert.equal(interaction.workerId, f.alice);
    assert.equal(interaction.loopId, run.loopId);
    assert.match(JSON.stringify(interaction), /Read bob's resource/);
    await f.daemon.resolveClientInteraction(interaction.interactionId, {
        status: "resolved", payload: { read: { action: "accept", content: { confirm: true } } },
    });
    const lifecycle = new LoopLifecycle(f.db);
    await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200);
    assert.equal(f.provider.received.length, 2, "the owner model never starts");
    assert.match(f.provider.received[1]!.map(chatMessageText).join("\n"), /bob:accept/);
    const receipts = await f.db.test_log_entries_by_loop.all<{ op: string; status_rx: number; target: string }>({ loop_id: run.loopId });
    assert.ok(receipts.some((row) => row.op === "READ" && row.status_rx === 200), "the READ receipt stays in Alice's loop");
    assert.deepEqual(await f.daemon.pendingClientInteractions(f.workspaceId), []);
});

test("{§runtime-resource-binding}: cancelling the requester settles its MCP interaction and releases the owner's connection", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (shared://bob${resourcePath(guardedUri)})`, null)}\n\n${task("in_progress")}`,
    ]);
    const run = await f.daemon.runLoop({ workspaceId: f.workspaceId, workerId: f.alice, prompt: "Read Bob's guarded resource." });
    const pending = await waitForDb(() => f.daemon.pendingClientInteractions(f.workspaceId), (items) => items.length === 1);
    assert.equal(pending[0]!.workerId, f.alice);
    await f.daemon.cancelWorker({ workspaceId: f.workspaceId, workerId: f.alice, reason: "resource reader cancelled" });
    const lifecycle = new LoopLifecycle(f.db);
    await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 499);
    assert.deepEqual(await f.daemon.pendingClientInteractions(f.workspaceId), []);
    await f.cool();
    assert.equal(f.provider.received.length, 1, "neither the cancelled reader nor the resource owner's model continues");
    assert.equal((await f.read(`shared://bob${path}`, f.carol)).content, "bob's resource", "cancellation leaves the owner's attachment usable");
    await f.cool();
    assert.equal(f.provider.received.length, 1);
});
