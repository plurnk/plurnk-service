import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolve } from "node:path";
import { McpServer, createMcpHandler, fromJsonSchema, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { PlurnkParser, type CapabilityPolicy } from "@plurnk/plurnk-contracts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { insertWorker, openMigrated } from "./_helpers.ts";
import { makeMockResponse, waitForDb } from "./_rpc.ts";

process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "0";
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
            server.registerTool("snapshot", {
                inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async () => ({ content: [{ type: "resource", resource: {
                uri: "fixture://data/snapshot.txt", mimeType: "text/plain", text: `${name}'s saved result`,
            } }] }));
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
    let schemes = new SchemeRegistry();
    const provider = new Mock({ contextWindow: 1_000_000, responses: responses.map(makeMockResponse) });
    const createDaemon = () => {
        const instance = new Daemon({ db, schemes, provider, nodeModulesPath: resolve("node_modules") });
        instance.registerModule(McpModule.init({ env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
        } }));
        return instance;
    };
    let daemon = createDaemon();
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-resource-owners" });
    const alice = await insertWorker(db, workspaceId, null, "alice", "model");
    const bob = await insertWorker(db, workspaceId, null, "bob", "model");
    const carol = await insertWorker(db, workspaceId, null, "carol", "model");
    const client = await insertWorker(db, workspaceId, null, "reader", "client");
    const client2 = await insertWorker(db, workspaceId, null, "reader2", "client");
    const action = (operation: string, params: Record<string, unknown>) => daemon.invokeModuleAction(
        `workspace.mcp.${operation}`, params, { scope: "workspace", workspaceId },
    );
    for (const { name, url } of servers) {
        const alias = name === "alice" ? "shared" : "other";
        const added = await action("add", {
            alias, definition: { name: alias, transport: "http", url, read: ["snapshot"] },
        }) as { status: number };
        assert.equal(added.status, 201);
    }
    const cool = () => waitForDb(async () => !schemes.has("shared", workspaceId) && !schemes.has("other", workspaceId), Boolean);
    await cool();
    const read = (target: string, workerId = client) => daemon.look({
        workspaceId, workerId, statement: statement(PlurnkParser.frame(`READ (${target}) <1,-1>`, null)),
    });
    const setPolicy = (policy: CapabilityPolicy) => waitForDb(async () => {
        try {
            await daemon.setWorkspaceCapabilities({ workspaceId, policy });
            return true;
        } catch (error) {
            // Zero-grace cooling shares the mutation gate; only its documented busy refusal is retryable.
            if (!(error instanceof OperationFailureError)
                || error.result.problem.type !== "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy") throw error;
            assert.equal(error.result.status, 409);
            assert.equal(error.result.problem.retryable, true);
            return false;
        }
    }, Boolean);
    const restart = async () => {
        await daemon.stop();
        schemes = new SchemeRegistry();
        daemon = createDaemon();
        await daemon.start();
    };
    return { db, get daemon() { return daemon; }, provider, get schemes() { return schemes; }, servers, restart, workspaceId, alice, bob, carol, client, client2, read, reads, paused, action, cool, setPolicy };
};

test("{§runtime-resource-binding}: shared cold MCP resources, catalog links, caller policy, and concurrent connection leases", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    assert.equal(f.provider.received.length, 0, "attaching and cooling never invokes a model");
    const foreign = await f.read(`shared://${path}`);
    assert.equal(foreign.content, "alice's resource", JSON.stringify(foreign));
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource");
    const ownCatalog = await f.read("shared:///resources");
    assert.equal(ownCatalog.status, 200, JSON.stringify(ownCatalog));
    const ownResource = (JSON.parse(String(ownCatalog.content)) as { resources: Array<{ uri: string; address: string }> }).resources.find((resource) => resource.uri === uri)!;
    const followed = await f.read(ownResource.address);
    assert.equal(followed.content, "alice's resource", JSON.stringify({ address: ownResource.address, ...followed }));
    assert.equal((await f.read(`shared://${path}`, f.carol)).content, "alice's resource", "a reader need not attach the addressed runtime itself");
    assert.equal((await f.read(`shared://missing${path}`)).status, 404);
    assert.equal((await f.read(`shared://${path}`)).content, "alice's resource");
    const catalog = await f.read("shared:///resources", f.carol);
    assert.equal(catalog.status, 200, JSON.stringify(catalog));
    const listed = JSON.parse(String(catalog.content)) as { resources: Array<{ uri: string; address: string }> };
    const linked = listed.resources.find((resource) => resource.uri === uri);
    assert.equal(linked?.address, `shared://${path}`);
    assert.equal((await f.read(linked!.address, f.carol)).content, "alice's resource");
    const multi = await f.read(`shared://${resourcePath(multipartUri)}`, f.carol);
    const parts = [...String(multi.content).matchAll(/<(shared:\/\/\/[^>]+)>/gu)].map((match) => match[1]!);
    assert.equal(parts.length, 2, JSON.stringify(multi));
    assert.equal((await f.read(parts[0]!, f.carol)).content, "alice:first");

    await f.setPolicy({ deny: [{ access: "observe", scheme: "shared" }] });
    const before = f.reads.length;
    const denied = await f.read(`shared://${path}`, f.carol);
    assert.equal(denied.status, 403, JSON.stringify(denied));
    assert.match(JSON.stringify(denied.problem), /capability-denied/);
    assert.equal(f.reads.length, before, "denied observation never calls resources/read");
    await f.setPolicy({});
    await f.cool();

    const aliceEntered = Promise.withResolvers<void>();
    const bobEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.paused.set("alice", { entered: aliceEntered.resolve, released: release.promise });
    f.paused.set("bob", { entered: bobEntered.resolve, released: release.promise });
    const pending = Promise.all([
        f.read(`shared://${path}`, f.client),
        f.read(`other://${path}`, f.client2),
    ]);
    try {
        await Promise.all([aliceEntered.promise, bobEntered.promise]);
        assert.equal(f.schemes.has("shared", f.workspaceId), true);
        assert.equal(f.schemes.has("other", f.workspaceId), true);
        await assert.rejects(() => f.action("disable", { alias: "other" }), (error) => {
            assert.ok(error instanceof OperationFailureError);
            const { problem } = error.result;
            assert.equal(problem.status, 409);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/workspace-functionality/workspace-busy");
            assert.equal(problem.workspaceId, f.workspaceId);
            return true;
        });
    } finally { release.resolve(); }
    const [aliceResult, bobResult] = await pending;
    assert.equal(aliceResult.content, "alice's resource");
    assert.equal(bobResult.content, "bob's resource");
    await f.cool();
    assert.equal(f.provider.received.length, 0, "cold and concurrent resource access never runs any model");
});

