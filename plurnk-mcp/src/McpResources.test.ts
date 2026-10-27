import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EntryStorageWriteResult, RepresentationPreparationRequest } from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
import { ERROR_DETAIL_LIMIT } from "@plurnk/plurnk-execs";
import type { GetPromptResult, SubscriptionFilter } from "@modelcontextprotocol/client";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import McpExecutor from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";
import ResourceContent from "./ResourceContent.ts";
import ServerConnection, { type ServerCatalog } from "./client.ts";
import { httpServer, stdioServer } from "../test/definitions.ts";
import { serveMcpHttp, type ReceivedRequest } from "../test/http-fixture.ts";
import { context, preparationRequest } from "../test/scheme-fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const interactionFixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};
const retainWorkspace = (): (() => void) => () => undefined;

const configured = async (): Promise<{
    connection: ServerConnection;
    resources: McpResources;
}> => {
    const connection = new ServerConnection(stdioServer("echo", [fixture]), env);
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        retainWorkspace,
    );
    await executor.requireAvailable();
    return {
        connection,
        resources: new McpResources("echo", connection, executor.catalog),
    };
};

const interactionResources = async (): Promise<{
    connection: ServerConnection;
    resources: McpResources;
}> => {
    const connection = new ServerConnection(stdioServer("interaction", [interactionFixture]), env);
    const executor = new McpExecutor(
        { runtime: "interaction", glyph: "🔌" },
        connection,
        retainWorkspace,
    );
    await executor.requireAvailable();
    return {
        connection,
        resources: new McpResources("interaction", connection, executor.catalog),
    };
};

test("{§mcp-model-projection} resource facet materializes current MCP resources as ordinary entries", async () => {
    const { connection, resources } = await configured();
    try {
        const { ctx, entries } = context();
        const pathname = "/resources/fixture%3A%2F%2Fdocument";
        const result = await resources.prepareRepresentation(preparationRequest(pathname), ctx);
        assert.equal(result.status, 200);
        assert.equal(entries.get(pathname)?.channels.body?.content, "alpha\nbeta\ngamma\n");
        assert.equal(entries.get(pathname)?.channels.body?.mimetype, "text/plain");
        assert.deepEqual(entries.get(pathname)?.attributes, { kind: "mcp-resource" });
    } finally {
        await connection.close();
    }
});

test("{§mcp-model-projection} resource catalogs never become a parallel tool discovery surface", async () => {
    const { connection, resources } = await configured();
    try {
        const { ctx, entries } = context();
        const result = await resources.prepareRepresentation(preparationRequest("/"), ctx);
        assert.equal(result.status, 200);
        const catalog = JSON.parse(entries.get("/")?.channels.body?.content ?? "{}") as Record<string, unknown>;
        assert.deepEqual(Object.keys(catalog).toSorted(), ["prompts", "resourceTemplates", "resources"]);
        assert.equal(JSON.stringify(catalog).includes("fail"), false);
        assert.equal(resources.claims("/echo"), false);
        assert.equal(resources.claims("/fail"), false);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} prompt definitions and retrieval use the server resource authority", async () => {
    const { connection, resources } = await configured();
    try {
        const { ctx, entries } = context();
        const pathname = "/prompts/summarize";
        const base = preparationRequest(pathname);
        if (base.target.kind !== "url") throw new Error("fixture prompt target must be a URL");
        const request: RepresentationPreparationRequest = {
            ...base,
            target: {
                ...base.target,
                raw: "echo:///prompts/summarize?topic=MCP",
                query: "topic=MCP",
            },
        };
        const result = await resources.prepareRepresentation(request, ctx);
        assert.equal(result.status, 200);
        const prompt = JSON.parse(entries.get(pathname)?.channels.body?.content ?? "{}") as {
            messages?: unknown;
        };
        assert.deepEqual(prompt.messages, [{
            role: "user",
            content: { type: "text", text: "Summarize MCP." },
        }]);
        assert.deepEqual(entries.get(pathname)?.attributes, { kind: "mcp-prompt" });
    } finally {
        await connection.close();
    }
});

