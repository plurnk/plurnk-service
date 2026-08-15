import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExecArgs } from "@plurnk/plurnk-execs";
import McpExecutor, { runtimeDecl } from "./McpExecutor.ts";
import ServerConnection from "./client.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

const configured = (): {
    connection: ServerConnection;
    executor: McpExecutor;
} => {
    const env = {
        PLURNK_MCP_CONNECT_TIMEOUT: "30000",
        PLURNK_MCP_REQUEST_TIMEOUT: "30000",
    };
    const connection = new ServerConnection({
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
} => {
    const writes: string[] = [];
    const states: string[] = [];
    return {
        writes,
        states,
        args: {
            runtime: "echo",
            body: "",
            cwd: null,
            target: null,
            signal: new AbortController().signal,
            write: (_channel, chunk) => writes.push(chunk),
            setState: (_channel, state) => states.push(state),
            emit: () => undefined,
            ...overrides,
        },
    };
};

test("runtime declaration provides the structural family fallback only", async () => {
    const declaration = runtimeDecl("echo");
    assert.deepEqual(declaration.invocation, {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    });
    assert.equal(declaration.documentation, "");
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
            target: { role: "Echo one message.", required: true, kind: "literal" },
            signature: '{"message": string}',
        });
        assert.match(registry.documentation, /^## echo$/m);
        assert.doesNotMatch(registry.documentation, /^## fail$/m);
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
