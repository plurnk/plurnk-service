// {§mcp-configuration} Definitions and independent controls share the resource environment dialect.
import { ConfigurationError, Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import type { FunctionalityServiceDefinition, McpServerDefinition, Notice } from "@plurnk/plurnk-contracts";
import type { DiscoveredPlugin } from "@plurnk/plurnk-agent-plugins";
import { readDefinition } from "./definition.ts";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PluginSources {
    readonly plugins: readonly (DiscoveredPlugin & { readonly data: string })[];
    readonly roots: Readonly<Record<string, string | null>>;
}

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
        throw new ConfigurationError(field, `${field} must be a JSON array of strings.`, { cause });
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new ConfigurationError(field, `${field} must be a JSON array of strings.`);
    }
    return parsed;
};

const uniqueNames = (values: readonly string[], field: string, what: string): string[] => {
    const unique = new Set<string>();
    for (const value of values) {
        if (value.length === 0) throw new ConfigurationError(field, `${field} contains an empty ${what}.`);
        if (unique.has(value)) throw new ConfigurationError(field, `${field} contains duplicate ${what} '${value}'.`);
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

export const serviceDefinitions = (environ: NodeJS.ProcessEnv = process.env): Array<FunctionalityServiceDefinition & { definition: McpServerDefinition }> => {
    const { resources } = configuration(environ);
    return [...resources.definitions].map(([alias, { key, value }]) => {
        let definition: McpServerDefinition;
        try {
            definition = readDefinition(JSON.parse(value));
        } catch (cause) {
            throw new ConfigurationError(key, `${key} must be an MCP server definition.`, { cause });
        }
        if (definition.name !== alias) throw new ConfigurationError(key, `${key} must define name '${alias}'.`);
        return { alias, definition, enabled: resources.enabled(alias), provenance: { kind: "environment", source: key } };
    });
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// {§mcp-file-configuration} Files supply definitions, not installations or another lifecycle.
export const configuredDefinitions = async (
    directories: readonly string[],
    environ: NodeJS.ProcessEnv = process.env,
    plugins?: PluginSources & { report(notice: Notice): void },
): Promise<Array<FunctionalityServiceDefinition & { definition: McpServerDefinition }>> => {
    const { resources } = configuration(environ);
    const selected = new Map(serviceDefinitions(environ).map((entry) => [entry.alias, entry]));
    const addPlugins = (scopeDirectory: string | null): void => {
        for (const plugin of plugins?.plugins ?? []) {
            const root = plugins!.roots[plugin.scope];
            if ((root == null ? null : dirname(root)) !== scopeDirectory) continue;
            const file = join(plugin.root, "mcp.json");
            for (const [alias, entry] of plugin.mcpServers ?? []) {
                if (selected.has(alias)) continue;
                const reference = `/mcpServers/${alias.replaceAll("~", "~0").replaceAll("/", "~1")}`;
                if (!isServerName(alias) || entry.type === "sse") {
                    plugins!.report({
                        source: "engine:configuration", kind: "plugin_configuration", level: "warn", family: "mcp",
                        message: `${file}#${reference}: ${entry.type === "sse" ? "legacy SSE transport is unsupported" : "server name must match [a-z][a-z0-9-]*"}; this entry was skipped.`,
                    });
                    continue;
                }
                const definition = readDefinition({ ...entry, name: alias });
                selected.set(alias, {
                    alias, definition, enabled: resources.enabled(alias),
                    context: { root: plugin.root, data: plugin.data },
                    provenance: { kind: "plugin", source: file, reference },
                });
            }
        }
    };
    const addFile = async (directory: string): Promise<void> => {
        const file = join(directory, "mcp.json");
        let contents: string;
        try {
            contents = await readFile(file, "utf8");
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
            throw new ConfigurationError(file, `${file} could not be read.`, { cause });
        }
        let document: unknown;
        try { document = JSON.parse(contents); } catch (cause) {
            throw new ConfigurationError(file, `${file} must contain valid JSON.`, { cause });
        }
        if (!isObject(document) || !isObject(document.mcpServers)
            || Object.keys(document).some((key) => key !== "mcpServers" && key !== "$schema")
            || (document.$schema !== undefined && typeof document.$schema !== "string")) {
            throw new ConfigurationError(file, `${file} must contain a mcpServers object and, optionally, a string $schema.`);
        }
        for (const [alias, entry] of Object.entries(document.mcpServers)) {
            if (selected.has(alias)) continue;
            const reference = `/mcpServers/${alias.replaceAll("~", "~0").replaceAll("/", "~1")}`;
            const key = `${file}#${reference}`;
            let definition: McpServerDefinition;
            try {
                if (!isObject(entry)) throw new TypeError("A server entry must be an object.");
                if (Object.hasOwn(entry, "name")) throw new TypeError("The map key supplies the server name; omit name from the entry.");
                const type = Object.hasOwn(entry, "type") ? entry.type : (Object.hasOwn(entry, "command") ? "stdio" : "streamable-http");
                definition = readDefinition({ ...entry, name: alias, type });
            } catch (cause) {
                throw new ConfigurationError(key, `${key} must be a complete MCP server definition without name.`, { cause });
            }
            selected.set(alias, { alias, definition, enabled: resources.enabled(alias), provenance: { kind: "file", source: file, reference } });
        }
    };
    for (const directory of directories) {
        await addFile(directory);
        addPlugins(directory);
    }
    addPlugins(null);
    return [...selected.values()].toSorted((left, right) => left.alias.localeCompare(right.alias));
};

// {§mcp-configuration} — the servers whose every tool turn zero surveys.
export const expandedServerNames = (environ: NodeJS.ProcessEnv = process.env): string[] => {
    const field = `${PREFIX}EXPANDED`;
    const raw = environ[field];
    if (raw === undefined || raw.length === 0) return [];
    const names = uniqueNames(jsonStrings(raw, field), field, "MCP server");
    for (const name of names) {
        if (!SERVER_NAME.test(name)) throw new ConfigurationError(field, `${field} names '${name}', which is not an MCP server alias ([a-z][a-z0-9-]*).`);
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
        throw new ConfigurationError("PLURNK_MCP_RETRY_CEILING_MS", `PLURNK_MCP_RETRY_CEILING_MS (${pacing.ceilingMs}) must be at least PLURNK_MCP_RETRY_FLOOR_MS (${pacing.floorMs}).`);
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
        const refusal = "PLURNK_MCP_REGISTRY_URL must be an HTTP or HTTPS URL.";
        let url: URL;
        try {
            url = new URL(raw);
        } catch (cause) {
            throw new ConfigurationError("PLURNK_MCP_REGISTRY_URL", refusal, { cause });
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigurationError("PLURNK_MCP_REGISTRY_URL", refusal);
    }
    const limit = Knob.integer("PLURNK_MCP_REGISTRY_LIMIT", 1, environ);
    return { url: raw.length === 0 ? null : raw, limit };
};

export const requestTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number =>
    Knob.integer("PLURNK_MCP_REQUEST_TIMEOUT", 1, environ);

export const validateConfiguration = (environ: NodeJS.ProcessEnv = process.env): void => {
    serviceDefinitions(environ);
    expandedServerNames(environ);
    connectTimeoutMs(environ);
    requestTimeoutMs(environ);
    retryPacing(environ);
    registrySettings(environ);
};
