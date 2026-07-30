import test from "node:test";
import assert from "node:assert/strict";
import {
    connectTimeoutMs,
    requestTimeoutMs,
    serverConfig,
    serverNames,
} from "./config.ts";

const floor = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "86400000",
};

test("configuration discovers case-folded server targets and exact stdio arguments", () => {
    const env = {
        ...floor,
        PLURNK_MCP_ATLAS: "node",
        PLURNK_MCP_ATLAS_ARGS: '["server.mjs","--task","smoke"]',
        PLURNK_MCP_ATLAS_CWD: "/tmp/atlas",
    };
    assert.deepEqual(serverNames(env), ["atlas"]);
    assert.deepEqual(serverConfig("ATLAS", env), {
        transport: "stdio",
        command: "node",
        args: ["server.mjs", "--task", "smoke"],
        cwd: "/tmp/atlas",
        env: undefined,
    });
});

test("configuration expands process environment references without copying secrets into config", () => {
    const env = {
        ...floor,
        TOKEN: "secret",
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
        PLURNK_MCP_GITHUB_HEADERS: '{"Authorization":"Bearer ${TOKEN}"}',
    };
    assert.deepEqual(serverConfig("github", env), {
        transport: "http",
        url: "https://example.test/mcp",
        headers: {
            Authorization: "Bearer secret",
        },
    });
});

test("configuration rejects ambiguous shell text, orphan companions, and transport-specific companions", () => {
    assert.throws(
        () => serverConfig("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "",
        }),
        /must not be empty/,
    );
    assert.throws(
        () => serverConfig("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node server.mjs",
        }),
        /one executable/,
    );
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_ATLAS_ARGS: '["server.mjs"]',
        }),
        /has no .* target/,
    );
    assert.throws(
        () => serverConfig("github", {
            ...floor,
            PLURNK_MCP_GITHUB: "https://example.test/mcp",
            PLURNK_MCP_GITHUB_ENV: "{}",
        }),
        /only a _HEADERS/,
    );
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
