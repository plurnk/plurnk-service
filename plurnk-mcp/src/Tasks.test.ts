import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/client";
import { serveMcpHttp } from "../test/http-fixture.ts";
import { taskHandler, taskId, wireRequest } from "../test/task-fixture.ts";
import ServerConnection from "./client.ts";
import { mcpRoutingHeaderValue } from "./protocolHeaders.ts";

const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "3000",
};

const stdioFixture = fileURLToPath(new URL("./fixtures/task-server.mjs", import.meta.url));

test("current HTTP Tasks preserve MRTR, task input, polling, notifications, and routing", async (t) => {
    const fixture = taskHandler();
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const connection = new ServerConnection({
        name: "tasks-http",
        transport: "http",
        url: served.url,
    }, env);
    try {
        const catalog = await connection.catalog();
        const tool = catalog.tools.find(({ name }) => name === "deferred-review") as Tool;
        assert.ok(tool);
        const interactions: Array<Record<string, unknown>> = [];
        const result = await connection.callTool(
            "deferred-review",
            { topic: "MCP" },
            undefined,
            undefined,
            async (request) => {
                interactions.push(request.arguments);
                return request.arguments.operation === "tools/call"
                    ? {
                        status: "resolved",
                        payload: {
                            preflight: { action: "accept", content: { proceed: true } },
                        },
                    }
                    : {
                        status: "resolved",
                        payload: {
                            profile: { action: "accept", content: { name: "Ada" } },
                            authorize: { action: "accept" },
                        },
                    };
            },
            tool,
        );
        assert.deepEqual(result.content, [{ type: "text", text: "Ada reviewed MCP" }]);
        assert.deepEqual(interactions.map(({ operation }) => operation), [
            "tools/call",
            "tasks/update",
        ]);
        assert.equal(interactions[0]?.taskId, undefined);
        assert.equal(interactions[1]?.taskId, taskId);
        assert.equal(fixture.updates.length, 1);
        assert.deepEqual({
            taskId: fixture.updates[0]?.taskId,
            inputResponses: fixture.updates[0]?.inputResponses,
        }, {
            taskId,
            inputResponses: {
                profile: { action: "accept", content: { name: "Ada" } },
                authorize: { action: "accept" },
            },
        });

        const taskRequests = served.requests.filter((request) =>
            wireRequest(request).method?.startsWith("tasks/"));
        // The get count is load-dependent (#469): the post-update completion rides an SSE
        // notification racing the 10ms poll window, so the contract is the shape
        // get+ update get+ — never an exact sequence.
        const taskMethods = taskRequests.map((request) => wireRequest(request).method);
        assert.deepEqual(taskMethods.filter((method) => method !== "tasks/get"), ["tasks/update"]);
        const updateIndex = taskMethods.indexOf("tasks/update");
        assert.ok(updateIndex > 0, `a tasks/get precedes the update: ${taskMethods.join(", ")}`);
        assert.ok(updateIndex < taskMethods.length - 1,
            `a tasks/get follows the update: ${taskMethods.join(", ")}`);
        const operationIds = served.requests
            .map(wireRequest)
            .filter(({ method }) => method === "tools/call" || method?.startsWith("tasks/"))
            .map(({ id }) => id);
        assert.equal(new Set(operationIds).size, operationIds.length);
        for (const request of taskRequests) {
            assert.equal(request.headers.get("mcp-name"), mcpRoutingHeaderValue(taskId));
            assert.equal(request.headers.get("mcp-method"), wireRequest(request).method);
        }
        const taskFilters = served.requests
            .map(wireRequest)
            .filter(({ method }) => method === "subscriptions/listen")
            .map(({ params }) => (params?.notifications as { taskIds?: string[] } | undefined)?.taskIds)
            .filter((ids): ids is string[] => ids !== undefined);
        assert.deepEqual(taskFilters, [[taskId]]);
        assert.equal(
            served.requests.some((request) => [
                "tasks/list",
                "tasks/result",
                "resources/subscribe",
            ].includes(wireRequest(request).method ?? "")),
            false,
        );
    } finally {
        await connection.close();
    }
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(predicate(), "condition did not become true");
};

test("Task completion preserves tool errors while failed Tasks preserve protocol errors", async (t) => {
    const toolErrorFixture = taskHandler("tool-error");
    const toolErrorServer = await serveMcpHttp(
        t,
        toolErrorFixture.handler,
        toolErrorFixture.route,
    );
    const toolErrorConnection = new ServerConnection({
        name: "task-tool-error",
        transport: "http",
        url: toolErrorServer.url,
    }, env);
    try {
        const tool = (await toolErrorConnection.catalog()).tools.find(
            ({ name }) => name === toolErrorFixture.toolName,
        )!;
        const result = await toolErrorConnection.callTool(
            tool.name,
            { topic: "errors" },
            undefined,
            undefined,
            undefined,
            tool,
        );
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [{ type: "text", text: "tool-level failure" }]);
    } finally {
        await toolErrorConnection.close();
    }

    const protocolFixture = taskHandler("protocol-failure");
    const protocolServer = await serveMcpHttp(t, protocolFixture.handler, protocolFixture.route);
    const protocolConnection = new ServerConnection({
        name: "task-protocol-error",
        transport: "http",
        url: protocolServer.url,
    }, env);
    try {
        const tool = (await protocolConnection.catalog()).tools.find(
            ({ name }) => name === protocolFixture.toolName,
        )!;
        await assert.rejects(
            () => protocolConnection.callTool(
                tool.name,
                { topic: "errors" },
                undefined,
                undefined,
                undefined,
                tool,
            ),
            (error: unknown) => error instanceof Error
                && "code" in error
                && error.code === -32603
                && /task execution exploded/.test(error.message),
        );
        assert.equal(protocolFixture.cancellations.length, 0);
    } finally {
        await protocolConnection.close();
    }
});

