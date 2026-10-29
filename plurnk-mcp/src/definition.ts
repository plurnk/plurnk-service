import { Validator, type McpServerDefinition } from "@plurnk/plurnk-contracts";

// {§mcp-server-definition} One admission path for configuration and live additions.
export const readDefinition = (input: unknown): McpServerDefinition => {
    const definition = structuredClone(Validator.assertMcpServerDefinition(input));
    if (Array.isArray(definition.plurnkWorkspace)) {
        const seen = new Set<string>();
        for (const ws of definition.plurnkWorkspace) {
            if (seen.has(ws)) {
                throw new TypeError(`MCP server '${definition.name}' plurnkWorkspace contains duplicate workspace '${ws}'.`);
            }
            seen.add(ws);
        }
        if (seen.has("*") && seen.size > 1) {
            throw new TypeError(`MCP server '${definition.name}' plurnkWorkspace cannot combine '*' with named workspaces.`);
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
