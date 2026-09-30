import { Validator, type McpServerDefinition } from "@plurnk/plurnk-contracts";

// {§mcp-server-definition} One admission path for configuration and live additions.
export const readDefinition = (input: unknown): McpServerDefinition => {
    const definition = structuredClone(Validator.assertMcpServerDefinition(input as McpServerDefinition));
    if (definition.type === "stdio") return definition;
    const url = new URL(definition.url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new TypeError("An MCP endpoint must use HTTPS, or HTTP on a loopback host.");
    }
    if (definition.authorization !== undefined && Object.keys(definition.headers ?? {}).some((name) => name.toLowerCase() === "authorization")) {
        throw new TypeError("An MCP definition cannot supply both authorization and an Authorization header.");
    }
    return definition;
};
