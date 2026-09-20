import test from "node:test";
import assert from "node:assert/strict";
import {
    SUBSCRIPTION_ID_META_KEY,
    type SubscriptionFilter,
} from "@modelcontextprotocol/client";
import {
    McpServer,
    createMcpHandler,
} from "@modelcontextprotocol/server";
import { serveMcpHttp, type ReceivedRequest } from "../test/http-fixture.ts";
import ServerConnection from "./client.ts";

const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000", PLURNK_MCP_ENABLED: "[]",
};

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

test("resource reads maintain one overlap-replaced subscription for selected cache entries", async (t) => {
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
    const connection = new ServerConnection({
        name: "resources",
        transport: "http",
        url: served.url,
    }, env);
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

test("a remotely ended unified subscription is re-established with a fresh request", async (t) => {
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
    const connection = new ServerConnection({
        name: "recovery",
        transport: "http",
        url: served.url,
    }, env, {
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

test("{§mcp-subscription-ownership} cancelling one resource READ does not cancel another caller's subscription setup", { timeout: 10_000 }, async (t) => {
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
    const connection = new ServerConnection({ name: "shared", transport: "http", url: served.url }, env);
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
