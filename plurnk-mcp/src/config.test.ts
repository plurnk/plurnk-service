import test from "node:test";
import assert from "node:assert/strict";
import {
    overlayServerDefinitions,
    connectTimeoutMs,
    requestTimeoutMs,
    serverDefinition,
    serviceEnabledNames,
    serverNames,
    summaryOverrides,
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
        PLURNK_MCP_ATLAS_TOOLS: '["filesystem_read_text_file"]',
        PLURNK_MCP_ATLAS_READ: '["filesystem_read_text_file"]',
    };
    assert.deepEqual(serverNames(env), ["atlas"]);
    assert.deepEqual(serverDefinition("ATLAS", env), {
        name: "atlas",
        transport: "stdio",
        command: "node",
        args: ["server.mjs", "--task", "smoke"],
        cwd: "/tmp/atlas",
        tools: ["filesystem_read_text_file"],
        read: ["filesystem_read_text_file"],
    });
});

test("configured servers are available independently from the exact cold-enabled set", () => {
    const env = {
        ...floor,
        PLURNK_MCP_ATLAS: "node",
        PLURNK_MCP_GITEA: "gitea-mcp",
        PLURNK_MCP_ENABLED: '["gitea"]',
    };
    assert.deepEqual(serverNames(env), ["atlas", "gitea"]);
    assert.deepEqual(serviceEnabledNames(env), ["gitea"]);
    assert.deepEqual(serviceEnabledNames({
        ...env,
        PLURNK_MCP_ENABLED: "",
    }), []);
    assert.throws(
        () => serviceEnabledNames({
            ...env,
            PLURNK_MCP_ENABLED: '["missing"]',
        }),
        /PLURNK_MCP_ENABLED.*unknown MCP server 'missing'/,
    );
    assert.throws(
        () => serviceEnabledNames({
            ...env,
            PLURNK_MCP_ENABLED: '["gitea","gitea"]',
        }),
        /PLURNK_MCP_ENABLED.*duplicate MCP server 'gitea'/,
    );
});

test("HTTP bearer authentication preserves its authoritative environment reference", () => {
    const env = {
        ...floor,
        TOKEN: "secret",
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
        PLURNK_MCP_GITHUB_BEARER: "${TOKEN}",
    };
    assert.deepEqual(serverDefinition("github", env), {
        name: "github",
        transport: "http",
        url: "https://example.test/mcp",
        authorization: {
            type: "bearer",
            token: "${TOKEN}",
        },
        read: [],
    });
});

test("supplementary HTTP headers preserve environment references and cannot conflict with bearer auth", () => {
    const env = {
        ...floor,
        TOKEN: "secret",
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
        PLURNK_MCP_GITHUB_HEADERS: '{"X-Tenant":"${TOKEN}"}',
    };
    assert.deepEqual(serverDefinition("github", env), {
        name: "github",
        transport: "http",
        url: "https://example.test/mcp",
        headers: {
            "X-Tenant": "${TOKEN}",
        },
        read: [],
    });
    assert.throws(
        () => serverDefinition("github", {
            ...env,
            PLURNK_MCP_GITHUB_BEARER: "${TOKEN}",
            PLURNK_MCP_GITHUB_HEADERS: '{"authorization":"custom"}',
        }),
        /BEARER.*conflicts with Authorization.*_HEADERS/,
    );
});

test("bearer authentication accepts only a symbolic reference and defers resolution", () => {
    const env = {
        ...floor,
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
    };
    assert.equal(
        serverDefinition("github", {
            ...env,
            PLURNK_MCP_GITHUB_BEARER: "${TOKEN}",
        })?.authorization?.type,
        "bearer",
    );
    assert.throws(
        () => serverDefinition("github", {
            ...env,
            TOKEN: "",
            PLURNK_MCP_GITHUB_BEARER: "literal-secret",
        }),
        /invalid MCP server definition/,
    );
});

test("configuration rejects empty targets, orphan companions, and transport-specific companions", () => {
    assert.throws(
        () => serverDefinition("atlas", {
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
        () => serverDefinition("github", {
            ...floor,
            PLURNK_MCP_GITHUB: "https://example.test/mcp",
            PLURNK_MCP_GITHUB_ENV: "{}",
        }),
        /PLURNK_MCP_GITHUB_ENV.*PLURNK_MCP_GITHUB/,
    );
    assert.throws(
        () => serverDefinition("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_HEADERS: "{}",
        }),
        /PLURNK_MCP_ATLAS_HEADERS.*PLURNK_MCP_ATLAS/,
    );
    assert.throws(
        () => serverDefinition("atlas", {
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
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_enabled: "[]",
        }),
        /PLURNK_MCP_enabled.*PLURNK_MCP_ENABLED.*reserved global/,
    );
    assert.throws(
        () => serverNames({
            ...floor,
            PLURNK_MCP_ENABLED_ARGS: "[]",
        }),
        /PLURNK_MCP_ENABLED_ARGS.*PLURNK_MCP_ENABLED.*reserved global/,
    );
});

test("stdio targets preserve whitespace as part of one exact executable", () => {
    const target = "/opt/MCP Servers/atlas";
    assert.deepEqual(serverDefinition("atlas", {
        ...floor,
        PLURNK_MCP_ATLAS: target,
        PLURNK_MCP_ATLAS_ARGS: '["--stdio"]',
    }), {
        name: "atlas",
        transport: "stdio",
        command: target,
        args: ["--stdio"],
        read: [],
    });
});

test("tool policy uses absence for all, an exact array to narrow, and rejects ambiguous or duplicate names", () => {
    assert.deepEqual(serverDefinition("atlas", {
        ...floor,
        PLURNK_MCP_ATLAS: "node",
        PLURNK_MCP_ATLAS_TOOLS: "[]",
    }), {
        name: "atlas",
        transport: "stdio",
        command: "node",
        args: [],
        tools: [],
        read: [],
    });
    assert.throws(
        () => serverDefinition("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_TOOLS: '"echo"',
        }),
        /TOOLS.*JSON array of strings/,
    );
    assert.throws(
        () => serverDefinition("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_TOOLS: '["echo","echo"]',
        }),
        /TOOLS.*duplicate tool name 'echo'/,
    );
    assert.throws(
        () => serverDefinition("atlas", {
            ...floor,
            PLURNK_MCP_ATLAS: "node",
            PLURNK_MCP_ATLAS_READ: '["echo","echo"]',
        }),
        /READ.*duplicate tool name 'echo'/,
    );
});

