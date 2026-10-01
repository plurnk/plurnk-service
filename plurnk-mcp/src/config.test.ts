import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { PluginRoots, PLUGIN_SCHEMA, MCP_SCHEMA } from "@plurnk/plurnk-agent-plugins";
import type { Notice } from "@plurnk/plurnk-contracts";
import {
    serviceDefinitions,
    configuredDefinitions,
    connectTimeoutMs,
    expandedServerNames,
    requestTimeoutMs,
    registrySettings,
    retryDelayMs,
    retryPacing,
    serverSettings,
    validateConfiguration,
} from "./config.ts";

const floor = {
    PLURNK_MCP_ENABLED: "1",
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "86400000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

test("{§mcp-plugin-configuration} plugin servers compose by scope, retain context, and isolate unsupported entries", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-mcp-plugins-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const project = join(directory, "project", ".agents");
    const global = join(directory, "global", ".agents");
    const root = join(project, "plugins", "bundle");
    await mkdir(root, { recursive: true });
    await mkdir(global, { recursive: true });
    await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "bundle" }));
    const source = { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/run.mjs"] };
    await writeFile(join(root, "mcp.json"), JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: {
        example: source, "not supported": source, legacy: { type: "sse", url: "https://example.org/mcp" },
    } }));
    await writeFile(join(global, "mcp.json"), JSON.stringify({ mcpServers: { example: { command: "global" } } }));
    const discovered = await PluginRoots.discover([{ scope: "project", directory: join(project, "plugins") }]);
    const data = join(directory, "data");
    const notices: Notice[] = [];
    const sources = { plugins: discovered.plugins.map((plugin) => ({ ...plugin, data })), roots: { project: join(project, "plugins") }, report: (notice: Notice) => notices.push(notice) };
    const definitions = await configuredDefinitions([project, global], floor, sources);
    assert.deepEqual(definitions, [{
        alias: "example", enabled: true, definition: { ...source, name: "example" }, context: { root, data },
        provenance: { kind: "plugin", source: join(root, "mcp.json"), reference: "/mcpServers/example" },
    }]);
    assert.equal(notices.length, 2);
    assert.match(notices[0]!.message!, /server name must match/u);
    assert.match(notices[1]!.message!, /legacy SSE transport is unsupported/u);
    await writeFile(join(project, "mcp.json"), JSON.stringify({ mcpServers: { example: { command: "standalone" } } }));
    const replaced = (await configuredDefinitions([project, global], floor, sources))[0]!;
    assert.equal(replaced.context, undefined);
    assert.deepEqual(replaced.definition, { name: "example", type: "stdio", command: "standalone" });
    const overridden = await configuredDefinitions([project, global], {
        ...floor, PLURNK_MCP_example: JSON.stringify({ name: "example", type: "stdio", command: "environment" }), PLURNK_MCP_example_ENABLED: "0",
    }, sources);
    assert.deepEqual(overridden[0], {
        alias: "example", enabled: false, definition: { name: "example", type: "stdio", command: "environment" },
        provenance: { kind: "environment", source: "PLURNK_MCP_example" },
    });
});

test("{§mcp-configuration} whole definitions and independent controls use the shared resource dialect", () => {
    const definition = { name: "code-search", type: "stdio", command: "node", args: ["server.mjs"] };
    const env = { ...floor, PLURNK_MCP_code_search: JSON.stringify(definition), PLURNK_MCP_code_search_ENABLED: "0" };
    const provenance = { kind: "environment", source: "PLURNK_MCP_code_search" };
    assert.deepEqual(serviceDefinitions(env), [{ alias: "code-search", definition, enabled: false, provenance }]);
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_MCP_code_search_ENABLED: "1" }), [{ alias: "code-search", definition, enabled: true, provenance }]);
    const replacement = { name: "code-search", type: "streamable-http", url: "https://example.com/mcp" };
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_MCP_code_search: JSON.stringify(replacement) }), [{ alias: "code-search", definition: replacement, enabled: false, provenance }]);
    assert.deepEqual(serviceDefinitions(floor), []);
});

