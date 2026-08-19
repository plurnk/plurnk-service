import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExecArgs } from "@plurnk/plurnk-execs";

import type { Notice } from "@plurnk/plurnk-contracts";
import McpExecutor, { runtimeDecl, serverSummary } from "./McpExecutor.ts";
import ServerConnection from "./client.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const interactionFixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));

const configured = (): {
    connection: ServerConnection;
    executor: McpExecutor;
} => {
    const env = {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000",
    };
    const connection = new ServerConnection({
        name: "echo",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        tools: ["echo"],
        read: [],
    }, env);
    return {
        connection,
        executor: new McpExecutor(
            { runtime: "echo", glyph: "🔌" },
            connection,
            { tools: ["echo"], read: [] },
        ),
    };
};

const harness = (
    overrides: Partial<ExecArgs> = {},
): {
    args: ExecArgs;
    writes: string[];
    states: string[];
    notices: Notice[];
} => {
    const writes: string[] = [];
    const states: string[] = [];
    const notices: Notice[] = [];
    return {
        writes,
        states,
        notices,
        args: {
            runtime: "echo",
            body: "",
            cwd: null,
            target: null,
            signal: new AbortController().signal,
            write: (_channel, chunk) => writes.push(chunk),
            setState: (_channel, state) => states.push(state),
            emit: (notice) => notices.push(notice),
            interact: async () => ({ status: "cancelled" }),
            ...overrides,
        },
    };
};

const waitForFile = async (pathname: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(pathname);
            return;
        } catch {
            await delay(10);
        }
    }
    await access(pathname);
};

test("runtime declaration derives the server summary from the chain", async () => {
    const declaration = runtimeDecl("echo", serverSummary("echo", undefined, undefined), false);
    assert.equal(declaration.summary, "MCP server echo.");
    assert.deepEqual(declaration.invocation, {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    });
    assert.equal(declaration.details, undefined);
    const { connection, executor } = configured();
    assert.equal(executor.manifest.example, "## FIND0 (echo:///resources/**)");
    await connection.close();
});

test("MCP executor requires a tool target instead of duplicating catalog discovery", async () => {
    const { connection, executor } = configured();
    try {
        const h = harness();
        const result = await executor.run(h.args);
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/executor/mcp/tool-required");
        assert.deepEqual(h.states, ["errored"]);
        assert.deepEqual(h.writes, []);
    } finally {
        await connection.close();
    }
});

test("MCP executor publishes exact enabled targets and never trusts remote readOnlyHint for effect", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        assert.equal(executor.effect("echo"), "host", "unlisted remote hints cannot bypass proposal policy");
        const registry = executor.toolRegistry();
        assert.equal(executor.toolRegistry(), registry, "every consumer receives the same immutable snapshot");
        assert.deepEqual(registry.tools.map((tool) => tool.target), ["echo"]);
        assert.deepEqual(registry.tools[0]?.invocation, {
            body: { role: "JSON arguments", required: true },
            target: { role: "MCP tool", required: true, kind: "literal" },
            signature: '{"message": string}',
        });
        assert.equal(registry.tools[0]?.summary, "Echo one message.");
    } finally {
        await connection.close();
    }
});

test("only the host-owned read list changes an MCP tool's effect", async () => {
    const { connection } = configured();
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        { tools: ["echo"], read: ["echo"] },
    );
    try {
        await executor.requireAvailable();
        assert.equal(executor.effect("echo"), "read");
        assert.throws(() => executor.effect("fail"), /unregistered target/);
        assert.throws(() => executor.effect(null), /unregistered target/);
    } finally {
        await connection.close();
    }
});

test("configured tool policy fails setup when the server lacks an exact name", async () => {
    const { connection } = configured();
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        { tools: ["missing"], read: [] },
    );
    try {
        await assert.rejects(
            () => executor.requireAvailable(),
            /Configured MCP tool 'missing' is absent from server 'echo'/,
        );
    } finally {
        await connection.close();
    }
});

test("read classification must be a subset of enabled exact tools", async () => {
    const { connection } = configured();
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        { tools: ["echo"], read: ["fail"] },
    );
    try {
        await assert.rejects(
            () => executor.requireAvailable(),
            /Read-classified MCP tool 'fail' is not enabled/,
        );
    } finally {
        await connection.close();
    }
});

test("MCP executor calls a current tool and writes its result", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        const h = harness({
            target: "echo",
            body: JSON.stringify({ message: "hello" }),
        });
        const result = await executor.run(h.args);
        assert.equal(result.status, 200);
        assert.deepEqual(h.states, ["closed"]);
        assert.equal(
            (JSON.parse(h.writes[0] ?? "{}") as { content?: Array<{ text?: string }> })
                .content?.[0]?.text,
            "hello",
        );
    } finally {
        await connection.close();
    }
});

