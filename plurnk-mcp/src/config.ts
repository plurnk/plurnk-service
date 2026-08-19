import {
    Validator,
    type McpConfigurationOverlay,
    type McpServerDefinition,
} from "@plurnk/plurnk-contracts";

const PREFIX = "PLURNK_MCP_";
const COMPANION_SUFFIXES = [
    "_bearer",
    "_args",
    "_cwd",
    "_env",
    "_headers",
    "_summary",
    "_tools",
    "_read",
] as const;
const CONTROL_KEYS = new Map([
    ["connect_timeout", `${PREFIX}CONNECT_TIMEOUT`],
    ["request_timeout", `${PREFIX}REQUEST_TIMEOUT`],
    ["enabled", `${PREFIX}ENABLED`],
]);
const SERVER_NAME = /^[a-z][a-z0-9-]*$/;
// {§mcp-summary-derivation} — a _SUMMARY companion may extend a server name
// with one tool name (PLURNK_MCP_<server>_<tool>_SUMMARY); tool names legally
// contain underscores, so summary keys admit them and bind to the declared
// server in summaryOverrides.
const SUMMARY_KEY_NAME = /^[a-z][a-z0-9_-]*$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

type CompanionSuffix = typeof COMPANION_SUFFIXES[number];

interface EnvironmentVariable {
    readonly key: string;
    readonly value: string;
}

export interface ToolPolicy {
    readonly tools: readonly string[] | null;
    readonly read: readonly string[];
}

interface ParsedEnvironment {
    readonly targets: Map<string, EnvironmentVariable>;
    readonly companions: Map<string, Map<CompanionSuffix, EnvironmentVariable>>;
}

const assertServerName = (name: string, variable: string): void => {
    if (!SERVER_NAME.test(name)) {
        throw new Error(
            `${variable} derives invalid MCP server name '${name}'; names must match [a-z][a-z0-9-]*.`,
        );
    }
};

const parseEnvironment = (
    environ: NodeJS.ProcessEnv,
    allowOrphanCompanions = false,
): ParsedEnvironment => {
    const targets = new Map<string, EnvironmentVariable>();
    const companions = new Map<string, Map<CompanionSuffix, EnvironmentVariable>>();
    for (const [key, value] of Object.entries(environ)) {
        if (value === undefined || !key.startsWith(PREFIX)) continue;
        const suffix = key.slice(PREFIX.length);
        if (suffix.length === 0) continue;
        const folded = suffix.toLowerCase();
        const controlKey = CONTROL_KEYS.get(folded);
        if (controlKey !== undefined) {
            if (key !== controlKey) {
                throw new Error(
                    `${key} case-folds to ${controlKey}; that name is a reserved global and must use its canonical spelling.`,
                );
            }
            continue;
        }
        const companion = COMPANION_SUFFIXES.find((candidate) => folded.endsWith(candidate));
        if (companion !== undefined) {
            const name = folded.slice(0, -companion.length);
            const reservedGlobal = CONTROL_KEYS.get(name);
            if (reservedGlobal !== undefined) {
                throw new Error(
                    `${key} uses ${reservedGlobal} as a server name; reserved globals cannot have server companions.`,
                );
            }
            if (companion === "_summary") {
                if (!SUMMARY_KEY_NAME.test(name)) {
                    throw new Error(
                        `${key} derives invalid MCP summary name '${name}'; names must match [a-z][a-z0-9_-]*.`,
                    );
                }
            } else {
                assertServerName(name, key);
            }
            const bySuffix = companions.get(name) ?? new Map<CompanionSuffix, EnvironmentVariable>();
            const existing = bySuffix.get(companion);
            if (existing !== undefined) {
                throw new Error(
                    `${existing.key} and ${key} are duplicate MCP server companions after case-folding.`,
                );
            }
            bySuffix.set(companion, { key, value });
            companions.set(name, bySuffix);
            continue;
        }
        assertServerName(folded, key);
        const existing = targets.get(folded);
        if (existing !== undefined) {
            throw new Error(
                `${existing.key} and ${key} both derive MCP server name '${folded}' after case-folding.`,
            );
        }
        targets.set(folded, { key, value });
    }
    if (!allowOrphanCompanions) {
        for (const [name, fields] of companions) {
            if (targets.has(name)) continue;
            // A _SUMMARY companion may address one tool of a declared server:
            // PLURNK_MCP_<SERVER>_<TOOL>_SUMMARY ({§mcp-summary-derivation}).
            const toolSummaryOf = [...targets.keys()].find((target) => name.startsWith(`${target}_`));
            if (fields.get("_summary") !== undefined && toolSummaryOf !== undefined) continue;
            const variables = [...fields.values()].map(({ key }) => key).join(", ");
            throw new Error(
                `${variables} has no MCP server target ${PREFIX}${name.toUpperCase()}.`,
            );
        }
    }
    return { targets, companions };
};

