type ToolProtocol = "openai" | "messages" | "generate-content";

// {§provider-native-tools-disabled} The SDK omits an empty tool set and its
// choice. Project the invariant after serialization, using protocol fields only.
export const withoutNativeTools = (
    body: Record<string, unknown>,
    protocol: ToolProtocol,
): Record<string, unknown> => {
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) {
        throw new TypeError("PLURNK provider requests cannot declare native tools");
    }
    if (protocol === "generate-content") {
        return { ...body, tools: [], toolConfig: { functionCallingConfig: { mode: "NONE" } } };
    }
    return { ...body, tools: [], tool_choice: protocol === "messages" ? { type: "none" } : "none" };
};

export const withoutNativeToolsFetch = (protocol: ToolProtocol): typeof globalThis.fetch => (input, init) => {
    if (typeof init?.body !== "string") throw new TypeError("Provider generation requires a serialized JSON request");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return globalThis.fetch(input, { ...init, body: JSON.stringify(withoutNativeTools(body, protocol)) });
};
