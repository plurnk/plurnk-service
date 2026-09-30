// {§mcp-configuration} Definitions and independent controls share the resource environment dialect.
import { Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import type { McpServerDefinition } from "@plurnk/plurnk-contracts";
import { readDefinition } from "./definition.ts";

export type { McpAuthorization } from "@plurnk/plurnk-contracts";

const PREFIX = "PLURNK_MCP_";
const CONTROLS = ["CONNECT_TIMEOUT", "REQUEST_TIMEOUT", "RETRY_FLOOR_MS", "RETRY_CEILING_MS", "EXPANDED", "REGISTRY_URL", "REGISTRY_LIMIT"];
const SERVER_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

export interface ToolPolicy {
    // Exact enabled tool names; null enables every tool the server lists.
    readonly tools: readonly string[] | null;
}

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

const configuration = (environ: NodeJS.ProcessEnv) => {
    const resources = new ResourceEnvironment(PREFIX, { controls: CONTROLS, settings: ["TOOLS"] }, environ);
    const tools = new Map([...resources.settings("TOOLS")].map(([alias, { key, value }]) => [
        alias,
        value.length === 0 ? null : uniqueNames(jsonStrings(value, key), key, "tool name"),
    ] as const));
    return { resources, tools };
};

// Settings are validated even before their resource exists ({§resource-environment}).
export const serverSettings = (alias: string, environ: NodeJS.ProcessEnv = process.env): ToolPolicy => ({
    tools: configuration(environ).tools.get(alias) ?? null,
});

export const serviceDefinitions = (environ: NodeJS.ProcessEnv = process.env): Array<{ alias: string; definition: McpServerDefinition; enabled: boolean }> => {
    const { resources } = configuration(environ);
    return [...resources.definitions].map(([alias, { key, value }]) => {
        let definition: McpServerDefinition;
        try {
            definition = readDefinition(JSON.parse(value));
        } catch (cause) {
            throw new Error(`${key} must be an MCP server definition.`, { cause });
        }
        if (definition.name !== alias) throw new Error(`${key} must define name '${alias}'.`);
        return { alias, definition, enabled: resources.enabled(alias) };
    });
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

export const connectTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number =>
    Knob.integer("PLURNK_MCP_CONNECT_TIMEOUT", 1, environ);
// {§mcp-retry-pacing} — every retry the adapter schedules doubles its delay from the floor to the ceiling.
export interface RetryPacing {
    readonly floorMs: number;
    readonly ceilingMs: number;
}

export const retryPacing = (environ: NodeJS.ProcessEnv = process.env): RetryPacing => {
    const pacing = {
        floorMs: Knob.integer("PLURNK_MCP_RETRY_FLOOR_MS", 1, environ),
        ceilingMs: Knob.integer("PLURNK_MCP_RETRY_CEILING_MS", 1, environ),
    };
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
    const limit = Knob.integer("PLURNK_MCP_REGISTRY_LIMIT", 1, environ);
    return { url: raw.length === 0 ? null : raw, limit };
};

export const requestTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number =>
    Knob.integer("PLURNK_MCP_REQUEST_TIMEOUT", 1, environ);