for (const transition of ["enabled", "disabled", "removed", "producer-removed", "replaced", "restarted"] as const) {
    test(`{§mcp-result-content}: a client can follow its saved result link with the attachment ${transition}`, { timeout: 20_000 }, async (t) => {
        const f = await fixture(t);
        const invoked = await f.daemon.dispatchAsClient({
            workspaceId: f.workspaceId, workerId: f.client, statement: statement(PlurnkParser.frame("shared (snapshot)", "{}")),
        });
        assert.equal(invoked.status, 200, JSON.stringify(invoked));
        const published = await waitForDb(async () => {
            const entries = await f.db.test_entries_by_scheme_prefix.all<{ pathname: string }>({
                workspace_id: f.workspaceId, scheme: "shared", prefix: "%",
            });
            const output = entries.find(({ pathname }) => /^\/[a-f0-9]{8}$/u.test(pathname));
            return output === undefined ? undefined : f.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                pathname: output.pathname, scheme: "shared", name: "body",
            });
        }, (channel) => channel?.content.includes("/resources/snapshot.txt") === true);
        const address = /<(shared:\/\/[^>]+)>/u.exec(published!.content)?.[1];
        assert.ok(address, published!.content);
        if (transition === "disabled" || transition === "removed") {
            const changed = await f.action(transition === "disabled" ? "disable" : "remove", { alias: "shared" }) as { status: number };
            assert.equal(changed.status, 200, JSON.stringify(changed));
        }
        if (transition === "replaced") {
            assert.equal((await f.action("remove", { alias: "shared" }) as { status: number }).status, 200);
            assert.equal((await f.action("add", {
                alias: "shared", definition: { name: "shared", transport: "http", url: f.servers[1]!.url, read: ["snapshot"] },
            }) as { status: number }).status, 201);
            assert.equal((await f.read(`shared://${path}`, f.client2)).content, "bob's resource");
        }
        if (transition === "restarted") {
            assert.equal((await f.action("disable", { alias: "shared" }) as { status: number }).status, 200);
            await f.restart();
        }
        assert.match(address, /^shared:\/\/\/[a-f0-9]{8}\/resources\//u);
        if (transition === "producer-removed") await f.db.test_delete_worker.run({ id: f.client });
        const result = await f.read(address, f.client2);
        assert.equal(result.status, 200, JSON.stringify({ address, transition, result }));
        assert.equal(result.content, "alice's saved result");
        const directory = address.slice(0, address.lastIndexOf("/") + 1);
        const catalog = await f.daemon.dispatchAsClient({
            workspaceId: f.workspaceId, workerId: f.client2,
            statement: statement(PlurnkParser.frame(`FIND (${directory})`, null)),
        });
        assert.equal(catalog.status, 200, JSON.stringify(catalog));
        assert.match(JSON.stringify(catalog), /snapshot\.txt/);
        assert.equal(f.provider.received.length, 0, "reading an artifact requires no model inference");
    });
}

test("{§runtime-resource-binding}: MCP resource elicitation and its receipt belong to the requesting model operation", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (other://${resourcePath(guardedUri)})`, null)}\n\n${task("in_progress")}`,
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

test("{§runtime-resource-binding}: cancelling the requester settles its MCP interaction and releases the shared connection", { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, [
        `${PlurnkParser.frame(`READ (other://${resourcePath(guardedUri)})`, null)}\n\n${task("in_progress")}`,
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
    assert.equal((await f.read(`other://${path}`, f.carol)).content, "bob's resource", "cancellation leaves the workspace attachment usable");
    await f.cool();
    assert.equal(f.provider.received.length, 1);
});
