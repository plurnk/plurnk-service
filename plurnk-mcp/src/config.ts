// {§mcp-configuration} — MCP servers come only from installed Agent Plugins ({§mcp-plugin-servers});
// the environment holds the operator's per-alias settings and the host's controls, nothing else.
import { Validator, type McpOAuth } from "@plurnk/plurnk-contracts";

const PREFIX = "PLURNK_MCP_";
const CONTROLS = new Set(["CONNECT_TIMEOUT", "REQUEST_TIMEOUT", "RETRY_FLOOR_MS", "RETRY_CEILING_MS", "EXPANDED", "REGISTRY_URL", "REGISTRY_LIMIT"]);
const SETTINGS = ["_TOOLS", "_BEARER", "_OAUTH"] as const;
// Each retired server variable names what replaced it.
const RETIRED_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
    ["_ARGS", "an Agent Plugin's mcp.json declares args"],
    ["_CWD", "an Agent Plugin's mcp.json declares cwd"],
    ["_ENV", "an Agent Plugin's mcp.json declares env"],
    ["_HEADERS", "an Agent Plugin's mcp.json declares headers"],
    ["_READ", "a tool's annotations.readOnlyHint marks it read-only"],
    ["_SUMMARY", "descriptions come from the server's own fields"],
];
const SERVER_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const SYMBOLIC_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

export interface ToolPolicy {
    // Exact enabled tool names; null enables every tool the server lists.
    readonly tools: readonly string[] | null;
}

// Client-managed authorization for one Streamable HTTP server ({§mcp-server-settings}).
export type McpAuthorization = { readonly type: "bearer"; readonly token: string } | McpOAuth;

export interface ServerSettings extends ToolPolicy {
    readonly authorization?: McpAuthorization;
}

// A setting's variable for one alias: uppercase, with the alias's hyphens as underscores.
export const settingName = (alias: string, suffix: typeof SETTINGS[number]): string =>
    `${PREFIX}${alias.toUpperCase().replaceAll("-", "_")}${suffix}`;

// {§mcp-configuration} — a retired variable fails boot, naming what replaced it; an empty one states nothing.
export const assertNoRetiredVariables = (environ: NodeJS.ProcessEnv = process.env): void => {
    for (const [key, value] of Object.entries(environ)) {
        if (!key.startsWith(PREFIX) || value === undefined || value.length === 0) continue;
        const rest = key.slice(PREFIX.length).toUpperCase();
        if (CONTROLS.has(rest) || SETTINGS.some((suffix) => rest.endsWith(suffix) && rest.length > suffix.length)) continue;
        if (rest === "ENABLED") {
            throw new Error(`${key} is retired: an installed plugin's servers are enabled, and /mcp disable withdraws one.`);
        }
        const retired = RETIRED_SUFFIXES.find(([suffix]) => rest.endsWith(suffix));
        throw new Error(`${key} is retired: ${retired?.[1] ?? "MCP servers come from an installed Agent Plugin's mcp.json, or mcp add"}.`);
    }
};

export const expandReferences = (value: string, environ: NodeJS.ProcessEnv, field: string): string =>
    value.replaceAll(ENV_REFERENCE, (_match, name: string) => {
        const resolved = environ[name];
        if (resolved === undefined) throw new Error(`${field} references missing environment variable ${name}.`);
        return resolved;
    });

const jsonStrings = (raw: string, field: string): string[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error(`${field} must be a JSON array of strings.`, { cause });
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error(`${field} must be a JSON array of strings.`);
    }
    return parsed;
};

const uniqueNames = (values: readonly string[], field: string, what: string): string[] => {
    const unique = new Set<string>();
    for (const value of values) {
        if (value.length === 0) throw new Error(`${field} contains an empty ${what}.`);
        if (unique.has(value)) throw new Error(`${field} contains duplicate ${what} '${value}'.`);
        unique.add(value);
    }
    return [...unique];
};