test("{§mcp-authority} resource materialization routes MCP elicitation through SchemeCtx", async () => {
    const { connection, resources } = await interactionResources();
    try {
        const { ctx, entries } = context();
        ctx.interactions.request = async (request) => {
            assert.equal(request.toolName, "mcp_input_required");
            assert.equal(request.mode, "form");
            assert.equal(request.message, "Read the guarded resource?");
            return {
                action: "accept",
                content: { confirm: true },
            };
        };
        const pathname = "/resources/fixture%3A%2F%2Fguarded";
        const result = await resources.prepareRepresentation(preparationRequest(pathname), ctx);
        assert.equal(result.status, 200);
        assert.equal(entries.get(pathname)?.channels.body?.content, "read:accept");
    } finally {
        await connection.close();
    }
});

test("{§mcp-result-content} prompt content keeps roles and order while exposing typed snapshots and lazy resource links", async () => {
    const result: GetPromptResult = {
        description: "Inspect these resources.",
        messages: [
            { role: "user", content: { type: "text", text: "Keep this text unchanged.\n" } },
            { role: "assistant", content: { type: "image", data: "AQID", mimeType: "image/png", annotations: { audience: ["assistant"] } } },
            { role: "user", content: { type: "audio", data: "BAUG", mimeType: "audio/wav" } },
            { role: "user", content: { type: "resource", resource: { uri: "test:///notes.txt", text: "notes\r\n", mimeType: "text/plain" } } },
            { role: "user", content: { type: "resource", resource: { uri: "test:///notes.txt", blob: "BwgJ", mimeType: "application/octet-stream" } } },
            { role: "user", content: { type: "resource_link", name: "remote", uri: "test:///remote", mimeType: "image/png" } },
        ],
    };
    const calls: unknown[] = [];
    const connection = {
        async getPrompt(...args: unknown[]) { calls.push(args.slice(0, 2)); return result; },
    } as unknown as ServerConnection;
    const resources = new McpResources("echo", connection, {} as ServerCatalog);
    const { ctx, entries } = context();
    const pathname = "/prompts/inspect";
    const base = preparationRequest(pathname);
    assert.equal(base.target.kind, "url");
    if (base.target.kind !== "url") throw new Error("Expected URL fixture");
    const request = { ...base, target: { ...base.target, query: "topic=images" } };
    assert.equal((await resources.prepareRepresentation(request, ctx)).status, 200);
    assert.deepEqual(calls, [["inspect", { topic: "images" }]]);
    const root = entries.get(pathname)!;
    const projected = JSON.parse(root.channels.body.content) as GetPromptResult;
    assert.deepEqual(projected.messages.map(({ role }) => role), result.messages.map(({ role }) => role));
    assert.deepEqual(projected.messages[0], result.messages[0]);
    assert.deepEqual(JSON.parse(root.channels.json.content), result, "raw protocol evidence is unchanged");
    assert.doesNotMatch(root.channels.body.content, /AQID|BAUG|BwgJ/u);
    const parts = projected.messages.slice(1).map(({ content }) => {
        assert.equal(content.type, "resource_link");
        return content;
    });
    assert.match(parts[0].uri, /echo:\/\/owner\/prompts\/inspect\/resources\/[a-f0-9]{8}$/u);
    assert.deepEqual(parts[0].annotations, { audience: ["assistant"] });
    assert.match(parts[2].uri, /\/notes\.txt$/u);
    assert.match(parts[3].uri, /\/notes\.txt\.[a-f0-9]{8}$/u);
    assert.equal(parts[4].uri, "echo://owner/resources/test%3A%2F%2F%2Fremote");
    const children = parts.slice(0, 4).map(({ uri }) => new URL(uri).pathname);
    assert.deepEqual(entries.get(children[0])!.channels.body.bytes, Buffer.from([1, 2, 3]));
    assert.equal(entries.get(children[1])!.channels.body.mimetype, "audio/wav");
    assert.equal(entries.get(children[2])!.channels.body.content, "notes\r\n");
    assert.deepEqual(entries.get(children[3])!.channels.body.bytes, Buffer.from([7, 8, 9]));
    for (const path of children) assert.equal((await resources.prepareRepresentation(preparationRequest(path), ctx)).status, 200);
    assert.equal(calls.length, 1, "reading a snapshot never re-executes the argument-bearing prompt");
    assert.equal((await resources.prepareRepresentation(preparationRequest(`${pathname}/resources/missing`), ctx)).status, 404);
    assert.equal(calls.length, 1, "a missing snapshot does not silently re-execute the prompt");
    assert.equal((await resources.prepareRepresentation(request, ctx)).status, 200);
    assert.equal(entries.get(pathname)!.channels.body.content, root.channels.body.content, "reconstructed resources keep their names");
});

