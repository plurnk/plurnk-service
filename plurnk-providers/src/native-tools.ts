import { isRecord } from "@plurnk/plurnk-contracts";
import { outboundFetch } from "@plurnk/plurnk-meta";

type ToolProtocol = "openai" | "messages" | "generate-content";

// {§provider-interface} The SDK omits an empty tool set and its
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

export const withoutNativeToolsFetch = (
    protocol: ToolProtocol,
    fetch: typeof globalThis.fetch = outboundFetch,
): typeof globalThis.fetch => (input, init) => {
    if (typeof init?.body !== "string") throw new TypeError("Provider generation requires a serialized JSON request");
    const body: unknown = JSON.parse(init.body);
    if (!isRecord(body)) throw new TypeError("Provider generation requires a JSON object request");
    return fetch(input, { ...init, body: JSON.stringify(withoutNativeTools(body, protocol)) });
};
