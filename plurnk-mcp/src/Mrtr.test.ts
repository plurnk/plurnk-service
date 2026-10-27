import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SdkError, SdkErrorCode, type InputRequiredResult, type Tool } from "@modelcontextprotocol/client";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";
import ServerConnection, { type ClientInteractionHandler } from "./client.ts";
import { runInputRequiredRequest } from "./inputRequired.ts";
import { mcpRoutingHeaderValue } from "./protocolHeaders.ts";
import { serveMcpHttp } from "../test/http-fixture.ts";
import { taskHandler, taskId, wireRequest } from "../test/task-fixture.ts";
import { httpServer, stdioServer } from "../test/definitions.ts";

const interactionServerFixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

const configured = (): ServerConnection => new ServerConnection(stdioServer("interaction", [interactionServerFixture]), env);

test("{§mcp-host-composition} embedded elicitations map directly to form and URL client interactions", async () => {
    const connection = configured();
    const requests: ClientInteractionRequest[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        requests.push(request);
        if (request.message === "Who is making this request?") {
            return { action: "accept", content: { name: "Ada" } };
        }
        return { action: "decline" };
    };
    try {
        const result = await connection.callTool("batch", {}, undefined, undefined, interact);
        assert.equal(requests.length, 2);
        assert.ok(requests.every((r) => r.toolName === "mcp_input_required" && r.mode === "form"));
        assert.deepEqual(
            requests.map((r) => r.message).toSorted(),
            ["Continue the batch operation?", "Who is making this request?"],
        );
        assert.equal(JSON.stringify(requests).includes("round-one"), false);
        assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Ada/);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} multi-round tool calls preserve opaque state and fresh interaction responses", async () => {
    const connection = configured();
    const requests: ClientInteractionRequest[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        requests.push(request);
        return requests.length === 1
            ? { action: "accept", content: { name: "Ada" } }
            : { action: "accept", content: { confirm: true } };
    };
    try {
        const result = await connection.callTool("round-trip", {}, undefined, undefined, interact);
        assert.deepEqual(requests.map((r) => r.message), ["Name the operator.", "Confirm Ada as the operator?"]);
        assert.ok(requests.every((request) => !JSON.stringify(request).includes("opaque")));
        assert.deepEqual(result.content, [{ type: "text", text: "Ada confirmed" }]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} client cancellation becomes a standard elicitation cancellation response", async () => {
    const connection = configured();
    try {
        const result = await connection.callTool(
            "batch",
            {},
            undefined,
            undefined,
            async () => ({ action: "cancel" }),
        );
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        assert.match(text, /"action":"cancel"/);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} form and URL responses are validated before retrying the origin", async () => {
    const connection = configured();
    try {
        await assert.rejects(
            () => connection.callTool(
                "batch",
                {},
                undefined,
                undefined,
                async (request) => request.message === "Who is making this request?"
                    ? { action: "accept", content: { name: 42 } }
                    : { action: "accept", content: { confirm: true } },
            ),
            /client interaction response.*profile/i,
        );
        const result = await connection.callTool(
            "url",
            {},
            undefined,
            undefined,
            async (request) => {
                assert.equal(request.mode, "url");
                if (request.mode === "url") {
                    assert.equal(request.message, "Authorize the fixture in a browser.");
                    assert.equal(request.elicitationId, "fixture-authorization");
                    assert.equal(request.url, "https://example.test/authorize");
                }
                return { action: "accept" };
            },
        );
        assert.deepEqual(result.content, [{ type: "text", text: "accept" }]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-authority} resource reads and prompt retrievals share the same interaction contract", async () => {
    const connection = configured();
    const messages: string[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        messages.push(request.message);
        return { action: "accept", content: { confirm: true } };
    };
    try {
        const resource = await connection.readResource("fixture://guarded", undefined, interact);
        assert.equal(resource.contents[0] && "text" in resource.contents[0]
            ? resource.contents[0].text
            : "", "read:accept");
        const prompt = await connection.getPrompt("guarded", { topic: "MCP" }, undefined, interact);
        assert.equal(prompt.messages[0]?.content.type === "text"
            ? prompt.messages[0].content.text
            : "", "MCP:accept");
        assert.deepEqual(messages, ["Read the guarded resource?", "Build the MCP prompt?"]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} requestState-only continuation needs no fabricated client response", async () => {
    const connection = configured();
    let interactions = 0;
    try {
        const result = await connection.callTool(
            "state-only",
            {},
            undefined,
            undefined,
            async () => {
                interactions += 1;
                return { action: "cancel" };
            },
        );
        assert.equal(interactions, 0);
        assert.deepEqual(result.content, [{ type: "text", text: "continued" }]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} interactive continuation fails explicitly without an interaction owner", async () => {
    const connection = configured();
    try {
        await assert.rejects(
            () => connection.callTool("batch", {}),
            /requires client input.*no client interaction owner/i,
        );
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} one operation rejects a non-converging server at the standard ten-round bound", async () => {
    const connection = configured();
    let interactions = 0;
    try {
        await assert.rejects(
            () => connection.callTool(
                "loop",
                {},
                undefined,
                undefined,
                async () => {
                    interactions += 1;
                    return { action: "accept", content: { confirm: true } };
                },
            ),
            /still required input after 10 rounds/i,
        );
        assert.equal(interactions, 10);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} unclaimed input families fail without opening a client interaction", async () => {
    const connection = configured();
    let interactions = 0;
    try {
        await assert.rejects(
            () => connection.callTool(
                "sampling",
                {},
                undefined,
                undefined,
                async () => {
                    interactions += 1;
                    return { action: "cancel" };
                },
            ),
            /sampling|capabilit/i,
        );
        assert.equal(interactions, 0);
    } finally {
        await connection.close();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Input Deadline ({§mcp-host-composition})
// ─────────────────────────────────────────────────────────────────────────────

const sampleInput: InputRequiredResult = {
    resultType: "input_required",
    requestState: "opaque",
    inputRequests: {
        profile: {
            method: "elicitation/create",
            params: {
                mode: "form", message: "Choose a name.",
                requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
        },
    },
};
const sampleAnswer: ClientInteractionResolution = {
    action: "accept",
    content: { name: "Ada" },
};

test("{§mcp-host-composition}: another MRTR round consumes the original budget and a late answer cannot retry", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const waiting = Promise.withResolvers<AbortSignal>();
    const late = Promise.withResolvers<ClientInteractionResolution>();
    const budgets: number[] = [];
    let rounds = 0;
    const operation = runInputRequiredRequest({
        server: "fixture", operation: "tools/call", originalParams: { name: "review" }, timeout: 1000,
        requestLeg: async (_params, options) => {
            budgets.push(options.maxTotalTimeout);
            return sampleInput;
        },
        interact: async (_request, signal) => {
            assert.ok(signal);
            if (++rounds === 1) {
                t.mock.timers.tick(600);
                return sampleAnswer;
            }
            waiting.resolve(signal);
            return late.promise;
        },
    });
    const failed = assert.rejects(operation, (error: unknown) => SdkError.isInstance(error)
        && error.code === SdkErrorCode.RequestTimeout && /operation timeout/u.test(error.message));
    const signal = await waiting.promise;
    t.mock.timers.tick(399);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    await failed;
    late.resolve(sampleAnswer);
    await Promise.resolve();
    assert.deepEqual(budgets, [1000, 400]);
    assert.equal(rounds, 2);
});

test("{§mcp-host-composition}: answered input clears its deadline without cancelling later work", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    let inputSignal: AbortSignal | undefined;
    let calls = 0;
    const result = await runInputRequiredRequest<{ resultType: "complete" }>({
        server: "fixture", operation: "tools/call", originalParams: { name: "review" }, timeout: 1000,
        requestLeg: async () => ++calls === 1 ? sampleInput : { resultType: "complete" },
        interact: async (_request, signal) => {
            inputSignal = signal;
            t.mock.timers.tick(900);
            return sampleAnswer;
        },
    });
    assert.equal(result.resultType, "complete");
    assert.ok(inputSignal);
    t.mock.timers.tick(1000);
    assert.equal(inputSignal.aborted, false);
    assert.equal(calls, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tasks ({§mcp-tasks}, {§mcp-tasks}, {§mcp-transports})
// ─────────────────────────────────────────────────────────────────────────────

const taskEnv = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "3000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

const taskStdioFixture = fileURLToPath(new URL("./fixtures/task-server.mjs", import.meta.url));

test("{§mcp-tasks} current HTTP Tasks preserve MRTR, task input, polling, notifications, and routing", async (t) => {
    const fixture = taskHandler();
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const connection = new ServerConnection(httpServer("tasks-http", served.url), taskEnv);
    try {
        const catalog = await connection.catalog();
        const tool = catalog.tools.find(({ name }) => name === "deferred-review") as Tool;
        assert.ok(tool);
        const interactions: Array<{ mode: string; message: string }> = [];
        const result = await connection.callTool(
            "deferred-review",
            { topic: "MCP" },
            undefined,
            undefined,
            async (request) => {
                interactions.push({ mode: request.mode, message: request.message });
                if (request.message === "Start the asynchronous review?") {
                    return { action: "accept", content: { proceed: true } };
                }
                if (request.mode === "form") {
                    return { action: "accept", content: { name: "Ada" } };
                }
                return { action: "accept" };
            },
            tool,
        );
        assert.deepEqual(result.content, [{ type: "text", text: "Ada reviewed MCP" }]);
        assert.deepEqual(interactions, [
            { mode: "form", message: "Start the asynchronous review?" },
            { mode: "form", message: "Name this review." },
            { mode: "url", message: "Authorize the review source." },
        ]);
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
    const deadline = Date.now() + 20_000;
    while (!predicate() && Date.now() < deadline) await delay(10);
    assert.ok(predicate(), "condition did not become true");
};

test("{§mcp-transports} Task completion preserves tool errors while failed Tasks preserve protocol errors", async (t) => {
    const toolErrorFixture = taskHandler("tool-error");
    const toolErrorServer = await serveMcpHttp(
        t,
        toolErrorFixture.handler,
        toolErrorFixture.route,
    );
    const toolErrorConnection = new ServerConnection(httpServer("task-tool-error", toolErrorServer.url), taskEnv);
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
    const protocolConnection = new ServerConnection(httpServer("task-protocol-error", protocolServer.url), taskEnv);
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

test("{§mcp-host-composition} unsupported Task input fails before interaction and cancels the owned Task", async (t) => {
    const fixture = taskHandler("unsupported");
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const connection = new ServerConnection(httpServer("task-unsupported-input", served.url), taskEnv);
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
                    return { action: "cancel" };
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

test("{§mcp-tasks} cancelling an owning operation awaits tasks/cancel before it settles", async (t) => {
    const fixture = taskHandler("cancel");
    const served = await serveMcpHttp(t, fixture.handler, fixture.route);
    const connection = new ServerConnection(httpServer("task-cancellation", served.url), taskEnv);
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
        const selected = served.requests.map(wireRequest).find((message) => message.method === "subscriptions/listen"
            && (message.params?.notifications as { taskIds?: string[] } | undefined)?.taskIds?.includes(taskId));
        assert.ok(selected);
        controller.abort(new Error("operator cancelled Task"));
        await assert.rejects(running, /operator cancelled Task/);
        assert.equal(fixture.cancellations.length, 1);
        assert.equal(fixture.cancellations[0]?.taskId, taskId);
        await waitFor(() => served.requests.map(wireRequest).some((message) => message.method === "notifications/cancelled"
            && message.params?.requestId === selected.id));
        const messages = served.requests.map(wireRequest);
        assert.ok(messages.findIndex(({ method }) => method === "tasks/cancel") < messages.findIndex((message) =>
            message.method === "notifications/cancelled" && message.params?.requestId === selected.id));
    } finally {
        await connection.close();
    }
});

test("{§mcp-setup} concurrent close waits for Task cancellation while input is pending", { timeout: 5_000 }, async (t) => {
    const fixture = taskHandler();
    const cancelling = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const input = Promise.withResolvers<void>();
    const served = await serveMcpHttp(t, fixture.handler, async (request) => {
        const message = await request.clone().json() as { method?: string };
        const response = await fixture.route(request);
        if (message.method === "tasks/cancel") {
            cancelling.resolve();
            await cancelled.promise;
        }
        return response;
    });
    const connection = new ServerConnection(httpServer("closing", served.url), taskEnv);
    t.after(async () => { cancelled.resolve(); await connection.close(); });
    const tool = (await connection.catalog()).tools[0];
    const running = connection.callTool(tool.name, { topic: "MCP" }, undefined, undefined, async (request) => {
        if (request.message === "Start the asynchronous review?") {
            return { action: "accept", content: { proceed: true } };
        }
        input.resolve();
        return new Promise(() => {});
    }, tool);
    const rejected = assert.rejects(running, /connection is closed/u);
    await input.promise;
    const closing = connection.close();
    assert.equal(connection.close(), closing, "every closer observes the same settlement");
    let closed = false;
    void closing.then(() => { closed = true; });
    await cancelling.promise;
    assert.equal(closed, false, "the transport remains available until protocol cleanup completes");
    assert.equal(connection.activeRequests, 1);
    cancelled.resolve();
    await closing;
    await rejected;
    assert.equal(connection.activeRequests, 0);
    assert.deepEqual(fixture.cancellations.map((cancellation) => cancellation.taskId), [taskId]);
    assert.equal(fixture.updates.length, 0);
    await assert.rejects(() => connection.callTool(tool.name, { topic: "late" }), /connection is closed/u);
});

test("{§mcp-setup} closing during Task subscription acknowledgement still cancels the Task", { timeout: 5_000 }, async (t) => {
    const fixture = taskHandler("cancel");
    const listening = Promise.withResolvers<void>();
    const served = await serveMcpHttp(t, fixture.handler, async (request) => {
        const message = await request.clone().json() as {
            method?: string; params?: { notifications?: { taskIds?: string[] } };
        };
        if (message.method === "subscriptions/listen" && message.params?.notifications?.taskIds?.includes(taskId)) {
            const body = new ReadableStream<Uint8Array>({ start(controller) {
                request.signal.addEventListener("abort", () => controller.close(), { once: true });
                listening.resolve();
            } });
            return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        }
        return fixture.route(request);
    });
    const connection = new ServerConnection(httpServer("closing-listen", served.url), {
        ...taskEnv, PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    });
    t.after(() => connection.close());
    const tool = (await connection.catalog()).tools[0];
    const rejected = assert.rejects(
        connection.callTool(tool.name, { topic: "MCP" }, undefined, undefined, undefined, tool),
        /connection is closed/u,
    );
    await listening.promise;
    await connection.close();
    await rejected;
    assert.deepEqual(fixture.cancellations.map((cancellation) => cancellation.taskId), [taskId]);
    assert.equal(connection.activeRequests, 0);
});

test("{§mcp-tasks} a stalled notification acknowledgement cannot block Task polling or owner cancellation", { timeout: 10_000 }, async (t) => {
    const fixture = taskHandler("cancel");
    const listening = Promise.withResolvers<void>();
    const served = await serveMcpHttp(t, fixture.handler, async (request) => {
        const message = await request.clone().json() as {
            method?: string; params?: { notifications?: { taskIds?: string[] } };
        };
        if (message.method === "subscriptions/listen" && message.params?.notifications?.taskIds?.includes(taskId)) {
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                request.signal.addEventListener("abort", () => controller.close(), { once: true });
                listening.resolve();
            } }), { headers: { "Content-Type": "text/event-stream" } });
        }
        return fixture.route(request);
    });
    const connection = new ServerConnection(httpServer("pending-listen", served.url), {
        ...taskEnv, PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    });
    const owner = new AbortController();
    let settled = false;
    try {
        const tool = (await connection.catalog()).tools[0];
        const rejected = assert.rejects(connection.callTool(tool.name, { topic: "MCP" }, owner.signal,
            undefined, undefined, tool), /owner stopped/u).then(() => { settled = true; });
        await listening.promise;
        await waitFor(() => served.requests.some((request) => wireRequest(request).method === "tasks/get"));
        owner.abort(new Error("owner stopped"));
        await waitFor(() => settled);
        await rejected;
        assert.deepEqual(fixture.cancellations.map((cancellation) => cancellation.taskId), [taskId]);
        assert.equal(connection.activeRequests, 0);
        assert.ok((await connection.catalog()).tools.some(({ name }) => name === tool.name),
            "cancelling a Task does not close its shared connection");
    } finally {
        owner.abort(new Error("owner stopped"));
        await connection.close();
    }
});

test("{§mcp-tasks} closing the owning connection abandons an in-process task instead of resuming it", async () => {
    const paused = new ServerConnection(stdioServer("tasks-stdio", [taskStdioFixture], { env: { PLURNK_TASK_PAUSE: "1" } }), taskEnv);
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
    await waitFor(() => paused.activeRequests > 0);
    await paused.close();
    await abandonment;
    await assert.rejects(() => abandoned, /connection|closed|failed/u);

    const fresh = new ServerConnection(stdioServer("tasks-stdio", [taskStdioFixture]), taskEnv);
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

test("{§mcp-tasks} the same current Task lifecycle composes over a plain stdio endpoint", async () => {
    const connection = new ServerConnection(stdioServer("tasks-stdio", [taskStdioFixture]), taskEnv);
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
