// {§mcp-expressions} Canonical universal `mcp` wire tool definition declared on emission turns.

export interface McpWireToolDefinition {
    readonly name: "mcp";
    readonly description: string;
    readonly parameters: {
        readonly type: "object";
        readonly required: readonly ["server", "tool", "arguments"];
        readonly properties: {
            readonly server: { readonly type: "string" };
            readonly tool: { readonly type: "string" };
            readonly arguments: {
                readonly type: "object";
                readonly additionalProperties: true;
            };
            readonly aside: {
                readonly type: "string";
                readonly description: string;
            };
        };
        readonly additionalProperties: false;
    };
}

const freezeDeep = <T extends object>(value: T): T => {
    for (const child of Object.values(value)) {
        if (typeof child === "object" && child !== null) freezeDeep(child);
    }
    return Object.freeze(value);
};

export const MCP_WIRE_TOOL: McpWireToolDefinition = freezeDeep({
    name: "mcp",
    description: "Call an MCP tool.",
    parameters: {
        type: "object",
        required: ["server", "tool", "arguments"],
        properties: {
            server: { type: "string" },
            tool: { type: "string" },
            arguments: {
                type: "object",
                additionalProperties: true,
            },
            aside: {
                type: "string",
                description: "Optional terse intent note.",
            },
        },
        additionalProperties: false,
    },
});
