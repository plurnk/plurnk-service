import { createInterface } from "node:readline";

const protocolVersion = "2026-07-28";
const tasksExtension = "io.modelcontextprotocol/tasks";
const taskId = "stdio-task-1";
const timestamp = "2026-08-16T04:00:00Z";
const paused = process.env.PLURNK_TASK_PAUSE === "1";
let selected = false;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const error = (id, code, message) => send({
    jsonrpc: "2.0",
    id,
    error: { code, message },
});

const task = (status, extra = {}) => ({
    taskId,
    status,
    createdAt: timestamp,
    lastUpdatedAt: timestamp,
    ttlMs: null,
    pollIntervalMs: 10,
    ...extra,
});

const clientSupportsTasks = (params) => params?._meta
    ?.["io.modelcontextprotocol/clientCapabilities"]
    ?.extensions?.[tasksExtension] !== undefined;

const handle = (message) => {
    const { id, method, params = {} } = message;
    if (method === "server/discover") {
        result(id, {
            resultType: "complete",
            supportedVersions: [protocolVersion],
            capabilities: {
                tools: {},
                extensions: { [tasksExtension]: {} },
            },
            ttlMs: 0,
            cacheScope: "private",
            _meta: {
                "io.modelcontextprotocol/serverInfo": {
                    name: "plain-task-stdio",
                    version: "1.0.0",
                },
            },
        });
        return;
    }
    if (!clientSupportsTasks(params)) {
        error(id, -32003, "Missing current Tasks extension capability");
        return;
    }
    if (method === "tools/list") {
        result(id, {
            resultType: "complete",
            tools: [{
                name: "stdio-defer",
                description: "Complete through a plain stdio Task server.",
                inputSchema: {
                    type: "object",
                    properties: { topic: { type: "string" } },
                    required: ["topic"],
                    additionalProperties: false,
                },
            }],
            ttlMs: 0,
            cacheScope: "private",
        });
        return;
    }
    if (method === "tools/call") {
        result(id, { resultType: "task", ...task("working") });
        return;
    }
    if (method === "subscriptions/listen") {
        selected = params.notifications?.taskIds?.includes(taskId) === true;
        send({
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: {
                notifications: params.notifications,
                _meta: { "io.modelcontextprotocol/subscriptionId": id },
            },
        });
        return;
    }
    if (method === "tasks/get") {
        if (!selected) {
            error(id, -32603, "Task was polled before its subscription filter was active");
            return;
        }
        if (paused) {
            result(id, { resultType: "complete", ...task("working") });
            return;
        }
        result(id, {
            resultType: "complete",
            ...task("completed", {
                result: {
                    content: [{ type: "text", text: "plain stdio Task completed" }],
                    isError: false,
                },
            }),
        });
        return;
    }
    if (method === "tasks/cancel") {
        result(id, { resultType: "complete" });
        return;
    }
    if (method === "notifications/cancelled") {
        selected = false;
        return;
    }
    error(id, -32601, `Unknown current method '${method}'`);
};

const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
    try {
        handle(JSON.parse(line));
    } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
    }
});
