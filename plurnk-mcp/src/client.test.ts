import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ServerConnection from "./client.ts";
import packageJson from "../package.json" with { type: "json" };
import {
    MCP_PROTOCOL_VERSION,
    MCP_SKILLS_EXTENSION_ID,
    MCP_TASKS_EXTENSION_ID,
    staticClientCapabilities,
} from "./protocol.ts";
import { FIXTURES, stdioServer } from "../test/definitions.ts";

const fixture = fileURLToPath(new URL("../test/fixtures/echo-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

test("{§mcp-authority} client pins the current MCP revision and exercises tools and resources", async () => {
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
        assert.equal("text" in resource.contents[0], true);

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

test("{§mcp-host-composition} active request accounting retires a cancelled request", async () => {
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

test("{§mcp-configuration} an unconfigured cwd is supplied by the host, never materialized into the definition", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-mcp-cwd-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { cwd: _cwd, ...definition } = stdioServer("where", [fixture], { env: { PLURNK_MCP_TEST_WHERE: "1" } });
    const connection = new ServerConnection({ ...definition, command: process.execPath }, env, { cwd: directory });
    try {
        const result = await connection.callTool("where", {}) as { content: Array<{ text: string }> };
        assert.deepEqual(JSON.parse(result.content[0].text), { cwd: await realpath(directory) });
        assert.deepEqual(connection.definition, { ...definition, command: process.execPath });
        assert.throws(() => new ServerConnection(definition, env), /requires an absolute working directory from its definition or host/u);
    } finally { await connection.close(); }
});

test("{§mcp-configuration} an explicit cwd must resolve to an absolute path and overrides the host default", async () => {
    const definition = { ...stdioServer("where", ["${SCRIPT}"], { cwd: "${SERVER_DIR}", env: { PLURNK_MCP_TEST_WHERE: "1" } }), command: process.execPath };
    const connection = new ServerConnection(definition, { ...env, SCRIPT: fixture, SERVER_DIR: FIXTURES }, { cwd: "/unused-host-directory" });
    try {
        const result = await connection.callTool("where", {}) as { content: Array<{ text: string }> };
        assert.deepEqual(JSON.parse(result.content[0].text), { cwd: await realpath(FIXTURES) });
        assert.deepEqual(connection.definition, definition, "resolved references remain outside durable configuration");
    } finally { await connection.close(); }
    assert.throws(() => new ServerConnection(stdioServer("relative", [fixture], { cwd: "./relative" }), env), /requires an absolute working directory/u);
});

test("{§mcp-host-composition} concurrent callers share one launch and one connection", async () => {
    const connection = new ServerConnection(stdioServer("echo", [fixture]), env);
    try {
        const [first, second] = await Promise.all([connection.connect(), connection.connect()]);
        assert.equal(first, second);
    } finally {
        await connection.close();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Authority ({§mcp-authority})
// ─────────────────────────────────────────────────────────────────────────────

test("{§mcp-authority} protocol authority pins the MCP revision, SDK version, and static client capabilities", () => {
    assert.equal(MCP_PROTOCOL_VERSION, "2026-07-28");
    assert.equal(packageJson.dependencies["@modelcontextprotocol/client"], "2.4.0");
    assert.equal(packageJson.devDependencies["@modelcontextprotocol/conformance"], "0.2.0-alpha.12");
    assert.deepEqual(staticClientCapabilities(), {
        elicitation: { form: {}, url: {} },
        sampling: {},
        extensions: {
            [MCP_TASKS_EXTENSION_ID]: {},
            [MCP_SKILLS_EXTENSION_ID]: {},
        },
    });
});
