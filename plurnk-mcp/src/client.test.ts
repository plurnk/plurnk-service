import { workingDirectory } from "../test/working-directory.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ServerConnection from "./client.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

test("client pins the current MCP revision and exercises tools and resources", async () => {
    const connection = new ServerConnection({
        name: "echo",
        transport: "stdio",
        cwd: workingDirectory,
        command: process.execPath,
        args: [fixture],
    }, env);
    try {
        const client = await connection.connect();
        assert.equal(client.getProtocolEra(), "modern");
        assert.equal(client.getNegotiatedProtocolVersion(), MCP_PROTOCOL_VERSION);
        assert.ok(client.getDiscoverResult()?.supportedVersions.includes(MCP_PROTOCOL_VERSION));

        const catalog = await connection.catalog();
        assert.deepEqual(
            catalog.tools.map((tool) => tool.name).toSorted(),
            ["echo", "fail"],
        );
        assert.deepEqual(
            catalog.resources.map((resource) => resource.uri),
            ["fixture://document"],
        );
        assert.deepEqual(catalog.prompts.map((prompt) => prompt.name), ["summarize"]);
        assert.equal(catalog.tools.find((tool) => tool.name === "echo")?.annotations?.readOnlyHint, true);
        assert.equal(catalog.tools.find((tool) => tool.name === "fail")?.annotations?.readOnlyHint, undefined);

        const result = await connection.callTool("echo", {
            message: "hello",
        });
        assert.deepEqual(result.content, [{
            type: "text",
            text: "hello",
        }]);

        const resource = await connection.readResource("fixture://document");
        assert.equal(resource.contents[0]?.uri, "fixture://document");
        assert.equal("text" in resource.contents[0]!, true);

        const prompt = await connection.getPrompt("summarize", { topic: "MCP" });
        assert.deepEqual(prompt.messages, [{
            role: "user",
            content: { type: "text", text: "Summarize MCP." },
        }]);

        const completion = await connection.complete({
            ref: { type: "ref/prompt", name: "summarize" },
            argument: { name: "topic", value: "p" },
        });
        assert.deepEqual(completion.completion.values, ["Plurnk", "protocol"]);
    } finally {
        await connection.close();
    }
});

test("active request accounting retires a cancelled request", async () => {
    const connection = new ServerConnection({
        name: "echo",
        transport: "stdio",
        cwd: workingDirectory,
        command: process.execPath,
        args: [fixture],
        env: { PLURNK_MCP_TEST_EXTENDED: "1" },
    }, env);
    const controller = new AbortController();
    try {
        await connection.catalog();
        const pending = connection.callTool("wait", {}, controller.signal);
        assert.equal(connection.activeRequests, 1);
        controller.abort(new Error("test request settled"));
        await assert.rejects(pending, /test request settled/);
        assert.equal(connection.activeRequests, 0);
    } finally {
        await connection.close();
    }
});

test("{§mcp-working-storage} stdio cannot inherit the host CWD by omission", async () => {
    const connection = new ServerConnection({ name: "echo", transport: "stdio", command: process.execPath, args: [fixture] }, env);
    try {
        await assert.rejects(connection.connect(), /requires an absolute working directory/);
    } finally {
        await connection.close();
    }
});

test("{§mcp-working-storage} concurrent callers share directory preparation and one connection", async () => {
    let preparations = 0;
    const ready = Promise.withResolvers<string>();
    const connection = new ServerConnection({ name: "echo", transport: "stdio", command: process.execPath, args: [fixture] }, env, {
        workingDirectory: () => { preparations++; return ready.promise; },
    });
    try {
        const calls = [connection.connect(), connection.connect()];
        assert.equal(preparations, 1);
        ready.resolve(workingDirectory);
        const [first, second] = await Promise.all(calls);
        assert.equal(first, second);
    } finally {
        await connection.close();
    }
});

test("{§mcp-working-storage} closing during directory preparation prevents launch", async () => {
    const ready = Promise.withResolvers<string>();
    const connection = new ServerConnection({ name: "echo", transport: "stdio", command: process.execPath, args: [fixture] }, env, {
        workingDirectory: () => ready.promise,
    });
    const connecting = connection.connect();
    const rejected = assert.rejects(connecting, /connection is closed/);
    const closing = connection.close();
    ready.resolve(workingDirectory);
    await Promise.all([closing, rejected]);
});

test("{§mcp-working-storage} explicit CWD bypasses host directory allocation", async () => {
    const connection = new ServerConnection({ name: "echo", transport: "stdio", command: process.execPath, args: [fixture], cwd: workingDirectory }, env, {
        workingDirectory: async () => { throw new Error("explicit CWD must not allocate managed state"); },
    });
    try {
        assert.equal((await connection.catalog()).server?.name, "current-echo");
    } finally {
        await connection.close();
    }
});