test("MCP executor keeps elicitation on its generic client interaction sink", async () => {
    const connection = new ServerConnection({
        name: "interaction",
        transport: "stdio",
        command: process.execPath,
        args: [interactionFixture],
        tools: ["batch"],
    }, {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000",
    });
    const executor = new McpExecutor(
        { runtime: "interaction", glyph: "🔌" },
        connection,
        { tools: ["batch"], read: [] },
    );
    try {
        await executor.requireAvailable();
        const h = harness({
            runtime: "interaction",
            target: "batch",
            interact: async () => ({
                status: "resolved",
                payload: {
                    profile: { action: "accept", content: { name: "Ada" } },
                    approval: { action: "accept", content: { confirm: true } },
                },
            }),
        });
        const result = await executor.run(h.args);
        assert.equal(result.status, 200);
        assert.match(h.writes[0] ?? "", /Ada/);
        assert.deepEqual(h.states, ["closed"]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-result-content} every passive content variant is preserved losslessly as channel evidence", async () => {
    const connection = new ServerConnection({
        name: "rich",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { PLURNK_MCP_TEST_EXTENDED: "1" },
        tools: ["rich"],
    }, {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000",
    });
    const executor = new McpExecutor(
        { runtime: "rich", glyph: "🔌" },
        connection,
        { tools: ["rich"] },
    );
    try {
        await executor.requireAvailable();
        const h = harness({ runtime: "rich", target: "rich" });
        const result = await executor.run(h.args);
        assert.equal(result.status, 200);
        assert.deepEqual(
            (JSON.parse(h.writes[0] ?? "{}") as { content: unknown }).content,
            [
                    { type: "text", text: "prose" },
                    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
                    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
                    {
                        type: "resource_link",
                        uri: "fixture://document",
                        name: "Linked document",
                    },
                    {
                        type: "resource",
                        resource: {
                            uri: "fixture://embedded",
                            mimeType: "text/plain",
                            text: "embedded text",
                        },
                    },
                    {
                        type: "resource",
                        resource: {
                            uri: "fixture://binary",
                            mimeType: "application/octet-stream",
                            blob: "YmxvYg==",
                        },
                    },
                ],
        );
    } finally {
        await connection.close();
    }
});

test("MCP progress and cancellation remain on the owning EXEC lifecycle over stdio", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-exec-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "cancelled");
    const connection = new ServerConnection({
        name: "lifecycle",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
            PLURNK_MCP_TEST_EXTENDED: "1",
            PLURNK_MCP_TEST_CANCEL_MARKER: marker,
        },
        tools: ["progress", "wait"],
    }, {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000",
    });
    const executor = new McpExecutor(
        { runtime: "lifecycle", glyph: "🔌" },
        connection,
        { tools: ["progress", "wait"] },
    );
    try {
        await executor.requireAvailable();
        const progressed = harness({ runtime: "lifecycle", target: "progress" });
        assert.equal((await executor.run(progressed.args)).status, 200);
        assert.deepEqual(progressed.notices, [{
            source: "exec:lifecycle",
            kind: "mcp_progress",
            level: "info",
            message: "fixture halfway",
            tool: "progress",
            progress: 1,
            total: 2,
        }]);

        const controller = new AbortController();
        const cancelled = harness({
            runtime: "lifecycle",
            target: "wait",
            signal: controller.signal,
        });
        const running = executor.run(cancelled.args);
        await delay(50);
        controller.abort(new Error("test cancellation"));
        const result = await running;
        assert.equal(result.status, 499);
        assert.deepEqual(cancelled.states, ["errored"]);
        await waitForFile(marker);
    } finally {
        await connection.close();
    }
});

test("MCP executor backstops core admission against disabled targets", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        const h = harness({ target: "fail" });
        const result = await executor.run(h.args);
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/executor/mcp/tool-not-enabled");
        assert.deepEqual(h.states, ["errored"]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-summary-derivation} the server's display title outranks the tool-name fallback", () => {
    const catalog = {
        protocolVersion: "2026-07-28",
        server: { name: "chrome_devtools", title: "Chrome DevTools MCP server", version: "0.1.0" },
        capabilities: {},
        tools: [{ name: "click", inputSchema: { type: "object" } }],
        resources: [],
        resourceTemplates: [],
        prompts: [],
    } as unknown as Parameters<typeof serverSummary>[1];
    assert.equal(serverSummary("cdp", catalog, undefined), "Chrome DevTools MCP server");
});
