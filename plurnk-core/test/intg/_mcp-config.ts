// {§mcp-configuration} Test daemons receive explicit definitions and an isolated state home.
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import HostPaths from "../../src/core/HostPaths.ts";

export const MCP_FIXTURES = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures", import.meta.url));

// One stdio transport definition, before its alias is bound.
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

export const mcpFixture = async (t: TestContext, servers: Readonly<Record<string, object>>): Promise<{ hostPaths: HostPaths; env: Record<string, string> }> => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-mcp-home-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home, env: { XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state") } });
    return { hostPaths, env: mcpEnvironment(servers) };
};

export const mcpEnvironment = (servers: Readonly<Record<string, object>>): Record<string, string> => ({
    ...MCP_CONTROLS,
    ...Object.fromEntries(Object.entries(servers).map(([name, definition]) => [
        `PLURNK_MCP_${name.replaceAll("-", "_")}`, JSON.stringify({ name, ...definition }),
    ])),
});

// The fixture-scaled host controls.
export const MCP_CONTROLS = {
    PLURNK_MCP_ENABLED: "1",
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
    PLURNK_MCP_RETRY_FLOOR_MS: "250",
    PLURNK_MCP_RETRY_CEILING_MS: "5000",
} as const;
