import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
    SUBSCRIPTION_ID_META_KEY,
    type Tool,
} from "@modelcontextprotocol/client";
import {
    McpServer,
    createMcpHandler,
    fromJsonSchema,
} from "@modelcontextprotocol/server";
import { serveMcpHttp, type ReceivedRequest } from "../test/http-fixture.ts";
import ServerConnection from "./client.ts";
import { mcpRoutingHeaderValue } from "./protocolHeaders.ts";
import {
    MCP_TASKS_EXTENSION_ID,
} from "./protocol.ts";

const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "3000",
};

const taskId = " task-α";
const createdAt = "2026-08-16T04:00:00Z";
const stdioFixture = fileURLToPath(new URL("./fixtures/task-server.mjs", import.meta.url));
const taskToolInputSchema = {
    type: "object" as const,
    properties: {
        topic: {
            type: "string" as const,
            "x-mcp-header": "Topic",
        },
    },
    required: ["topic"],
    additionalProperties: false,
};

interface WireRequest {
    readonly jsonrpc?: string;
    readonly id?: string | number;
    readonly method?: string;
    readonly params?: Record<string, unknown>;
}

interface TaskStream {
    readonly id: string | number;
    readonly taskIds: ReadonlySet<string>;
    readonly controller: ReadableStreamDefaultController<Uint8Array>;
    closed: boolean;
}

const wireRequest = (request: ReceivedRequest): WireRequest => request.body as WireRequest;

const response = (id: string | number | undefined, result: unknown): Response => Response.json({
    jsonrpc: "2.0",
    id,
    result,
});

const taskState = (
    status: "working" | "input_required" | "completed" | "failed" | "cancelled",
    extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
    taskId,
    status,
    createdAt,
    lastUpdatedAt: createdAt,
    ttlMs: 60_000,
    pollIntervalMs: 10,
    ...extra,
});

const sseMessage = (value: unknown): Uint8Array => new TextEncoder().encode(
    `event: message\ndata: ${JSON.stringify(value)}\n\n`,
);

type TaskFixtureMode = "interaction" | "tool-error" | "protocol-failure" | "unsupported" | "cancel";