// {§mcp-server-settings} — one alias's operator settings. Absent or empty _TOOLS enables every tool;
// _BEARER is one ${NAME} reference; _OAUTH is McpOAuth JSON; a server takes at most one of the two.
export const serverSettings = (alias: string, environ: NodeJS.ProcessEnv = process.env): ServerSettings => {
    const toolsKey = settingName(alias, "_TOOLS");
    const bearerKey = settingName(alias, "_BEARER");
    const oauthKey = settingName(alias, "_OAUTH");
    const toolsRaw = environ[toolsKey];
    const tools = toolsRaw === undefined || toolsRaw.length === 0 ? null : uniqueNames(jsonStrings(toolsRaw, toolsKey), toolsKey, "tool name");
    const bearer = environ[bearerKey];
    const oauth = environ[oauthKey];
    const hasBearer = bearer !== undefined && bearer.length > 0;
    const hasOAuth = oauth !== undefined && oauth.length > 0;
    if (hasBearer && hasOAuth) throw new Error(`${bearerKey} and ${oauthKey} are exclusive: a server takes one authorization.`);
    if (hasBearer) {
        if (!SYMBOLIC_REFERENCE.test(bearer)) throw new Error(`${bearerKey} must be one \${NAME} reference, so the token stays in the environment.`);
        return { tools, authorization: { type: "bearer", token: bearer } };
    }
    if (hasOAuth) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(oauth);
        } catch (cause) {
            throw new Error(`${oauthKey} must be McpOAuth JSON.`, { cause });
        }
        return { tools, authorization: Validator.assertMcpOAuth(parsed as McpOAuth) };
    }
    return { tools };
};

// {§mcp-configuration} — the servers whose every tool turn zero surveys.
export const expandedServerNames = (environ: NodeJS.ProcessEnv = process.env): string[] => {
    const field = `${PREFIX}EXPANDED`;
    const raw = environ[field];
    if (raw === undefined || raw.length === 0) return [];
    const names = uniqueNames(jsonStrings(raw, field), field, "MCP server");
    for (const name of names) {
        if (!SERVER_NAME.test(name)) throw new Error(`${field} names '${name}', which is not an MCP server alias ([a-z][a-z0-9-]*).`);
    }
    return names.toSorted();
};

export const isServerName = (name: string): boolean => SERVER_NAME.test(name);

export const connectTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number => {
    const raw = environ.PLURNK_MCP_CONNECT_TIMEOUT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`PLURNK_MCP_CONNECT_TIMEOUT must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

// {§mcp-retry-pacing} — every retry the adapter schedules doubles its delay from the floor to the ceiling.
export interface RetryPacing {
    readonly floorMs: number;
    readonly ceilingMs: number;
}

export const retryPacing = (environ: NodeJS.ProcessEnv = process.env): RetryPacing => {
    const read = (name: "PLURNK_MCP_RETRY_FLOOR_MS" | "PLURNK_MCP_RETRY_CEILING_MS"): number => {
        const raw = environ[name];
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}.`);
        return value;
    };
    const pacing = { floorMs: read("PLURNK_MCP_RETRY_FLOOR_MS"), ceilingMs: read("PLURNK_MCP_RETRY_CEILING_MS") };
    if (pacing.ceilingMs < pacing.floorMs) {
        throw new Error(`PLURNK_MCP_RETRY_CEILING_MS (${pacing.ceilingMs}) must be at least PLURNK_MCP_RETRY_FLOOR_MS (${pacing.floorMs}).`);
    }
    return pacing;
};

export const retryDelayMs = ({ floorMs, ceilingMs }: RetryPacing, attempt: number): number =>
    Math.min(floorMs * (2 ** attempt), ceilingMs);

// {§mcp-registry-discovery} — the registry `discover` searches, or null when the operator names none.
export interface RegistrySettings {
    readonly url: string | null;
    readonly limit: number;
}

export const registrySettings = (environ: NodeJS.ProcessEnv = process.env): RegistrySettings => {
    const raw = environ.PLURNK_MCP_REGISTRY_URL;
    if (raw === undefined) throw new Error("PLURNK_MCP_REGISTRY_URL is missing from the assembled environment floor.");
    if (raw.length > 0) {
        // The rule an MCP endpoint follows: HTTPS, or HTTP on a loopback host.
        const refusal = `PLURNK_MCP_REGISTRY_URL must be an https URL, or http on a loopback host; got ${JSON.stringify(raw)}.`;
        let url: URL;
        try {
            url = new URL(raw);
        } catch (cause) {
            throw new Error(refusal, { cause });
        }
        const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(refusal);
    }
    const limitRaw = environ.PLURNK_MCP_REGISTRY_LIMIT;
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`PLURNK_MCP_REGISTRY_LIMIT must be a positive integer; got ${JSON.stringify(limitRaw)}.`);
    }
    return { url: raw.length === 0 ? null : raw, limit };
};

export const requestTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number => {
    const raw = environ.PLURNK_MCP_REQUEST_TIMEOUT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`PLURNK_MCP_REQUEST_TIMEOUT must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};
