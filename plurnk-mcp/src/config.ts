const PREFIX = "PLURNK_MCP_";
const COMPANION_SUFFIXES = ["_args", "_cwd", "_env", "_headers"] as const;
const CONTROL_KEYS = new Set(["connect_timeout", "request_timeout"]);
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface StdioServerConfig {
    readonly transport: "stdio";
    readonly command: string;
    readonly args: string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
}

export interface HttpServerConfig {
    readonly transport: "http";
    readonly url: string;
    readonly headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

interface ParsedEnvironment {
    readonly targets: Map<string, string>;
    readonly companions: Map<string, Map<string, string>>;
}

const parseEnvironment = (environ: NodeJS.ProcessEnv): ParsedEnvironment => {
    const targets = new Map<string, string>();
    const companions = new Map<string, Map<string, string>>();
    for (const [key, value] of Object.entries(environ)) {
        if (value === undefined || !key.startsWith(PREFIX)) continue;
        const suffix = key.slice(PREFIX.length);
        if (suffix.length === 0) continue;
        const folded = suffix.toLowerCase();
        if (CONTROL_KEYS.has(folded)) continue;
        const companion = COMPANION_SUFFIXES.find((candidate) => folded.endsWith(candidate));
        if (companion !== undefined) {
            const name = folded.slice(0, -companion.length);
            const bySuffix = companions.get(name) ?? new Map<string, string>();
            if (bySuffix.has(companion)) {
                throw new Error(`Duplicate MCP server companion for '${name}${companion}'.`);
            }
            bySuffix.set(companion, value);
            companions.set(name, bySuffix);
            continue;
        }
        if (targets.has(folded)) {
            throw new Error(`Duplicate MCP server '${folded}': multiple ${PREFIX}* keys case-fold to the same name.`);
        }
        targets.set(folded, value);
    }
    for (const name of companions.keys()) {
        if (!targets.has(name)) throw new Error(`MCP server companion '${name}' has no ${PREFIX}<server> target.`);
    }
    return { targets, companions };
};

const expandReferences = (value: string, environ: NodeJS.ProcessEnv, field: string): string =>
    value.replaceAll(ENV_REFERENCE, (_match, name: string) => {
        const resolved = environ[name];
        if (resolved === undefined) throw new Error(`${field} references missing environment variable ${name}.`);
        return resolved;
    });

const jsonStrings = (
    raw: string | undefined,
    field: string,
    environ: NodeJS.ProcessEnv,
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
    return parsed.map((value) => expandReferences(value, environ, field));
};

const jsonRecord = (
    raw: string | undefined,
    field: string,
    environ: NodeJS.ProcessEnv,
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
    return Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [
            key,
            expandReferences(value as string, environ, field),
        ]),
    );
};

export const serverNames = (environ: NodeJS.ProcessEnv = process.env): string[] =>
    [...parseEnvironment(environ).targets.keys()].toSorted();

export const serverConfig = (
    name: string,
    environ: NodeJS.ProcessEnv = process.env,
): ServerConfig | null => {
    const { targets, companions } = parseEnvironment(environ);
    const folded = name.toLowerCase();
    const target = targets.get(folded);
    if (target === undefined) return null;
    if (target.length === 0) throw new Error(`${PREFIX}${folded} must not be empty.`);
    const fields = companions.get(folded);
    const fieldName = (suffix: string): string => `${PREFIX}${folded.toUpperCase()}${suffix.toUpperCase()}`;
    if (/^https?:\/\//i.test(target)) {
        if (fields?.has("_args") || fields?.has("_cwd") || fields?.has("_env")) {
            throw new Error(`HTTP MCP server '${folded}' may declare only a _HEADERS companion.`);
        }
        return {
            transport: "http",
            url: target,
            headers: jsonRecord(fields?.get("_headers"), fieldName("_headers"), environ),
        };
    }
    if (/\s/.test(target)) {
        throw new Error(`${PREFIX}${folded} must contain one executable; put arguments in ${fieldName("_args")}.`);
    }
    if (fields?.has("_headers")) {
        throw new Error(`stdio MCP server '${folded}' may not declare a _HEADERS companion.`);
    }
    return {
        transport: "stdio",
        command: target,
        args: jsonStrings(fields?.get("_args"), fieldName("_args"), environ),
        cwd: fields?.has("_cwd")
            ? expandReferences(fields.get("_cwd")!, environ, fieldName("_cwd"))
            : undefined,
        env: jsonRecord(fields?.get("_env"), fieldName("_env"), environ),
    };
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