const taskHandler = (mode: TaskFixtureMode = "interaction") => {
    const toolName = mode === "interaction" ? "deferred-review" : mode;
    const handler = createMcpHandler(() => {
        const server = new McpServer(
            { name: "diverse-task-http", version: "1.0.0" },
            { capabilities: { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } } },
        );
        server.registerTool(
            toolName,
            {
                description: "Review a topic asynchronously.",
                inputSchema: fromJsonSchema(taskToolInputSchema),
            },
            async () => ({ content: [{ type: "text", text: "route interception failed" }] }),
        );
        return server;
    }, {
        legacy: "reject",
        responseMode: "auto",
        keepAliveMs: 0,
    });
    const streams = new Set<TaskStream>();
    const updates: Array<Record<string, unknown>> = [];
    const cancellations: Array<Record<string, unknown>> = [];
    let awaitingPostUpdatePoll = false;
    const closeStream = (stream: TaskStream): void => {
        if (stream.closed) return;
        stream.closed = true;
        streams.delete(stream);
        try {
            stream.controller.close();
        } catch {
            // The request stream may already have been aborted by the client.
        }
    };
    const notify = (state: Record<string, unknown>): void => {
        for (const stream of streams) {
            if (!stream.taskIds.has(taskId) || stream.closed) continue;
            stream.controller.enqueue(sseMessage({
                jsonrpc: "2.0",
                method: "notifications/tasks",
                params: {
                    ...state,
                    _meta: { [SUBSCRIPTION_ID_META_KEY]: stream.id },
                },
            }));
        }
    };
    const route = async (request: Request): Promise<Response | null> => {
        const message = await request.clone().json() as WireRequest;
        const params = message.params ?? {};
        if (message.method === "tools/call") {
            assert.equal(request.headers.get("mcp-param-topic"), params.arguments
                && (params.arguments as Record<string, unknown>).topic);
            const capabilities = (params._meta as {
                "io.modelcontextprotocol/clientCapabilities"?: {
                    extensions?: Record<string, unknown>;
                };
            } | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
            assert.ok(capabilities?.extensions?.[MCP_TASKS_EXTENSION_ID]);
            if (mode === "interaction" && params.requestState === undefined) {
                return response(message.id, {
                    resultType: "input_required",
                    requestState: "pre-task-state",
                    inputRequests: {
                        preflight: {
                            method: "elicitation/create",
                            params: {
                                mode: "form",
                                message: "Start the asynchronous review?",
                                requestedSchema: {
                                    type: "object",
                                    properties: { proceed: { type: "boolean" } },
                                    required: ["proceed"],
                                    additionalProperties: false,
                                },
                            },
                        },
                    },
                });
            }
            if (mode === "interaction") {
                assert.equal(params.requestState, "pre-task-state");
                assert.deepEqual(params.inputResponses, {
                    preflight: { action: "accept", content: { proceed: true } },
                });
            }
            return response(message.id, {
                resultType: "task",
                ...taskState("working", mode === "cancel" ? { pollIntervalMs: 1_000 } : {}),
            });
        }
        if (message.method === "subscriptions/listen") {
            const filter = params.notifications as { taskIds?: string[] } | undefined;
            if (filter?.taskIds === undefined) return null;
            let stream!: TaskStream;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    stream = {
                        id: message.id!,
                        taskIds: new Set(filter.taskIds),
                        controller,
                        closed: false,
                    };
                    streams.add(stream);
                    controller.enqueue(sseMessage({
                        jsonrpc: "2.0",
                        method: "notifications/subscriptions/acknowledged",
                        params: {
                            notifications: filter,
                            _meta: { [SUBSCRIPTION_ID_META_KEY]: message.id },
                        },
                    }));
                    request.signal.addEventListener("abort", () => closeStream(stream), { once: true });
                },
                cancel() {
                    closeStream(stream);
                },
            });
            return new Response(body, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        }
        if (message.method === "notifications/cancelled") {
            const requestId = params.requestId;
            const stream = [...streams].find((candidate) => candidate.id === requestId);
            if (stream === undefined) return null;
            closeStream(stream);
            return new Response(null, { status: 202 });
        }
        if (message.method === "tasks/get") {
            assert.equal(params.taskId, taskId);
            if (mode === "tool-error") {
                return response(message.id, {
                    resultType: "complete",
                    ...taskState("completed", {
                        result: {
                            content: [{ type: "text", text: "tool-level failure" }],
                            isError: true,
                        },
                    }),
                });
            }
            if (mode === "protocol-failure") {
                return response(message.id, {
                    resultType: "complete",
                    ...taskState("failed", {
                        error: { code: -32603, message: "task execution exploded" },
                    }),
                });
            }
            if (mode === "unsupported") {
                return response(message.id, {
                    resultType: "complete",
                    ...taskState("input_required", {
                        inputRequests: {
                            sample: {
                                method: "sampling/createMessage",
                                params: {
                                    messages: [{
                                        role: "user",
                                        content: { type: "text", text: "Summarize." },
                                    }],
                                    maxTokens: 32,
                                },
                            },
                        },
                    }),
                });
            }
            if (mode === "cancel") {
                return response(message.id, {
                    resultType: "complete",
                    ...taskState("working", { pollIntervalMs: 1_000 }),
                });
            }
            if (awaitingPostUpdatePoll) {
                awaitingPostUpdatePoll = false;
                setTimeout(() => notify(taskState("completed", {
                    result: {
                        content: [{ type: "text", text: "Ada reviewed MCP" }],
                        isError: false,
                    },
                })), 0);
            }
            return response(message.id, {
                resultType: "complete",
                ...taskState("input_required", {
                    inputRequests: {
                        profile: {
                            method: "elicitation/create",
                            params: {
                                mode: "form",
                                message: "Name this review.",
                                requestedSchema: {
                                    type: "object",
                                    properties: { name: { type: "string" } },
                                    required: ["name"],
                                    additionalProperties: false,
                                },
                            },
                        },
                        authorize: {
                            method: "elicitation/create",
                            params: {
                                mode: "url",
                                message: "Authorize the review source.",
                                elicitationId: "review-source",
                                url: "https://example.test/authorize",
                            },
                        },
                    },
                }),
            });
        }
        if (message.method === "tasks/update") {
            updates.push(params);
            awaitingPostUpdatePoll = true;
            return response(message.id, { resultType: "complete" });
        }
        if (message.method === "tasks/cancel") {
            cancellations.push(params);
            return response(message.id, { resultType: "complete" });
        }
        return null;
    };
    return { handler, route, updates, cancellations, toolName };
};

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
        assert.deepEqual(taskRequests.map((request) => wireRequest(request).method), [
            "tasks/get",
            "tasks/update",
            "tasks/get",
        ]);
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