test("unsupported Task input fails before interaction and cancels the owned Task", async (t) => {
    const fixture = taskHandler("unsupported");
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const connection = new ServerConnection({
        name: "task-unsupported-input",
        transport: "http",
        url: served.url,
    }, env);
    let interactions = 0;
    try {
        const tool = (await connection.catalog()).tools.find(({ name }) => name === fixture.toolName)!;
        await assert.rejects(
            () => connection.callTool(
                tool.name,
                { topic: "unsupported" },
                undefined,
                undefined,
                async () => {
                    interactions += 1;
                    return { status: "cancelled" };
                },
                tool,
            ),
            /unsupported embedded input method 'sampling\/createMessage'/i,
        );
        assert.equal(interactions, 0);
        assert.equal(fixture.updates.length, 0);
        assert.equal(fixture.cancellations.length, 1);
        assert.equal(fixture.cancellations[0]?.taskId, taskId);
    } finally {
        await connection.close();
    }
});

test("cancelling an owning operation awaits tasks/cancel before it settles", async (t) => {
    const fixture = taskHandler("cancel");
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const connection = new ServerConnection({
        name: "task-cancellation",
        transport: "http",
        url: served.url,
    }, env);
    const controller = new AbortController();
    try {
        const tool = (await connection.catalog()).tools.find(({ name }) => name === fixture.toolName)!;
        const running = connection.callTool(
            tool.name,
            { topic: "cancel" },
            controller.signal,
            undefined,
            undefined,
            tool,
        );
        await waitFor(() => served.requests.some((request) => {
            const message = wireRequest(request);
            const notifications = message.params?.notifications as { taskIds?: string[] } | undefined;
            return message.method === "subscriptions/listen"
                && notifications?.taskIds?.includes(taskId) === true;
        }));
        controller.abort(new Error("operator cancelled Task"));
        await assert.rejects(running, /operator cancelled Task/);
        assert.equal(fixture.cancellations.length, 1);
        assert.equal(fixture.cancellations[0]?.taskId, taskId);
        const methods = served.requests.map((request) => wireRequest(request).method);
        assert.ok(methods.indexOf("tasks/cancel") < methods.lastIndexOf("notifications/cancelled"));
    } finally {
        await connection.close();
    }
});

test("{§tasks-lifetime} closing the owning connection abandons an in-process task instead of resuming it", async () => {
    const paused = new ServerConnection({
        name: "tasks-stdio",
        transport: "stdio",
        command: process.execPath,
        args: [stdioFixture],
        env: { PLURNK_TASK_PAUSE: "1" },
    }, env);
    const catalog = await paused.catalog();
    const tool = catalog.tools.find(({ name }) => name === "stdio-defer")!;
    const abandoned = paused.callTool(
        tool.name,
        { topic: "abandon" },
        undefined,
        undefined,
        undefined,
        tool,
    );
    const abandonment = abandoned.catch(() => undefined);
    await delay(100);
    await paused.close();
    await abandonment;
    await assert.rejects(() => abandoned, /connection|closed|failed/u);

    const fresh = new ServerConnection({
        name: "tasks-stdio",
        transport: "stdio",
        command: process.execPath,
        args: [stdioFixture],
    }, env);
    try {
        const replayed = await fresh.callTool(
            tool.name,
            { topic: "re-run" },
            undefined,
            undefined,
            undefined,
            tool,
        );
        assert.deepEqual(replayed.content, [{
            type: "text",
            text: "plain stdio Task completed",
        }]);
    } finally {
        await fresh.close();
    }
});

test("the same current Task lifecycle composes over a plain stdio endpoint", async () => {
    const connection = new ServerConnection({
        name: "tasks-stdio",
        transport: "stdio",
        command: process.execPath,
        args: [stdioFixture],
    }, env);
    try {
        const catalog = await connection.catalog();
        assert.equal(catalog.server?.name, "plain-task-stdio");
        const tool = catalog.tools.find(({ name }) => name === "stdio-defer")!;
        const result = await connection.callTool(
            tool.name,
            { topic: "transport diversity" },
            undefined,
            undefined,
            undefined,
            tool,
        );
        assert.deepEqual(result.content, [{
            type: "text",
            text: "plain stdio Task completed",
        }]);
    } finally {
        await connection.close();
    }
});
