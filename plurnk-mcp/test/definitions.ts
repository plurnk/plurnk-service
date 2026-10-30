// {§mcp-server-definition} Fixtures use ordinary explicit commands and working directories.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpStdioServerDefinition, McpStreamableHttpServerDefinition } from "@plurnk/plurnk-contracts";

export const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

export const fixture = (file: string): string => join(FIXTURES, file);

export const stdioServer = (
    _name: string,
    args: readonly string[] = [fixture("echo-server.mjs")],
    extra: { readonly env?: Readonly<Record<string, string>>; readonly cwd?: string } = {},
): McpStdioServerDefinition => ({
    type: "stdio",
    command: "node",
    args: [...args],
    ...(extra.env === undefined ? {} : { env: { ...extra.env } }),
    cwd: extra.cwd ?? FIXTURES,
});

export const httpServer = (_name: string, url: string, headers?: Readonly<Record<string, string>>): McpStreamableHttpServerDefinition => ({
    type: "streamable-http",
    url,
    ...(headers === undefined ? {} : { headers: { ...headers } }),
});
