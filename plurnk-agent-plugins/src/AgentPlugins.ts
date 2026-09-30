// {§agent-plugins-manifest} The one Agent Plugins version this loader implements.
export const AGENT_PLUGINS_VERSION = "1.0.0";
export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

// A canonical identifier names its version; any other string is not an Agent Plugins identifier.
export const schemaVersion = (identifier: string, kind: "plugin" | "mcp"): string | null =>
    new RegExp(`^https://agent-plugins\\.org/schemas/([^/]+)/${kind}\\.schema\\.json$`, "u").exec(identifier)?.[1] ?? null;

// {§agent-plugins-expansion} One textual pass: text a replacement introduces is never scanned again.
export const expandPlaceholders = (value: string, { root, data }: { root: string; data: string }): string =>
    value.replaceAll(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/gu, (_placeholder, name: string) => (name === "PLUGIN_ROOT" ? root : data));

export const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
