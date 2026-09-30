import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ServerConnection from "./client.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";
import { FIXTURES, fixturePlugin, stdioServer } from "../test/definitions.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

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

test("{§mcp-plugin-servers} a stdio server starts in its plugin root with PLUGIN_ROOT and PLUGIN_DATA, and PLUGIN_DATA exists first", async () => {
    const data = join(tmpdir(), `plurnk-mcp-plugin-data-${randomUUID()}`);
    const definition = { ...stdioServer("where", [fixture], { env: { PLURNK_MCP_TEST_WHERE: "1" } }), plugin: { ...fixturePlugin, data } };
    const connection = new ServerConnection(definition, env);
    try {
        const result = await connection.callTool("where", {}) as { content: Array<{ text: string }> };
        const reported = JSON.parse(result.content[0]!.text) as { cwd: string; root: string; data: string };
        assert.equal(reported.cwd, await realpath(FIXTURES), "the working directory defaults to the plugin root");
        assert.equal(reported.root, FIXTURES);
        assert.equal(reported.data, data);
        assert.ok((await stat(data)).isDirectory(), "PLUGIN_DATA was created before the launch");
    } finally {
        await connection.close();
        await rm(data, { recursive: true, force: true });
    }
});

test("{§mcp-plugin-servers} a working directory that resolves out of its plugin fails before launch", async () => {
    const connection = new ServerConnection(stdioServer("escape", [fixture], { cwd: "${PLUGIN_ROOT}/.." }), env);
    try {
        await assert.rejects(connection.connect(), /resolves outside the plugin's root/u);
    } finally {
        await connection.close();
    }
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
