// {§mcp-plugin-servers} — the package's fixture servers stand as one installed plugin: its root is the
// fixtures directory, and a stdio fixture launches as a bare `node` with the fixture's path, exactly
// as a plugin's mcp.json would declare it.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerDefinition } from "@plurnk/plurnk-contracts";

export const FIXTURES = fileURLToPath(new URL("../src/fixtures", import.meta.url));

export const fixturePlugin = Object.freeze({
    name: "plurnk-mcp-fixtures",
    root: FIXTURES,
    // PLUGIN_DATA: created by the launch itself, as for any plugin.
    data: join(tmpdir(), `plurnk-mcp-fixtures-data-${process.pid}`),
});

export const fixture = (file: string): string => join(FIXTURES, file);

export const stdioServer = (
    name: string,
    args: readonly string[] = [fixture("echo-server.mjs")],
    extra: { readonly env?: Readonly<Record<string, string>>; readonly cwd?: string } = {},
): McpServerDefinition => ({
    name,
    scope: "global",
    plugin: { ...fixturePlugin },
    type: "stdio",
    command: "node",
    args: [...args],
    ...(extra.env === undefined ? {} : { env: { ...extra.env } }),
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
});

export const httpServer = (name: string, url: string, headers?: Readonly<Record<string, string>>): McpServerDefinition => ({
    name,
    scope: "global",
    plugin: { ...fixturePlugin },
    type: "streamable-http",
    url,
    ...(headers === undefined ? {} : { headers: { ...headers } }),
});
