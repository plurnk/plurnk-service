import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ServerConnection from "./client.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";
import { FIXTURES, stdioServer } from "../test/definitions.ts";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "../test/http-fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

test("{§mcp-plugin-configuration} a plugin process receives reserved variables and literal inputs with no native interpolation", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-mcp-launch-${PLUGIN_DATA}-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const context = { root: join(directory, "plugin"), data: join(directory, "data") };
    await mkdir(context.root);
    const executable = join(context.root, "run");
    await writeFile(executable, `#!${process.execPath}\nimport ${JSON.stringify(new URL("./fixtures/echo-server.mjs", import.meta.url).href)};\n`);
    await chmod(executable, 0o755);
    const definition = {
        name: "plugin", type: "stdio" as const, command: "./run", cwd: "${PLUGIN_DATA}",
        args: ["${PLUGIN_ROOT}", "${PLUGIN_DATA}", "${SAMPLE}"],
        env: { PLURNK_MCP_TEST_LAUNCH: "1", SAMPLE: "${PLUGIN_ROOT}", LITERAL: "${SAMPLE}" },
    };
    const connection = new ServerConnection(definition, { ...env, SAMPLE: "must-not-expand" }, {
        plugin: context, cwd: "/unused-native-cwd", environment: { ...process.env, PLUGIN_ROOT: "wrong", PLUGIN_DATA: "wrong" },
    });
    try {
        const result = await connection.callTool("launch", {}) as { content: Array<{ text: string }> };
        const values = JSON.parse(result.content[0]!.text);
        assert.deepEqual(values, {
            cwd: context.data, argv: [context.root, context.data, "${SAMPLE}"], pid: values.pid,
            root: context.root, data: context.data, sample: context.root, literal: "${SAMPLE}",
        });
        assert.ok(Number.isSafeInteger(values.pid));
        assert.deepEqual(connection.definition, definition);
    } finally { await connection.close(); }
});

test("{§mcp-plugin-configuration} remote plugin headers stay literal and protocol headers remain client-owned", async (t) => {
    const handler = createMcpHandler(() => new McpServer({ name: "literal", version: "1.0.0" }));
    const { url, requests } = await serveMcpHttp(t, handler);
    const connection = new ServerConnection({ name: "literal", type: "streamable-http", url, headers: {
        "x-literal": "${SECRET}/${PLUGIN_ROOT}", "MCP-Protocol-Version": "invalid",
    } }, { ...env, SECRET: "must-not-expand" }, { plugin: { root: "/plugin", data: "/data" } });
    try {
        await connection.connect();
        assert.ok(requests.length > 0);
        assert.ok(requests.every(({ headers }) => headers.get("x-literal") === "${SECRET}/${PLUGIN_ROOT}"));
        assert.ok(requests.every(({ headers }) => headers.get("mcp-protocol-version") !== "invalid"));
    } finally { await connection.close(); }
});

test("client pins the current MCP revision and exercises tools and resources", async () => {
    const connection = new ServerConnection(stdioServer("echo", [fixture]), env);
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
    const connection = new ServerConnection(stdioServer("echo", [fixture], { env: { PLURNK_MCP_TEST_EXTENDED: "1" } }), env);
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

test("{§mcp-launch-directory} an unconfigured cwd is supplied by the host, never materialized into the definition", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-mcp-cwd-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { cwd: _cwd, ...definition } = stdioServer("where", [fixture], { env: { PLURNK_MCP_TEST_WHERE: "1" } });
    const connection = new ServerConnection({ ...definition, command: process.execPath }, env, { cwd: directory });
    try {
        const result = await connection.callTool("where", {}) as { content: Array<{ text: string }> };
        assert.deepEqual(JSON.parse(result.content[0]!.text), { cwd: await realpath(directory) });
        assert.deepEqual(connection.definition, { ...definition, command: process.execPath });
        assert.throws(() => new ServerConnection(definition, env), /requires an absolute working directory from its definition or host/u);
    } finally { await connection.close(); }
});

test("{§mcp-launch-directory} an explicit absolute cwd and executable are not confined to a plugin root", async () => {
    const definition = { ...stdioServer("where", ["${SCRIPT}"], { cwd: "${SERVER_DIR}", env: { PLURNK_MCP_TEST_WHERE: "1" } }), command: process.execPath };
    const connection = new ServerConnection(definition, { ...env, SCRIPT: fixture, SERVER_DIR: FIXTURES }, { cwd: "/unused-host-directory" });
    try {
        const result = await connection.callTool("where", {}) as { content: Array<{ text: string }> };
        assert.deepEqual(JSON.parse(result.content[0]!.text), { cwd: await realpath(FIXTURES) });
        assert.deepEqual(connection.definition, definition, "resolved references remain outside durable configuration");
    } finally { await connection.close(); }
    assert.throws(() => new ServerConnection(stdioServer("relative", [fixture], { cwd: "./relative" }), env), /requires an absolute working directory/u);
});

test("concurrent callers share one launch and one connection", async () => {
    const connection = new ServerConnection(stdioServer("echo", [fixture]), env);
    try {
        const [first, second] = await Promise.all([connection.connect(), connection.connect()]);
        assert.equal(first, second);
    } finally {
        await connection.close();
    }
});
