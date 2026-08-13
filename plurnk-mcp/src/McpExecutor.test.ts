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
    }, env);
    return {
        connection,
        executor: new McpExecutor({ runtime: "echo", glyph: "🔌" }, connection),
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
    });
    assert.ok(declaration.documentation?.includes("## READ0 (echo:///)"));
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