export const expandReferences = (value: string, environ: NodeJS.ProcessEnv, field: string): string =>
    value.replaceAll(ENV_REFERENCE, (_match, name: string) => {
        const resolved = environ[name];
        if (resolved === undefined) throw new Error(`${field} references missing environment variable ${name}.`);
        return resolved;
    });

const jsonStrings = (
    raw: string | undefined,
    field: string,
): string[] => {
    if (raw === undefined || raw.length === 0) return [];
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

const uniqueToolNames = (values: readonly string[], field: string): string[] => {
    const unique = new Set<string>();
    for (const value of values) {
        if (value.length === 0) throw new Error(`${field} contains an empty tool name.`);
        if (unique.has(value)) throw new Error(`${field} contains duplicate tool name '${value}'.`);
        unique.add(value);
    }
    return [...unique];
};

const toolNames = (
    raw: string | undefined,
    field: string,
): string[] => uniqueToolNames(jsonStrings(raw, field), field);

const jsonRecord = (
    raw: string | undefined,
    field: string,
): Record<string, string> | undefined => {
    if (raw === undefined || raw.length === 0) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error(`${field} must be a JSON object with string values.`, { cause });
    }
    if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
        || !Object.values(parsed).every((value) => typeof value === "string")
    ) {
        throw new Error(`${field} must be a JSON object with string values.`);
    }
    return parsed as Record<string, string>;
};

export const serverNames = (environ: NodeJS.ProcessEnv = process.env): string[] =>
    [...parseEnvironment(environ).targets.keys()].toSorted();

const definitionFromEnvironment = (
    name: string,
    parsed: ParsedEnvironment,
    base?: McpServerDefinition,
): McpServerDefinition | null => {
    const folded = name.toLowerCase();
    const target = parsed.targets.get(folded);
    if (target === undefined && base === undefined) {
        const orphaned = parsed.companions.get(folded);
        if (orphaned === undefined) return null;
        const variables = [...orphaned.values()].map(({ key }) => key).join(", ");
        throw new Error(
            `${variables} has no MCP server target ${PREFIX}${folded.toUpperCase()}.`,
        );
    }
    if (base !== undefined && base.name !== folded) {
        throw new Error(`MCP base definition '${base.name}' cannot configure alias '${folded}'.`);
    }
    if (target?.value.length === 0) throw new Error(`${target.key} must not be empty.`);
    const lower = target === undefined ? base : undefined;
    const fields = parsed.companions.get(folded);
    const fieldName = (suffix: CompanionSuffix): string =>
        fields?.get(suffix)?.key ?? `${PREFIX}${folded.toUpperCase()}${suffix.toUpperCase()}`;
    const configuredTools = fields?.get("_tools");
    const inheritedTools = lower?.tools;
    const tools = configuredTools === undefined
        ? structuredClone(inheritedTools)
        : toolNames(configuredTools.value, configuredTools.key);
    const policy = {
        ...(tools === undefined ? {} : { tools }),
        read: fields?.has("_read")
            ? toolNames(fields.get("_read")?.value, fieldName("_read"))
            : structuredClone(lower?.read ?? []),
    };
    const transport = target === undefined
        ? lower?.transport
        : /^https?:\/\//iu.test(target.value) ? "http" : "stdio";
    if (transport === "http") {
        const invalid = (["_args", "_cwd", "_env"] as const)
            .flatMap((suffix) => fields?.get(suffix)?.key ?? []);
        if (invalid.length > 0) {
            throw new Error(
                `${invalid.join(", ")} cannot accompany HTTP MCP server target ${target?.key ?? folded}; transport-neutral _TOOLS/_READ and HTTP _HEADERS are valid.`,
            );
        }
        const inheritedHeaders = lower?.transport === "http"
            ? structuredClone(lower.headers)
            : undefined;
        const headers = fields?.has("_headers")
            ? jsonRecord(fields.get("_headers")?.value, fieldName("_headers"))
            : inheritedHeaders;
        const bearer = fields?.get("_bearer");
        const inheritedAuthorization = lower?.transport === "http"
            ? structuredClone(lower.authorization)
            : undefined;
        const authorization = bearer === undefined
            ? inheritedAuthorization
            : { type: "bearer" as const, token: bearer.value };
        const authorizationHeader = Object.keys(headers ?? {}).find(
            (key) => key.toLowerCase() === "authorization",
        );
        if (authorization?.type === "bearer" && authorizationHeader !== undefined) {
            throw new Error(
                `${bearer?.key ?? "Bearer authorization"} conflicts with Authorization in the server's _HEADERS map.`,
            );
        }
        const url = target?.value ?? (lower?.transport === "http" ? lower.url : undefined);
        if (url === undefined) throw new Error(`HTTP MCP server '${folded}' has no target.`);
        return Validator.assertMcpServerDefinition({
            name: folded,
            transport: "http",
            url,
            ...(headers === undefined ? {} : { headers }),
            ...(authorization === undefined ? {} : { authorization }),
            ...policy,
        });
    }
    const httpOnly = (["_headers", "_bearer"] as const)
        .flatMap((suffix) => fields?.get(suffix)?.key ?? []);
    if (httpOnly.length > 0) {
        throw new Error(
            `${httpOnly.join(", ")} cannot accompany stdio MCP server target ${target?.key ?? folded}.`,
        );
    }
    const inheritedStdio = lower?.transport === "stdio" ? lower : undefined;
    const cwd = fields?.has("_cwd")
        ? fields.get("_cwd")?.value
        : inheritedStdio?.cwd;
    const stdioEnvironment = fields?.has("_env")
        ? jsonRecord(fields.get("_env")?.value, fieldName("_env"))
        : structuredClone(inheritedStdio?.env);
    const args = fields?.has("_args")
        ? jsonStrings(fields.get("_args")?.value, fieldName("_args"))
        : structuredClone(inheritedStdio?.args ?? []);
    const command = target?.value ?? inheritedStdio?.command;
    if (command === undefined) throw new Error(`Stdio MCP server '${folded}' has no target.`);
    return Validator.assertMcpServerDefinition({
        name: folded,
        transport: "stdio",
        command,
        args,
        ...(cwd === undefined ? {} : { cwd }),
        ...(stdioEnvironment === undefined ? {} : { env: stdioEnvironment }),
        ...policy,
    });
};