test("{§mcp-configuration-cascade} client companions replace complete fields over normalized service or worker definitions", () => {
    const base = serverDefinition("gitea", {
        ...floor,
        PLURNK_MCP_GITEA: "gitea-mcp",
        PLURNK_MCP_GITEA_ARGS: '["serve"]',
        PLURNK_MCP_GITEA_ENV: '{"TENANT":"main","TRACE":"off"}',
        PLURNK_MCP_GITEA_TOOLS: '["issue_read"]',
    });
    assert.ok(base);
    const definitions = overlayServerDefinitions({
        PLURNK_MCP_GITEA_ARGS: '["plurnk_pk"]',
        PLURNK_MCP_GITEA_ENV: '{"TENANT":"project"}',
    }, new Map([["gitea", base]]));
    assert.deepEqual(definitions.get("gitea"), {
        name: "gitea",
        transport: "stdio",
        command: "gitea-mcp",
        args: ["plurnk_pk"],
        env: { TENANT: "project" },
        tools: ["issue_read"],
        read: [],
    });
});

test("{§mcp-configuration-cascade} a client target replaces the lower definition before its companions apply", () => {
    const base = serverDefinition("atlas", {
        ...floor,
        PLURNK_MCP_ATLAS: "atlas-mcp",
        PLURNK_MCP_ATLAS_ARGS: '["serve"]',
        PLURNK_MCP_ATLAS_CWD: "/srv/atlas",
        PLURNK_MCP_ATLAS_ENV: '{"MODE":"service"}',
    });
    assert.ok(base);
    const definitions = overlayServerDefinitions({
        PLURNK_MCP_ATLAS: "https://atlas.example.test/mcp",
        PLURNK_MCP_ATLAS_HEADERS: '{"X-Tenant":"project"}',
    }, new Map([["atlas", base]]));
    assert.deepEqual(definitions.get("atlas"), {
        name: "atlas",
        transport: "http",
        url: "https://atlas.example.test/mcp",
        headers: { "X-Tenant": "project" },
        read: [],
    });
});

test("{§mcp-configuration-cascade} client-only definitions are complete and incomplete fragments fail at the parser boundary", () => {
    assert.deepEqual(
        overlayServerDefinitions({
            PLURNK_MCP_LOCAL: process.execPath,
            PLURNK_MCP_LOCAL_ARGS: '["server.mjs"]',
        }).get("local"),
        {
            name: "local",
            transport: "stdio",
            command: process.execPath,
            args: ["server.mjs"],
            read: [],
        },
    );
    assert.throws(
        () => overlayServerDefinitions({
            PLURNK_MCP_LOCAL_ARGS: '["server.mjs"]',
        }),
        /PLURNK_MCP_LOCAL_ARGS.*PLURNK_MCP_LOCAL/,
    );
    assert.throws(
        () => overlayServerDefinitions({
            PLURNK_MCP_ENABLED: '["local"]',
        } as never),
        /invalid MCP configuration overlay/,
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

test("{§mcp-summary-derivation} _SUMMARY companions separate server and tool tiers", () => {
    const environ = {
        ...floor,
        PLURNK_MCP_BRAVE: "npx",
        PLURNK_MCP_BRAVE_SUMMARY: "Search the web with Brave.",
        PLURNK_MCP_BRAVE_BRAVE_WEB_SEARCH_SUMMARY: "General web search.",
    };
    const { servers, tools } = summaryOverrides(environ);
    assert.deepEqual([...servers], [["brave", "Search the web with Brave."]]);
    assert.deepEqual([...tools], [["brave/brave_web_search", "General web search."]]);
});

test("{§mcp-summary-derivation} a tool _SUMMARY companion without its server target is an orphan", () => {
    assert.throws(
        () => summaryOverrides({
            ...floor,
            PLURNK_MCP_BRAVE_BRAVE_WEB_SEARCH_SUMMARY: "General web search.",
        }),
        /no MCP server target/,
    );
});

test("{§mcp-summary-derivation} summary companions expand ${NAME} references", () => {
    const { servers } = summaryOverrides({
        ...floor,
        PLURNK_MCP_BRAVE: "npx",
        PLURNK_MCP_BRAVE_SUMMARY: "Search with ${SEARCH_KIND}.",
        SEARCH_KIND: "the Brave API",
    });
    assert.equal(servers.get("brave"), "Search with the Brave API.");
});