test("{§mcp-file-configuration} files compose whole entries beneath environment definitions and independent controls", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-sources-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directories = ["project", "plurnk", "global"].map((name) => join(root, name));
    for (const directory of directories) await mkdir(directory);
    const save = (index: number, mcpServers: object) => writeFile(join(directories[index], "mcp.json"), JSON.stringify({ mcpServers }));
    await save(2, { tool: { command: "global", args: ["must-not-leak"], env: { SOURCE: "global" } }, other: { command: "other" } });
    await save(1, { tool: { command: "plurnk" } });
    await save(0, { tool: { url: "http://project.internal/mcp" } });
    const env = { ...floor, PLURNK_MCP_ENABLED: "0", PLURNK_MCP_tool_ENABLED: "1", PLURNK_MCP_tool_TOOLS: '["inspect"]' };
    const definitions = await configuredDefinitions(directories, env);
    assert.deepEqual(definitions, [
        { alias: "other", enabled: false, definition: { name: "other", type: "stdio", command: "other" }, provenance: { kind: "file", source: join(directories[2], "mcp.json"), reference: "/mcpServers/other" } },
        { alias: "tool", enabled: true, definition: { name: "tool", type: "streamable-http", url: "http://project.internal/mcp" }, provenance: { kind: "file", source: join(directories[0], "mcp.json"), reference: "/mcpServers/tool" } },
    ]);
    assert.deepEqual(serverSettings("tool", env), { tools: ["inspect"] });
    const override = { name: "tool", type: "stdio", command: "environment" };
    assert.deepEqual((await configuredDefinitions(directories, { ...env, PLURNK_MCP_tool: JSON.stringify(override) })).find(({ alias }) => alias === "tool"), {
        alias: "tool", enabled: true, definition: override, provenance: { kind: "environment", source: "PLURNK_MCP_tool" },
    });
    await rm(join(directories[0], "mcp.json"));
    assert.deepEqual((await configuredDefinitions(directories, env))[1].definition, { name: "tool", type: "stdio", command: "plurnk" });
    await rm(join(directories[1], "mcp.json"));
    assert.deepEqual((await configuredDefinitions(directories, env))[1].definition, { name: "tool", type: "stdio", command: "global", args: ["must-not-leak"], env: { SOURCE: "global" } });
    assert.deepEqual(await configuredDefinitions([], floor), [], "unselected roots are never read");
});

test("{§mcp-file-configuration} invalid selected entries identify their file and pointer without leaking values or falling back", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-invalid-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "mcp.json");
    for (const entry of [null, {}, { command: "node", type: null }, { command: "node", url: "http://example.com" },
        { type: "sse", url: "http://example.com" }, { name: "tool", command: "node" }, { type: "stdio", args: ["private-value"] }]) {
        await writeFile(file, JSON.stringify({ mcpServers: { tool: entry } }));
        await assert.rejects(configuredDefinitions([root], floor), (error: unknown) => {
            assert.ok(error instanceof ConfigurationError);
            assert.equal(error.key, `${file}#/mcpServers/tool`);
            assert.doesNotMatch(error.message, /private-value/u);
            return true;
        });
        const env = { ...floor, PLURNK_MCP_tool: '{"name":"tool","type":"stdio","command":"valid"}' };
        assert.equal((await configuredDefinitions([root], env))[0].definition.name, "tool", "a shadowed entry is not the effective definition");
    }
    await writeFile(file, '{"mcpServers":{"UpperCase":{"command":"node"}}}');
    await assert.rejects(configuredDefinitions([root], floor), (error: unknown) => error instanceof ConfigurationError && error.key === `${file}#/mcpServers/UpperCase`);
});

