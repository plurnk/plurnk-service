import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ServerConnection from "./client.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
};

test("client pins the current MCP revision and exercises tools and resources", async () => {
    const connection = new ServerConnection({
        name: "echo",
        transport: "stdio",
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

test("an active user request prevents connection replacement until it settles", async () => {
    const connection = new ServerConnection({
        name: "echo",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { PLURNK_MCP_TEST_EXTENDED: "1" },
    }, env);
    const controller = new AbortController();
    try {
        await connection.catalog();
        const pending = connection.callTool("wait", {}, controller.signal);
        assert.equal(connection.activeRequests, 1);
        assert.throws(
            () => connection.assertReplaceable(),
            /has 1 active user request/,
        );
        controller.abort(new Error("test request settled"));
        await assert.rejects(pending);
        assert.equal(connection.activeRequests, 0);
        assert.doesNotThrow(() => connection.assertReplaceable());
    } finally {
        await connection.close();
    }
});
