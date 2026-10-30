import { isRecord, Validator, type McpServerDefinition } from "@plurnk/plurnk-contracts";

// {§mcp-server-definition} One admission path for configuration and live additions.
export const readDefinition = (input: unknown, alias?: string): McpServerDefinition => {
    const candidate = isRecord(input) && !Object.hasOwn(input, "type") && (Object.hasOwn(input, "command") || Object.hasOwn(input, "url"))
        ? { ...input, type: Object.hasOwn(input, "command") ? "stdio" : "streamable-http" }
        : input;
    const definition = structuredClone(Validator.assertMcpServerDefinition(candidate));
    const label = alias === undefined ? "MCP server" : `MCP server '${alias}'`;
    if (Array.isArray(definition.plurnkWorkspace)) {
        const seen = new Set<string>();
        for (const ws of definition.plurnkWorkspace) {
            if (seen.has(ws)) {
                throw new TypeError(`${label} plurnkWorkspace contains duplicate workspace '${ws}'.`);
            }
            seen.add(ws);
        }
        if (seen.has("*") && seen.size > 1) {
            throw new TypeError(`${label} plurnkWorkspace cannot combine '*' with named workspaces.`);
        }
    }
    if (definition.type === "stdio") return definition;
    const url = new URL(definition.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError("An MCP endpoint must use HTTP or HTTPS.");
    }
    if (definition.authorization !== undefined && Object.keys(definition.headers ?? {}).some((name) => name.toLowerCase() === "authorization")) {
        throw new TypeError("An MCP definition cannot supply both authorization and an Authorization header.");
    }
    return definition;
};
