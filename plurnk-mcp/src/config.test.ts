import test from "node:test";
import assert from "node:assert/strict";
import {
    assertNoRetiredVariables,
    connectTimeoutMs,
    expandedServerNames,
    requestTimeoutMs,
    retryDelayMs,
    retryPacing,
    serverSettings,
    settingName,
} from "./config.ts";

const floor = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "86400000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

test("{§mcp-configuration} a retired server variable fails boot naming what replaced it; an empty one states nothing", () => {
    assert.doesNotThrow(() => assertNoRetiredVariables({
        ...floor,
        PLURNK_MCP_EXPANDED: '["forge"]',
        PLURNK_MCP_FORGE_TOOLS: '["issue_read"]',
        PLURNK_MCP_FORGE_BEARER: "${FORGE_TOKEN}",
        PLURNK_MCP_LOCAL_VALIDATOR_OAUTH: '{"type":"oauth","redirectUrl":"http://127.0.0.1:8765/callback"}',
        PLURNK_MCP_GITEA: "",
        PLURNK_MCP_ENABLED: "",
    }), "controls, settings and empty retired names pass");
    for (const [key, value, successor] of [
        ["PLURNK_MCP_GITEA", "npx", /MCP servers come from an installed Agent Plugin's mcp\.json/u],
        ["PLURNK_MCP_GITEA_ARGS", '["-y"]', /mcp\.json declares args/u],
        ["PLURNK_MCP_GITEA_CWD", "/srv", /mcp\.json declares cwd/u],
        ["PLURNK_MCP_GITEA_ENV", "{}", /mcp\.json declares env/u],
        ["PLURNK_MCP_GITEA_HEADERS", "{}", /mcp\.json declares headers/u],
        ["PLURNK_MCP_GITEA_READ", '["issue_read"]', /annotations\.readOnlyHint/u],
        ["PLURNK_MCP_GITEA_SUMMARY", "Forge.", /the server's own fields/u],
        ["PLURNK_MCP_GITEA_ISSUE_READ_SUMMARY", "One issue.", /the server's own fields/u],
        ["PLURNK_MCP_ENABLED", '["gitea"]', /installed plugin's servers are enabled/u],
    ] as const) {
        assert.throws(() => assertNoRetiredVariables({ ...floor, [key]: value }), (error: Error) =>
            error.message.startsWith(`${key} is retired: `) && successor.test(error.message), key);
    }
});

test("{§mcp-server-settings} a setting's variable is the alias uppercased, its hyphens as underscores", () => {
    assert.equal(settingName("forge", "_TOOLS"), "PLURNK_MCP_FORGE_TOOLS");
    assert.equal(settingName("local-validator", "_BEARER"), "PLURNK_MCP_LOCAL_VALIDATOR_BEARER");
    assert.equal(settingName("x2", "_OAUTH"), "PLURNK_MCP_X2_OAUTH");
});

test("{§mcp-server-settings} tools narrow by exact name, a bearer is one reference, OAuth is McpOAuth, and they exclude each other", () => {
    assert.deepEqual(serverSettings("forge", floor), { tools: null }, "absent settings enable every tool and no authorization");
    assert.deepEqual(serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_TOOLS: "" }), { tools: null }, "an empty allowlist states nothing");
    assert.deepEqual(serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_TOOLS: "[]" }), { tools: [] }, "[] enables none");
    assert.deepEqual(serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_TOOLS: '["issue_read","issue_search"]' }).tools, ["issue_read", "issue_search"]);
    assert.throws(() => serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_TOOLS: '["a","a"]' }), /duplicate tool name 'a'/u);
    assert.throws(() => serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_TOOLS: '"a"' }), /JSON array of strings/u);

    assert.deepEqual(serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_BEARER: "${FORGE_TOKEN}" }).authorization, { type: "bearer", token: "${FORGE_TOKEN}" },
        "the reference is kept; the token is read only while preparing a connection");
    assert.throws(() => serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_BEARER: "literal-token" }), /one \$\{NAME\} reference/u);

    const oauth = { type: "client-credentials", clientId: "worker", clientSecret: "${WORKER_SECRET}" };
    assert.deepEqual(serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_OAUTH: JSON.stringify(oauth) }).authorization, oauth);
    assert.throws(() => serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_OAUTH: '{"type":"client-credentials","clientId":"w","clientSecret":"plain"}' }), /invalid MCP OAuth settings/u);
    assert.throws(() => serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_OAUTH: "{" }), /PLURNK_MCP_FORGE_OAUTH must be McpOAuth JSON/u);
    assert.throws(() => serverSettings("forge", { ...floor, PLURNK_MCP_FORGE_BEARER: "${T}", PLURNK_MCP_FORGE_OAUTH: JSON.stringify(oauth) }), /are exclusive/u);
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
        /positive integer/,
    );
});

test("{§mcp-retry-pacing} one pacing, stated on the panel, doubles from its floor to its ceiling", () => {
    const pacing = retryPacing({ PLURNK_MCP_RETRY_FLOOR_MS: "100", PLURNK_MCP_RETRY_CEILING_MS: "450" });
    assert.deepEqual(pacing, { floorMs: 100, ceilingMs: 450 });
    assert.deepEqual([0, 1, 2, 3, 9].map((attempt) => retryDelayMs(pacing, attempt)), [100, 200, 400, 450, 450]);
    assert.throws(() => retryPacing({ PLURNK_MCP_RETRY_CEILING_MS: "450" }), /PLURNK_MCP_RETRY_FLOOR_MS must be a positive integer; got undefined/u);
    assert.throws(() => retryPacing({ PLURNK_MCP_RETRY_FLOOR_MS: "0", PLURNK_MCP_RETRY_CEILING_MS: "450" }), /PLURNK_MCP_RETRY_FLOOR_MS must be a positive integer; got "0"/u);
    assert.throws(
        () => retryPacing({ PLURNK_MCP_RETRY_FLOOR_MS: "500", PLURNK_MCP_RETRY_CEILING_MS: "450" }),
        /PLURNK_MCP_RETRY_CEILING_MS \(450\) must be at least PLURNK_MCP_RETRY_FLOOR_MS \(500\)/u,
    );
});
