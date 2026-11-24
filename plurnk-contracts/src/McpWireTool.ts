// {§mcp-expressions} Canonical universal `mcp` wire tool definition declared on emission turns.

export interface McpWireToolDefinition {
    readonly name: "mcp";
    readonly description: string;
    readonly parameters: {
        readonly type: "object";
        readonly required: readonly ["server", "tool", "aside", "arguments"];
        readonly properties: {
            readonly server: { readonly type: "string" };
            readonly tool: { readonly type: "string" };
            readonly aside: {
                readonly type: "string";
                readonly description: string;
            };
            readonly arguments: {
                readonly type: "object";
                readonly additionalProperties: true;
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
        required: ["server", "tool", "aside", "arguments"],
        properties: {
            server: { type: "string" },
            tool: { type: "string" },
            aside: {
                type: "string",
                description: "Terse intent note.",
            },
            arguments: {
                type: "object",
                additionalProperties: true,
            },
        },
        additionalProperties: false,
    },
});