export const serverDefinition = (
    name: string,
    environ: NodeJS.ProcessEnv = process.env,
): McpServerDefinition | null => definitionFromEnvironment(
    name,
    parseEnvironment(environ),
);

export const overlayServerDefinitions = (
    overlay: McpConfigurationOverlay,
    bases: ReadonlyMap<string, McpServerDefinition> = new Map(),
): Map<string, McpServerDefinition> => {
    const validated = Validator.assertMcpConfigurationOverlay(structuredClone(overlay));
    const parsed = parseEnvironment(validated, true);
    const names = new Set([...parsed.targets.keys(), ...parsed.companions.keys()]);
    return new Map(
        [...names]
            .toSorted()
            .map((name) => {
                const definition = definitionFromEnvironment(name, parsed, bases.get(name));
                if (definition === null) throw new Error(`MCP overlay server '${name}' disappeared.`);
                return [name, definition];
            }),
    );
};

export const serviceDefinitions = (
    environ: NodeJS.ProcessEnv = process.env,
): McpServerDefinition[] => serverNames(environ).map((name) => {
    const definition = serverDefinition(name, environ);
    if (definition === null) throw new Error(`MCP server '${name}' disappeared during configuration.`);
    return definition;
});

// {§mcp-summary-derivation} — authored orientation lines. A _SUMMARY companion
// names either the whole server (PLURNK_MCP_<SERVER>_SUMMARY) or one tool
// (PLURNK_MCP_<SERVER>_<TOOL>_SUMMARY). Values expand ${NAME} references like
// every other companion.
export const summaryOverrides = (
    environ: NodeJS.ProcessEnv = process.env,
): { servers: Map<string, string>; tools: Map<string, string> } => {
    const { targets, companions } = parseEnvironment(environ);
    const servers = new Map<string, string>();
    const tools = new Map<string, string>();
    for (const [name, fields] of companions) {
        const summary = fields.get("_summary");
        if (summary === undefined) continue;
        const value = expandReferences(summary.value, environ, summary.key);
        if (targets.has(name)) {
            servers.set(name, value);
            continue;
        }
        const server = [...targets.keys()].find((target) => name.startsWith(`${target}_`));
        if (server === undefined) {
            throw new Error(`${summary.key} has no MCP server target ${PREFIX}${name.toUpperCase()}.`);
        }
        const tool = name.slice(server.length + 1);
        tools.set(`${server}/${tool}`, value);
    }
    return { servers, tools };
};

export const serviceEnabledNames = (
    environ: NodeJS.ProcessEnv = process.env,
): string[] => {
    const field = `${PREFIX}ENABLED`;
    const configured = jsonStrings(environ[field], field);
    const available = new Set(serverNames(environ));
    const enabled = new Set<string>();
    for (const name of configured) {
        assertServerName(name, field);
        if (!available.has(name)) {
            throw new Error(`${field} contains unknown MCP server '${name}'.`);
        }
        if (enabled.has(name)) {
            throw new Error(`${field} contains duplicate MCP server '${name}'.`);
        }
        enabled.add(name);
    }
    return [...enabled].toSorted();
};

export const connectTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number => {
    const raw = environ.PLURNK_MCP_CONNECT_TIMEOUT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`PLURNK_MCP_CONNECT_TIMEOUT must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

export const requestTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number => {
    const raw = environ.PLURNK_MCP_REQUEST_TIMEOUT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`PLURNK_MCP_REQUEST_TIMEOUT must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};
