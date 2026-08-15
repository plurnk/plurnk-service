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
        featured: ["echo"],
        read: [],
    }, env);
    return {
        connection,
        executor: new McpExecutor(
            { runtime: "echo", glyph: "🔌" },
            connection,
            { featured: ["echo"], read: [] },
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

test("runtime declaration has one catalog face and one tool-call shape", () => {
    const declaration = runtimeDecl("echo");
    assert.deepEqual(declaration.invocation, {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name", body: '{"argument":"value"}' },
    });
    assert.ok(declaration.documentation?.includes("## FIND0 (echo://*/)"));
    assert.ok(declaration.documentation?.includes("## READ0 (echo://tool_name/)"));
    assert.equal(declaration.documentation?.includes("## EXEC0 [echo]\n?"), false);
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

test("MCP executor features exact tool targets and never trusts remote readOnlyHint for admission", async () => {
    const { connection, executor } = configured();
    try {
        await executor.requireAvailable();
        assert.equal(executor.effect("echo"), "host", "unlisted remote hints cannot bypass proposal policy");
        assert.deepEqual(executor.invocationVariants().map((variant) => variant.example.target), ["echo"]);
        assert.equal(executor.invocationVariants()[0]?.target.role, "MCP tool contract echo://echo/");
    } finally {
        await connection.close();
    }
});

test("only the host-owned read list changes an MCP tool's effect", async () => {
    const { connection } = configured();
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        { featured: false, read: ["echo"] },
    );
    try {
        await executor.requireAvailable();
        assert.equal(executor.effect("echo"), "read");
        assert.equal(executor.effect("fail"), "host");
        assert.equal(executor.effect(null), "host");
    } finally {
        await connection.close();
    }
});

test("configured tool policy fails setup when the server lacks an exact name", async () => {
    const { connection } = configured();
    const executor = new McpExecutor(
        { runtime: "echo", glyph: "🔌" },
        connection,
        { featured: ["missing"], read: [] },
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

test("MCP executor calls a current tool and writes its result", async () => {
    const { connection, executor } = configured();
    try {
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
