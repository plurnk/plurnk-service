import test from "node:test";
import assert from "node:assert/strict";
import {
    serviceDefinitions,
    connectTimeoutMs,
    expandedServerNames,
    requestTimeoutMs,
    retryDelayMs,
    retryPacing,
    serverSettings,
} from "./config.ts";

const floor = {
    PLURNK_MCP_ENABLED: "1",
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "86400000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

test("{§mcp-configuration} whole definitions and independent controls use the shared resource dialect", () => {
    const definition = { name: "code-search", type: "stdio", command: "node", args: ["server.mjs"] };
    const env = { ...floor, PLURNK_MCP_code_search: JSON.stringify(definition), PLURNK_MCP_code_search_ENABLED: "0" };
    assert.deepEqual(serviceDefinitions(env), [{ alias: "code-search", definition, enabled: false }]);
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_MCP_code_search_ENABLED: "1" }), [{ alias: "code-search", definition, enabled: true }]);
    const replacement = { name: "code-search", type: "streamable-http", url: "https://example.com/mcp" };
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_MCP_code_search: JSON.stringify(replacement) }), [{ alias: "code-search", definition: replacement, enabled: false }]);
    assert.deepEqual(serviceDefinitions(floor), []);
});

test("{§mcp-configuration} invalid definitions and controls fail even when no server is enabled", () => {
    for (const key of ["PLURNK_MCP_FORGE", "PLURNK_MCP_Forge", "PLURNK_MCP_forge_BEARER", "PLURNK_MCP_forge_OAUTH", "PLURNK_MCP_forge_ARGS"]) {
        assert.throws(() => serviceDefinitions({ ...floor, [key]: "private-value" }), (error: Error) => error.message.startsWith(key) && !error.message.includes("private-value"));
    }
    assert.throws(() => serviceDefinitions({ ...floor, PLURNK_MCP_forge: "", PLURNK_MCP_forge_ENABLED: "0" }), /PLURNK_MCP_forge must contain a definition/u);
    assert.throws(() => serviceDefinitions({ ...floor, PLURNK_MCP_forge: '{"name":"forge","type":"stdio"}', PLURNK_MCP_forge_ENABLED: "0" }), /PLURNK_MCP_forge must be an MCP server definition/u);
    assert.throws(() => serviceDefinitions({ ...floor, PLURNK_MCP_forge: '{"name":"other","type":"stdio","command":"node"}' }), /PLURNK_MCP_forge must define name 'forge'/u);
    assert.throws(() => serviceDefinitions({}), /PLURNK_MCP_ENABLED is missing from the assembled environment floor/u);
    assert.throws(() => serviceDefinitions({ ...floor, PLURNK_MCP_future_ENABLED: "yes" }), /PLURNK_MCP_future_ENABLED must be 0 or 1/u);
});

test("{§mcp-server-settings} controls precede declarations without making resources; every value is validated", () => {
    const env = { ...floor, PLURNK_MCP_future_TOOLS: '["issue_read","issue_search"]', PLURNK_MCP_future_ENABLED: "0" };
    assert.deepEqual(serviceDefinitions(env), []);
    assert.deepEqual(serverSettings("future", env), { tools: ["issue_read", "issue_search"] });
    assert.deepEqual(serverSettings("other", env), { tools: null });
    assert.deepEqual(serverSettings("future", { ...env, PLURNK_MCP_future_TOOLS: "" }), { tools: null });
    assert.deepEqual(serverSettings("future", { ...env, PLURNK_MCP_future_TOOLS: "[]" }), { tools: [] });
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_MCP_future_TOOLS: '["a","a"]' }), /PLURNK_MCP_future_TOOLS contains duplicate tool name 'a'/u);
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_MCP_future_TOOLS: '"a"' }), /PLURNK_MCP_future_TOOLS must be a JSON array of strings/u);
    assert.throws(() => serviceDefinitions({ ...env, PLURNK_MCP_future_UNSUPPORTED: "anything" }), /PLURNK_MCP_future_UNSUPPORTED names unsupported resource setting/u);
    const definition = { name: "future", type: "stdio", command: "node" };
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_MCP_future: JSON.stringify(definition) }), [{ alias: "future", definition, enabled: false }]);
});

test("{§mcp-configuration} EXPANDED names server aliases", () => {
    assert.deepEqual(expandedServerNames(floor), []);
    assert.deepEqual(expandedServerNames({ ...floor, PLURNK_MCP_EXPANDED: '["forge","brave"]' }), ["brave", "forge"]);
    assert.throws(() => expandedServerNames({ ...floor, PLURNK_MCP_EXPANDED: '["Forge"]' }), /not an MCP server alias/u);
    assert.throws(() => expandedServerNames({ ...floor, PLURNK_MCP_EXPANDED: '["a","a"]' }), /duplicate MCP server 'a'/u);
});

test("timeouts are required positive integers owned by .env.defaults", () => {
    assert.equal(connectTimeoutMs(floor), 30000);
    assert.equal(requestTimeoutMs(floor), 86400000);
    assert.throws(
        () => connectTimeoutMs({
            ...floor,
            PLURNK_MCP_CONNECT_TIMEOUT: "0",
        }),
        /safe integer of at least 1/,
    );
});

test("{§mcp-retry-pacing} one pacing, stated on the panel, doubles from its floor to its ceiling", () => {
    const pacing = retryPacing({ PLURNK_MCP_RETRY_FLOOR_MS: "100", PLURNK_MCP_RETRY_CEILING_MS: "450" });
    assert.deepEqual(pacing, { floorMs: 100, ceilingMs: 450 });
    assert.deepEqual([0, 1, 2, 3, 9].map((attempt) => retryDelayMs(pacing, attempt)), [100, 200, 400, 450, 450]);
    assert.throws(() => retryPacing({ PLURNK_MCP_RETRY_CEILING_MS: "450" }), /PLURNK_MCP_RETRY_FLOOR_MS is missing from the assembled environment floor/u);
    assert.throws(() => retryPacing({ PLURNK_MCP_RETRY_FLOOR_MS: "0", PLURNK_MCP_RETRY_CEILING_MS: "450" }), /PLURNK_MCP_RETRY_FLOOR_MS must be a safe integer of at least 1; got "0"/u);
    assert.throws(
        () => retryPacing({ PLURNK_MCP_RETRY_FLOOR_MS: "500", PLURNK_MCP_RETRY_CEILING_MS: "450" }),
        /PLURNK_MCP_RETRY_CEILING_MS \(450\) must be at least PLURNK_MCP_RETRY_FLOOR_MS \(500\)/u,
    );
});
