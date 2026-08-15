const PREFIX = "PLURNK_MCP_";
const COMPANION_SUFFIXES = ["_args", "_cwd", "_env", "_headers"] as const;
const CONTROL_KEYS = new Map([
    ["connect_timeout", `${PREFIX}CONNECT_TIMEOUT`],
    ["request_timeout", `${PREFIX}REQUEST_TIMEOUT`],
]);
const SERVER_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type CompanionSuffix = typeof COMPANION_SUFFIXES[number];

interface EnvironmentVariable {
    readonly key: string;
    readonly value: string;
}

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
    if (target.value.length === 0) throw new Error(`${target.key} must not be empty.`);
    const fields = companions.get(folded);
    const fieldName = (suffix: CompanionSuffix): string =>
        fields?.get(suffix)?.key ?? `${PREFIX}${folded.toUpperCase()}${suffix.toUpperCase()}`;
    if (/^https?:\/\//i.test(target.value)) {
        const invalid = (["_args", "_cwd", "_env"] as const)
            .flatMap((suffix) => fields?.get(suffix)?.key ?? []);
        if (invalid.length > 0) {
            throw new Error(
                `${invalid.join(", ")} cannot accompany HTTP MCP server target ${target.key}; only _HEADERS is valid.`,
            );
        }
        return {
            transport: "http",
            url: target.value,
            headers: jsonRecord(fields?.get("_headers")?.value, fieldName("_headers"), environ),
        };
    }
    const headers = fields?.get("_headers");
    if (headers !== undefined) {
        throw new Error(
            `${headers.key} cannot accompany stdio MCP server target ${target.key}.`,
        );
    }
    return {
        transport: "stdio",
        command: target.value,
        args: jsonStrings(fields?.get("_args")?.value, fieldName("_args"), environ),
        cwd: fields?.has("_cwd")
            ? expandReferences(fields.get("_cwd")!.value, environ, fieldName("_cwd"))
            : undefined,
        env: jsonRecord(fields?.get("_env")?.value, fieldName("_env"), environ),
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