test("{§mcp-file-configuration} missing files are inert, malformed and unreadable files remain inspectable configuration errors", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-document-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "mcp.json");
    assert.deepEqual(await configuredDefinitions([root], floor), []);
    for (const contents of ["private-value", "null", "[]", "{}", '{"mcpServers":[]}', '{"mcpServers":{},"other":1}', '{"mcpServers":{},"$schema":null}']) {
        await writeFile(file, contents);
        await assert.rejects(configuredDefinitions([root], floor), (error: unknown) => {
            assert.ok(error instanceof ConfigurationError);
            assert.equal(error.key, file);
            assert.doesNotMatch(error.message, /private-value/u);
            return true;
        });
    }
    await writeFile(file, '{"mcpServers":{},"$schema":"https://example.invalid/schema.json"}');
    assert.deepEqual(await configuredDefinitions([root], floor), [], "an editor hint performs no remote lookup");
    await rm(file);
    await mkdir(file);
    await assert.rejects(configuredDefinitions([root], floor), (error: unknown) => error instanceof ConfigurationError && error.key === file && error.message.endsWith("could not be read."));
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
    assert.deepEqual(serviceDefinitions({ ...env, PLURNK_MCP_future: JSON.stringify(definition) }), [{ alias: "future", definition, enabled: false, provenance: { kind: "environment", source: "PLURNK_MCP_future" } }]);
});

test("{§mcp-configuration} EXPANDED names server aliases", () => {
    assert.deepEqual(expandedServerNames(floor), []);
    assert.deepEqual(expandedServerNames({ ...floor, PLURNK_MCP_EXPANDED: '["forge","brave"]' }), ["brave", "forge"]);
    assert.throws(() => expandedServerNames({ ...floor, PLURNK_MCP_EXPANDED: '["Forge"]' }), /not an MCP server alias/u);
    assert.throws(() => expandedServerNames({ ...floor, PLURNK_MCP_EXPANDED: '["a","a"]' }), /duplicate MCP server 'a'/u);
});

test("{§mcp-configuration} explicit HTTP endpoints and registries need not be loopback addresses", () => {
    for (const url of ["http://mcp.internal/mcp", "http://192.0.2.1:8080/mcp", "https://example.com/mcp"]) {
        const definition = { name: "remote", type: "streamable-http", url };
        assert.deepEqual(serviceDefinitions({ ...floor, PLURNK_MCP_remote: JSON.stringify(definition) }), [
            { alias: "remote", definition, enabled: true, provenance: { kind: "environment", source: "PLURNK_MCP_remote" } },
        ]);
        assert.deepEqual(registrySettings({ ...floor, PLURNK_MCP_REGISTRY_URL: url, PLURNK_MCP_REGISTRY_LIMIT: "10" }), { url, limit: 10 });
    }
    for (const url of ["https://", "file:///tmp/registry", "ftp://registry.example/"]) {
        assert.throws(() => registrySettings({ ...floor, PLURNK_MCP_REGISTRY_URL: url, PLURNK_MCP_REGISTRY_LIMIT: "10" }), /PLURNK_MCP_REGISTRY_URL must be an HTTP or HTTPS URL/u);
    }
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

test("{§operator-config-offline-validation} MCP validation checks every independent control without starting a connection", () => {
    const env = { ...floor, PLURNK_MCP_REGISTRY_URL: "", PLURNK_MCP_REGISTRY_LIMIT: "10", PLURNK_MCP_future_TOOLS: '["search"]' };
    assert.doesNotThrow(() => validateConfiguration(env));
    for (const [key, value] of Object.entries({
        PLURNK_MCP_CONNECT_TIMEOUT: "0", PLURNK_MCP_REQUEST_TIMEOUT: "0", PLURNK_MCP_RETRY_FLOOR_MS: "0",
        PLURNK_MCP_RETRY_CEILING_MS: "1", PLURNK_MCP_REGISTRY_URL: "file:///registry", PLURNK_MCP_REGISTRY_LIMIT: "0",
        PLURNK_MCP_EXPANDED: '["BAD"]', PLURNK_MCP_future_TOOLS: "[1]",
    })) {
        assert.throws(() => validateConfiguration({ ...env, [key]: value }), (error: Error) => error.message.includes(key));
    }
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
