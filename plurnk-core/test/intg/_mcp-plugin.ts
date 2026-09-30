// {§mcp-plugin-servers} — a test daemon's MCP servers arrive the way every server does: in an installed
// Agent Plugin. Each call gives one test its own home, whose plurnk plugin root holds one fixture plugin.
import type { TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@plurnk/plurnk-agent-plugins";
import HostPaths from "../../src/core/HostPaths.ts";

export const MCP_FIXTURES = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures", import.meta.url));

// One stdio server entry exactly as a plugin's mcp.json declares it.
export const stdioEntry = (file: string, env?: Readonly<Record<string, string>>): object => ({
    type: "stdio",
    command: "node",
    args: [join(MCP_FIXTURES, file)],
    ...(env === undefined ? {} : { env: { ...env } }),
});

export const httpEntry = (url: string, headers?: Readonly<Record<string, string>>): object => ({
    type: "streamable-http",
    url,
    ...(headers === undefined ? {} : { headers: { ...headers } }),
});

// Host paths whose plurnk plugin root holds `fixtures`, declaring these servers; removed with the test.
export const mcpPluginHome = async (t: TestContext, servers: Readonly<Record<string, object>>): Promise<HostPaths> => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-mcp-plugin-home-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home, env: { XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state") } });
    await writePlugin(join(hostPaths.plurnkPluginsDir, "fixtures"), "fixtures", servers);
    return hostPaths;
};

export const writePlugin = async (root: string, name: string, servers: Readonly<Record<string, object>>): Promise<void> => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA, name }));
    await writeFile(join(root, "mcp.json"), JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: servers }));
};

// The MCP module's controls, the only environment it reads besides per-alias settings.
export const MCP_CONTROLS = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
    PLURNK_MCP_RETRY_FLOOR_MS: "250",
    PLURNK_MCP_RETRY_CEILING_MS: "5000",
} as const;
