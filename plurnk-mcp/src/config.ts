import {
    Validator,
    type McpServerDefinition,
} from "@plurnk/plurnk-contracts";

const PREFIX = "PLURNK_MCP_";
const COMPANION_SUFFIXES = [
    "_bearer",
    "_args",
    "_cwd",
    "_env",
    "_headers",
    "_tools",
    "_read",
] as const;
const CONTROL_KEYS = new Map([
    ["connect_timeout", `${PREFIX}CONNECT_TIMEOUT`],
    ["request_timeout", `${PREFIX}REQUEST_TIMEOUT`],
]);
const SERVER_NAME = /^[a-z][a-z0-9-]*$/;
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

const parseEnvironment = (environ: NodeJS.ProcessEnv): ParsedEnvironment => {
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
            assertServerName(name, key);
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
    for (const [name, fields] of companions) {
        if (targets.has(name)) continue;
        const variables = [...fields.values()].map(({ key }) => key).join(", ");
        throw new Error(
            `${variables} has no MCP server target ${PREFIX}${name.toUpperCase()}.`,
        );
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

export const serverDefinition = (
    name: string,
    environ: NodeJS.ProcessEnv = process.env,
): McpServerDefinition | null => {
    const { targets, companions } = parseEnvironment(environ);
    const folded = name.toLowerCase();
    const target = targets.get(folded);
    if (target === undefined) return null;
    if (target.value.length === 0) throw new Error(`${target.key} must not be empty.`);
    const fields = companions.get(folded);
    const fieldName = (suffix: CompanionSuffix): string =>
        fields?.get(suffix)?.key ?? `${PREFIX}${folded.toUpperCase()}${suffix.toUpperCase()}`;
    const configuredTools = fields?.get("_tools");
    const policy = {
        ...(configuredTools === undefined
            ? {}
            : { tools: toolNames(configuredTools.value, configuredTools.key) }),
        read: toolNames(fields?.get("_read")?.value, fieldName("_read")),
    };
    if (/^https?:\/\//i.test(target.value)) {
        const invalid = (["_args", "_cwd", "_env"] as const)
            .flatMap((suffix) => fields?.get(suffix)?.key ?? []);
        if (invalid.length > 0) {
            throw new Error(
                `${invalid.join(", ")} cannot accompany HTTP MCP server target ${target.key}; transport-neutral _TOOLS/_READ and HTTP _HEADERS are valid.`,
            );
        }
        const headers = jsonRecord(
            fields?.get("_headers")?.value,
            fieldName("_headers"),
        );
        const bearer = fields?.get("_bearer");
        const authorizationHeader = Object.keys(headers ?? {}).find(
            (key) => key.toLowerCase() === "authorization",
        );
        if (bearer !== undefined && authorizationHeader !== undefined) {
            throw new Error(
                `${bearer.key} conflicts with Authorization in the server's _HEADERS map.`,
            );
        }
        return Validator.assertMcpServerDefinition({
            name: folded,
            transport: "http",
            url: target.value,
            ...(headers === undefined ? {} : { headers }),
            ...(bearer === undefined
                ? {}
                : { authorization: { type: "bearer" as const, token: bearer.value } }),
            ...policy,
        });
    }
    const httpOnly = (["_headers", "_bearer"] as const)
        .flatMap((suffix) => fields?.get(suffix)?.key ?? []);
    if (httpOnly.length > 0) {
        throw new Error(
            `${httpOnly.join(", ")} cannot accompany stdio MCP server target ${target.key}.`,
        );
    }
    const cwd = fields?.get("_cwd")?.value;
    const stdioEnvironment = jsonRecord(fields?.get("_env")?.value, fieldName("_env"));
    return Validator.assertMcpServerDefinition({
        name: folded,
        transport: "stdio",
        command: target.value,
        args: jsonStrings(fields?.get("_args")?.value, fieldName("_args")),
        ...(cwd === undefined ? {} : { cwd }),
        ...(stdioEnvironment === undefined ? {} : { env: stdioEnvironment }),
        ...policy,
    });
};

export const serviceDefinitions = (
    environ: NodeJS.ProcessEnv = process.env,
): McpServerDefinition[] => serverNames(environ).map((name) => {
    const definition = serverDefinition(name, environ);
    if (definition === null) throw new Error(`MCP server '${name}' disappeared during configuration.`);
    return definition;
});

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