test("{§mcp-model-projection} the resource facet refuses a malformed encoded address as resource-address-invalid, 400, not retryable", async () => {
    const { connection, resources } = await configured();
    try {
        const result = await resources.prepareRepresentation(
            preparationRequest("/resources/%E0%A4%A"),
            context().ctx,
        );
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/mcp/resource-address-invalid");
        assert.equal(result.problem?.retryable, false);
    } finally {
        await connection.close();
    }
});

test("{§error-detail-bound} MCP resource failures bound third-party diagnostics", async () => {
    const prior = process.env[ERROR_DETAIL_LIMIT];
    process.env[ERROR_DETAIL_LIMIT] = "4";
    try {
        const connection = {
            async readResource() { throw new Error("sensitive remote diagnostic"); },
        } as unknown as ServerConnection;
        const catalog = {
            protocolVersion: "2026-07-28",
            server: { name: "fixture", version: "1" },
            capabilities: {},
            tools: [],
            resources: [{ uri: "fixture://document", name: "document" }],
            resourceTemplates: [],
            prompts: [],
            unsupportedLists: [],
        } as unknown as ServerCatalog;
        const resources = new McpResources("fixture", connection, catalog);
        const result = await resources.prepareRepresentation(
            preparationRequest("/resources/fixture%3A%2F%2Fdocument"),
            context().ctx,
        );

        assert.equal(result.status, 502);
        assert.equal(result.problem?.diagnostic, "sens...");
        assert.doesNotMatch(JSON.stringify(result), /sensitive remote diagnostic/u);
    } finally {
        if (prior === undefined) delete process.env[ERROR_DETAIL_LIMIT];
        else process.env[ERROR_DETAIL_LIMIT] = prior;
    }
});

