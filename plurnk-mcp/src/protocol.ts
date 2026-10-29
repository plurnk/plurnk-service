export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID = "io.modelcontextprotocol/oauth-client-credentials";

export const staticClientCapabilities = (): {
    readonly elicitation: { readonly form: Record<string, never>; readonly url: Record<string, never> };
    readonly sampling: Record<string, never>;
    readonly extensions: Readonly<Record<string, Record<string, never>>>;
} => ({
    elicitation: { form: {}, url: {} },
    sampling: {},
    extensions: {
        [MCP_TASKS_EXTENSION_ID]: {},
        [MCP_SKILLS_EXTENSION_ID]: {},
    },
});
