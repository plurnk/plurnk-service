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
        PLURNK_MCP_ATLAS_FEATURED: '["filesystem_read_text_file"]',
        PLURNK_MCP_ATLAS_READ: '["filesystem_read_text_file"]',
    };
    assert.deepEqual(serverNames(env), ["atlas"]);
    assert.deepEqual(serverConfig("ATLAS", env), {
        transport: "stdio",
        command: "node",
        args: ["server.mjs", "--task", "smoke"],
        cwd: "/tmp/atlas",
        env: undefined,
        featured: ["filesystem_read_text_file"],
        read: ["filesystem_read_text_file"],
    });
});

test("HTTP bearer authentication expands its authoritative environment reference", () => {
    const env = {
        ...floor,
        TOKEN: "secret",
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
        PLURNK_MCP_GITHUB_BEARER: "${TOKEN}",
    };
    assert.deepEqual(serverConfig("github", env), {
        transport: "http",
        url: "https://example.test/mcp",
        headers: {
            Authorization: "Bearer secret",
        },
        featured: false,
        read: [],
    });
});

test("supplementary HTTP headers expand environment references and cannot conflict with bearer auth", () => {
    const env = {
        ...floor,
        TOKEN: "secret",
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
        PLURNK_MCP_GITHUB_HEADERS: '{"X-Tenant":"${TOKEN}"}',
    };
    assert.deepEqual(serverConfig("github", env), {
        transport: "http",
        url: "https://example.test/mcp",
        headers: {
            "X-Tenant": "secret",
        },
        featured: false,
        read: [],
    });
    assert.throws(
        () => serverConfig("github", {
            ...env,
            PLURNK_MCP_GITHUB_BEARER: "${TOKEN}",
            PLURNK_MCP_GITHUB_HEADERS: '{"authorization":"custom"}',
        }),
        /BEARER.*conflicts with Authorization.*_HEADERS/,
    );
});

test("bearer authentication rejects absent and empty environment references", () => {
    const env = {
        ...floor,
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
    };
    assert.throws(
        () => serverConfig("github", {
            ...env,
            PLURNK_MCP_GITHUB_BEARER: "${TOKEN}",
        }),
        /BEARER.*missing environment variable TOKEN/,
    );
    assert.throws(
        () => serverConfig("github", {
            ...env,
            TOKEN: "",
            PLURNK_MCP_GITHUB_BEARER: "${TOKEN}",
        }),
        /BEARER.*resolve to a non-empty token/,
    );
});

test("configuration rejects empty targets, orphan companions, and transport-specific companions", () => {
    assert.throws(
        () => serverConfig("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "",
        }),
        /must not be empty/,
    );
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_ATLAS_ARGS: '["server.mjs"]',
        }),
        /PLURNK_MCP_ATLAS_ARGS.*PLURNK_MCP_ATLAS/,
    );
    assert.throws(
        () => serverConfig("github", {
            ...floor,
            PLURNK_MCP_GITHUB: "https://example.test/mcp",
            PLURNK_MCP_GITHUB_ENV: "{}",
        }),
        /PLURNK_MCP_GITHUB_ENV.*PLURNK_MCP_GITHUB/,
    );
    assert.throws(
        () => serverConfig("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_HEADERS: "{}",
        }),
        /PLURNK_MCP_ATLAS_HEADERS.*PLURNK_MCP_ATLAS/,
    );
    assert.throws(
        () => serverConfig("atlas", {
            ...floor,
            TOKEN: "secret",
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_BEARER: "${TOKEN}",
        }),
        /PLURNK_MCP_ATLAS_BEARER.*PLURNK_MCP_ATLAS/,
    );
});

test("configured names use the safe executor and URI intersection", () => {
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_BAD_NAME: "node",
        }),
        /PLURNK_MCP_BAD_NAME.*bad_name.*\[a-z\]\[a-z0-9-\]\*/,
    );
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_9ATLAS: "node",
        }),
        /PLURNK_MCP_9ATLAS.*9atlas.*\[a-z\]\[a-z0-9-\]\*/,
    );
    assert.deepEqual(serverNames({
        ...floor,
        "PLURNK_MCP_ATLAS-NEXT": "node",
    }), ["atlas-next"]);
});

test("case-fold collisions and reserved global/suffix ambiguity name exact variables", () => {
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_atlas: "other-node",
        }),
        /PLURNK_MCP_ATLAS.*PLURNK_MCP_atlas.*atlas/,
    );
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_ARGS: "[]",
            PLURNK_MCP_atlas_args: "[]",
        }),
        /PLURNK_MCP_ATLAS_ARGS.*PLURNK_MCP_atlas_args/,
    );
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_CONNECT_TIMEOUT_ARGS: "[]",
        }),
        /PLURNK_MCP_CONNECT_TIMEOUT_ARGS.*PLURNK_MCP_CONNECT_TIMEOUT.*reserved global/,
    );
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_connect_timeout: "30000",
        }),
        /PLURNK_MCP_connect_timeout.*PLURNK_MCP_CONNECT_TIMEOUT.*reserved global/,
    );
});

test("stdio targets preserve whitespace as part of one exact executable", () => {
    const target = "/opt/MCP Servers/atlas";
    assert.deepEqual(serverConfig("atlas", {
        ...floor,
        PLURNK_MCP_ATLAS: target,
        PLURNK_MCP_ATLAS_ARGS: '["--stdio"]',
    }), {
        transport: "stdio",
        command: target,
        args: ["--stdio"],
        cwd: undefined,
        env: undefined,
        featured: false,
        read: [],
    });
});

test("tool policy accepts explicit feature-all and rejects ambiguous or duplicate names", () => {
    assert.deepEqual(serverConfig("atlas", {
        ...floor,
        PLURNK_MCP_ATLAS: "node",
        PLURNK_MCP_ATLAS_FEATURED: "true",
    }), {
        transport: "stdio",
        command: "node",
        args: [],
        cwd: undefined,
        env: undefined,
        featured: true,
        read: [],
    });
    assert.throws(
        () => serverConfig("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_FEATURED: '"echo"',
        }),
        /FEATURED.*boolean or JSON array of strings/,
    );
    assert.throws(
        () => serverConfig("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_READ: '["echo","echo"]',
        }),
        /READ.*duplicate tool name 'echo'/,
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