test("{§mcp-setup} resource materialization preserves a failed entry write's original Problem", async () => {
    const { connection, resources } = await configured();
    try {
        const failedWrite = Results.failure(
            "scheme:test-storage",
            "write-denied",
            409,
            "The canonical entry write was rejected.",
            { created: false, entryId: null },
        ) as EntryStorageWriteResult;
        const { ctx } = context();
        ctx.entries.write = async () => failedWrite;

        const result = await resources.prepareRepresentation(
            preparationRequest("/resources/fixture%3A%2F%2Fdocument"),
            ctx,
        );

        assert.equal(result.status, 409);
        assert.equal(result.problem, failedWrite.problem);
    } finally {
        await connection.close();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Resource Content ({§mcp-result-content})
// ─────────────────────────────────────────────────────────────────────────────

test("{§mcp-result-content} resource names come from filenames, not opaque URI payloads", () => {
    assert.equal(ResourceContent.name({ uri: "file:///tmp/screen%20shot.png", blob: "" }), "screen shot.png");
    for (const uri of ["fixture://image", "urn:example:screenshot", "data:image/png;base64,AA=="]) {
        assert.equal(ResourceContent.name({ uri, blob: "" }), undefined);
    }
});

test("{§mcp-result-content} resource text and binary bodies retain content and declared mimetype", () => {
    assert.deepEqual(ResourceContent.channel({ uri: "fixture://text", text: "one\r\ntwo\n" }), { content: "one\r\ntwo\n", mimetype: "text/plain" });
    assert.deepEqual(ResourceContent.channel({ uri: "fixture://bytes", blob: "AQID" }), { content: "", bytes: Buffer.from([1, 2, 3]), mimetype: "application/octet-stream" });
    assert.equal(ResourceContent.channel({ uri: "fixture://bytes", blob: "AQID", mimeType: "image/png" }).mimetype, "image/png");
});

// ─────────────────────────────────────────────────────────────────────────────
// Resource Subscriptions ({§mcp-authority}, {§mcp-tasks})
// ─────────────────────────────────────────────────────────────────────────────

const bodyOf = (request: ReceivedRequest): Record<string, unknown> =>
    request.body as Record<string, unknown>;

const methodOf = (request: ReceivedRequest): string | undefined => {
    const method = bodyOf(request).method;
    return typeof method === "string" ? method : undefined;
};

const listenFilters = (requests: readonly ReceivedRequest[]): SubscriptionFilter[] =>
    requests
        .filter((request) => methodOf(request) === "subscriptions/listen")
        .map((request) => {
            const params = bodyOf(request).params as { notifications?: SubscriptionFilter };
            assert.ok(params.notifications);
            return params.notifications;
        });

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(predicate(), "condition did not become true");
};

test("{§mcp-authority} resource reads maintain one overlap-replaced subscription for selected cache entries", async (t) => {
    const documents = new Map([
        ["fixture://alpha", "alpha-1"],
        ["fixture://beta", "beta-1"],
    ]);
    const handler = createMcpHandler(() => {
        const server = new McpServer(
            { name: "resource-subscription-fixture", version: "1.0.0" },
            { capabilities: { resources: { subscribe: true } } },
        );
        for (const [uri] of documents) {
            server.registerResource(
                uri,
                uri,
                {
                    mimeType: "text/plain",
                    cacheHint: { ttlMs: 60_000, cacheScope: "public" },
                },
                async (resource) => ({
                    contents: [{
                        uri: resource.href,
                        mimeType: "text/plain",
                        text: documents.get(resource.href) ?? "missing",
                    }],
                }),
            );
        }
        return server;
    }, {
        legacy: "reject",
        responseMode: "auto",
        keepAliveMs: 0,
    });
    const served = await serveMcpHttp(t, handler);
    const connection = new ServerConnection(httpServer("resources", served.url), env);
    let cancellationsBeforeClose = 0;
    try {
        const client = await connection.connect();
        await waitFor(() => listenFilters(served.requests).length === 1);

        const alpha = await connection.readResource("fixture://alpha");
        assert.equal(alpha.contents[0] && "text" in alpha.contents[0]
            ? alpha.contents[0].text
            : undefined, "alpha-1");
        assert.deepEqual(listenFilters(served.requests).at(-1), {
            resourcesListChanged: true,
            resourceSubscriptions: ["fixture://alpha"],
        });

        await connection.readResource("fixture://beta");
        assert.deepEqual(listenFilters(served.requests).at(-1), {
            resourcesListChanged: true,
            resourceSubscriptions: ["fixture://alpha", "fixture://beta"],
        });

        const methods = served.requests.map(methodOf);
        const replacement = methods.lastIndexOf("subscriptions/listen");
        const priorCancellation = methods.lastIndexOf("notifications/cancelled");
        assert.ok(replacement < priorCancellation, "replacement is acknowledged before the old stream closes");

        const updated = Promise.withResolvers<void>();
        client.setNotificationHandler("notifications/resources/updated", (notification) => {
            if (notification.params?.uri === "fixture://alpha") updated.resolve();
        });
        documents.set("fixture://alpha", "alpha-2");
        handler.notify.resourceUpdated("fixture://alpha");
        await updated.promise;
        const result = await connection.readResource("fixture://alpha");
        const [content] = result.contents;
        const refreshed = content !== undefined && "text" in content ? content.text : "";
        assert.equal(refreshed, "alpha-2");
        assert.equal(
            served.requests.filter((request) => methodOf(request) === "resources/read").length,
            3,
            "the update invalidates the cached alpha body without disturbing beta",
        );
        cancellationsBeforeClose = served.requests
            .filter((request) => methodOf(request) === "notifications/cancelled")
            .length;
    } finally {
        await connection.close();
    }
    assert.equal(
        served.requests.filter((request) => methodOf(request) === "notifications/cancelled").length,
        cancellationsBeforeClose,
        "whole-connection shutdown does not redundantly cancel its listen request",
    );
});

test("{§mcp-authority} a remotely ended unified subscription is re-established with a fresh request", async (t) => {
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "subscription-recovery-fixture", version: "1.0.0" });
        server.registerTool("status", { description: "Return status." }, async () => ({
            content: [{ type: "text", text: "ready" }],
        }));
        return server;
    }, {
        legacy: "reject",
        responseMode: "auto",
        keepAliveMs: 0,
    });
    let intercepted = false;
    const served = await serveMcpHttp(t, handler, async (request) => {
        const message = await request.clone().json() as {
            id?: string | number;
            method?: string;
            params?: { notifications?: SubscriptionFilter };
        };
        if (message.method !== "subscriptions/listen" || intercepted) return null;
        intercepted = true;
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(
                    `event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "notifications/subscriptions/acknowledged",
                        params: {
                            notifications: message.params?.notifications ?? {},
                            _meta: { [SUBSCRIPTION_ID_META_KEY]: message.id },
                        },
                    })}\n\n`,
                ));
                setTimeout(() => controller.close(), 10);
            },
        }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        });
    });
    const catalogChanges: Array<Error | null> = [];
    const subscriptionErrors: Error[] = [];
    const connection = new ServerConnection(httpServer("recovery", served.url), env, {
        onCatalogChanged: (error) => catalogChanges.push(error),
        onInfrastructureError: (error) => subscriptionErrors.push(error),
    });
    try {
        await connection.connect();
        await waitFor(() => listenFilters(served.requests).length === 2);
        assert.deepEqual(listenFilters(served.requests), [
            { toolsListChanged: true },
            { toolsListChanged: true },
        ]);
        assert.equal(subscriptionErrors.length, 0);

        handler.notify.toolsChanged();
        await waitFor(() => catalogChanges.length === 1);
        assert.deepEqual(catalogChanges, [null]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-tasks} cancelling one resource READ does not cancel another caller's subscription setup", { timeout: 10_000 }, async (t) => {
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "shared-subscription", version: "1" }, {
            capabilities: { resources: { subscribe: true } },
        });
        for (const name of ["alpha", "beta"]) server.registerResource(name, `fixture://${name}`, {}, async (uri) => ({
            contents: [{ uri: uri.href, text: `${name} result` }],
        }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const listening = Promise.withResolvers<() => void>();
    const served = await serveMcpHttp(t, handler, async (request) => {
        const message = await request.clone().json() as {
            id: string; method: string; params?: { notifications?: SubscriptionFilter };
        };
        const filter = message.params?.notifications;
        if (message.method !== "subscriptions/listen" || filter?.resourceSubscriptions?.length !== 1) return null;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            request.signal.addEventListener("abort", () => controller.close(), { once: true });
            listening.resolve(() => controller.enqueue(new TextEncoder().encode(
                `event: message\ndata: ${JSON.stringify({
                    jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged",
                    params: { notifications: filter, _meta: { [SUBSCRIPTION_ID_META_KEY]: message.id } },
                })}\n\n`,
            )));
        } }), { headers: { "Content-Type": "text/event-stream" } });
    });
    const connection = new ServerConnection(httpServer("shared", served.url), env);
    const owner = new AbortController();
    let settled = false;
    try {
        await connection.connect();
        const first = connection.readResource("fixture://alpha", owner.signal).then(
            () => { settled = true; return null; },
            (cause: unknown) => { settled = true; return cause; },
        );
        const acknowledge = await listening.promise;
        const other = connection.readResource("fixture://beta");
        owner.abort(new Error("first read cancelled"));
        await waitFor(() => settled);
        assert.match(String(await first), /first read cancelled/u);
        assert.equal(connection.activeRequests, 1, "the second READ is still independently active");
        acknowledge();
        const result = await other;
        assert.deepEqual(result.contents, [{ uri: "fixture://beta", text: "beta result" }]);
        assert.deepEqual(listenFilters(served.requests).at(-1)?.resourceSubscriptions, ["fixture://alpha", "fixture://beta"]);
        assert.equal(served.requests.filter((request) => methodOf(request) === "resources/read").length, 1,
            "the cancelled READ is never dispatched after shared setup finishes");
    } finally {
        owner.abort(new Error("first read cancelled"));
        await connection.close();
    }
});
