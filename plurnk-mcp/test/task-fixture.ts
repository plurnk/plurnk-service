import assert from "node:assert/strict";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import type { ReceivedRequest } from "./http-fixture.ts";
import { MCP_TASKS_EXTENSION_ID } from "../src/protocol.ts";

export const taskId = " task-α";
const createdAt = "2026-08-16T04:00:00Z";
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

export const wireRequest = (request: ReceivedRequest): WireRequest => request.body as WireRequest;

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

export const taskHandler = (mode: TaskFixtureMode = "interaction") => {
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
