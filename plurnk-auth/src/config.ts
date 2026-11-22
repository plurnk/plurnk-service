import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";

export interface ModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly issuer?: string;
    readonly clientId?: string;
    readonly audience?: string;
    readonly callbackUrl?: string;
    readonly scopes?: readonly string[] | string;
    readonly allowedUsers?: readonly string[] | string;
    readonly allowOrigin?: string;
    readonly fetch?: typeof globalThis.fetch;
}

export interface ResolvedModuleOptions {
    readonly authenticates: boolean;
    readonly issuer: string;
    readonly clientId: string;
    readonly audience: string;
    readonly callbackUrl: string;
    readonly scopes: readonly string[];
    readonly allowedUsers: readonly string[];
    readonly allowOrigin: string;
    readonly fetch?: typeof globalThis.fetch;
}

export const isLoopbackHost = (hostname: string): boolean => {
    const lower = hostname.toLowerCase();
    return lower === "127.0.0.1" || lower === "localhost" || lower === "::1" || lower === "[::1]";
};

export const normalizeIssuerUrl = (raw: string, name: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return "";
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new ConfigurationError(name, `${name} must be a valid URL; got ${JSON.stringify(raw)}.`);
    }
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
        throw new ConfigurationError(name, `${name} must not include credentials, query parameters, or fragments; got ${JSON.stringify(raw)}.`);
    }
    const allowedScheme = parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname));
    if (!allowedScheme) {
        throw new ConfigurationError(name, `${name} must use https:// (or loopback http:// for local testing); got ${JSON.stringify(raw)}.`);
    }
    if (trimmed.endsWith("/")) {
        return `${parsed.origin}${parsed.pathname}`;
    }
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
};

const normalizeCallbackUrl = (raw: string, name: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return "";
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new ConfigurationError(name, `${name} must be a valid http(s) URL; got ${JSON.stringify(raw)}.`);
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
        throw new ConfigurationError(name, `${name} must be an http(s) URL without credentials or fragment; got ${JSON.stringify(raw)}.`);
    }
    return parsed.href;
};

const normalizeAllowOrigin = (raw: string, name: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "*") return trimmed;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new ConfigurationError(name, `${name} must be empty, "*", or a single http(s) origin; got ${JSON.stringify(raw)}.`);
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== trimmed) {
        throw new ConfigurationError(name, `${name} must be empty, "*", or a single http(s) origin; got ${JSON.stringify(raw)}.`);
    }
    return parsed.origin;
};

const readStringOption = (
    options: ModuleOptions,
    env: NodeJS.ProcessEnv,
    option: "issuer" | "clientId" | "audience" | "callbackUrl" | "allowOrigin",
    key: string,
): string => {
    const explicit = options[option];
    if (explicit === undefined) return Knob.text(key, env);
    if (typeof explicit !== "string") {
        throw new ConfigurationError(key, `ModuleOptions.${option} must be a string; got ${JSON.stringify(explicit)}.`);
    }
    return explicit;
};

const parseScopes = (raw: readonly string[] | string): readonly string[] => {
    const items = typeof raw === "string"
        ? raw.split(/[\s,]+/u)
        : Array.isArray(raw) && raw.every((item): item is string => typeof item === "string")
            ? raw.flatMap((item) => item.split(/[\s,]+/u))
            : null;
    if (items === null) {
        throw new ConfigurationError("PLURNK_AUTH_SCOPES", `PLURNK_AUTH_SCOPES must be a string or string array; got ${JSON.stringify(raw)}.`);
    }
    return Object.freeze([...new Set(items.map((s) => s.trim()).filter((s) => s.length > 0))]);
};

const parseUsers = (raw: readonly string[] | string): readonly string[] => {
    const items = typeof raw === "string"
        ? raw.split(",")
        : Array.isArray(raw) && raw.every((item): item is string => typeof item === "string")
            ? raw
            : null;
    if (items === null) {
        throw new ConfigurationError("PLURNK_AUTH_USERS", `PLURNK_AUTH_USERS must be a comma-separated string or string array; got ${JSON.stringify(raw)}.`);
    }
    return Object.freeze([...new Set(items.map((u) => u.trim()).filter((u) => u.length > 0))]);
};

// {§auth-configuration} — reads and validates the OIDC resource server configuration from the assembled floor.
export const resolveModuleOptions = (options: ModuleOptions = {}): ResolvedModuleOptions => {
    const env = options.env === undefined ? process.env : options.env;
    const issuerName = options.issuer === undefined ? "PLURNK_AUTH_ISSUER" : "ModuleOptions.issuer";
    const callbackName = options.callbackUrl === undefined ? "PLURNK_AUTH_CALLBACK" : "ModuleOptions.callbackUrl";
    const allowOriginName = options.allowOrigin === undefined ? "PLURNK_AUTH_ALLOW_ORIGIN" : "ModuleOptions.allowOrigin";

    const issuer = normalizeIssuerUrl(readStringOption(options, env, "issuer", "PLURNK_AUTH_ISSUER"), issuerName);
    const clientId = readStringOption(options, env, "clientId", "PLURNK_AUTH_CLIENT_ID").trim();
    const explicitAudience = readStringOption(options, env, "audience", "PLURNK_AUTH_AUDIENCE").trim();
    const audience = explicitAudience.length > 0 ? explicitAudience : clientId;
    const callbackUrl = normalizeCallbackUrl(readStringOption(options, env, "callbackUrl", "PLURNK_AUTH_CALLBACK"), callbackName);
    const scopes = parseScopes(options.scopes === undefined ? Knob.text("PLURNK_AUTH_SCOPES", env) : options.scopes);
    const allowedUsers = parseUsers(options.allowedUsers === undefined ? Knob.text("PLURNK_AUTH_USERS", env) : options.allowedUsers);
    const allowOrigin = normalizeAllowOrigin(readStringOption(options, env, "allowOrigin", "PLURNK_AUTH_ALLOW_ORIGIN"), allowOriginName);

    return {
        authenticates: issuer.length > 0,
        issuer,
        clientId,
        audience,
        callbackUrl,
        scopes,
        allowedUsers,
        allowOrigin,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    };
};
