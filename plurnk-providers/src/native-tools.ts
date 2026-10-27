type ToolProtocol = "openai" | "messages" | "generate-content" | "amazon-bedrock";

// {§provider-interface} The SDK omits an empty tool set and its
// choice. Project the invariant on the outgoing payload, using protocol fields only.
export const withoutNativeTools = (
    body: Record<string, unknown>,
    protocol: ToolProtocol,
): Record<string, unknown> => {
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) {
        throw new TypeError("PLURNK provider requests cannot declare native tools");
    }
    if (protocol === "amazon-bedrock") {
        if (body.toolConfig !== undefined) {
            throw new TypeError("PLURNK provider requests cannot declare native tools");
        }
        const { tools: _, toolConfig: __, tool_choice: ___, ...rest } = body;
        return rest;
    }
    if (protocol === "generate-content") {
        return { ...body, tools: [], toolConfig: { functionCallingConfig: { mode: "NONE" } } };
    }
    return { ...body, tools: [], tool_choice: protocol === "messages" ? { type: "none" } : "none" };
};
