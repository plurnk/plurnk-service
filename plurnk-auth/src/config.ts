import { isRecord } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";

/** {§auth-oauth-authority} The resources a credential of this daemon may name: the ACP interface and the A2A exposure. */
export const SCOPES: readonly string[] = Object.freeze(["acp", "a2a"]);

/** {§auth-oauth-clients} A confidential client the operator declared: its secret and the scopes it may hold. */
export interface DeclaredClient {
    readonly secret: string;
    readonly scopes: readonly string[];
}

export interface ModuleOptions {
    /** {§credential-authority} The daemon's posture, `PLURNK_AUTH`: authenticate, or admit anonymously. */
    readonly auth?: boolean;
    readonly issuer?: string;
    readonly password?: string;
    readonly accessTtlSec?: number;
    readonly refreshTtlSec?: number;
    readonly clients?: Readonly<Record<string, DeclaredClient>>;
    readonly allowOrigin?: string;
    readonly env?: NodeJS.ProcessEnv;
}

export interface ResolvedModuleOptions {
    /** {§auth-oauth} The daemon authenticates when `PLURNK_AUTH` says so, never by inference. */
    readonly authenticates: boolean;
    readonly issuer: string;
    readonly password: string;
    readonly accessTtlSec: number;
    readonly refreshTtlSec: number;
    readonly clients: Readonly<Record<string, DeclaredClient>>;
    readonly allowOrigin: string;
}

const CLIENT_KEY = /^PLURNK_AUTH_CLIENT_([A-Za-z0-9._-]+)$/u;
// The operator's own built-in client, which their tools use with PLURNK_SECRET ({§auth-oauth-clients}).
export const OPERATOR_CLIENT = "operator";

const safeInteger = (
    raw: unknown,
    name: string,
    minimum: number,
    maximum: number = Number.MAX_SAFE_INTEGER,
): number => {
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.length > 0 ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be a safe integer from ${minimum} through ${maximum}; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

// {§operator-config-only-home} — an absent key is a broken floor; only the panel's own value speaks.
const floorString = (options: ModuleOptions, env: NodeJS.ProcessEnv, option: keyof ModuleOptions, key: string): string => {
    const explicit = options[option];
    const value = explicit === undefined ? env[key] : explicit;
    if (value === undefined) throw new Error(`${key} is missing from the assembled environment floor.`);
    if (typeof value !== "string") throw new Error(`ModuleOptions.${option} must be a string; got ${JSON.stringify(value)}.`);
    return value;
};

const readClient = (key: string, raw: string): DeclaredClient => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${key} must be a JSON object; got ${JSON.stringify(raw)}.`); }
    if (!isRecord(parsed)) throw new Error(`${key} must be a JSON object.`);
    const { secret, scopes } = parsed;
    if (typeof secret !== "string" || secret.length === 0) throw new Error(`${key} needs a non-empty "secret".`);
    if (!Array.isArray(scopes) || scopes.length === 0
        || !scopes.every((scope): scope is string => typeof scope === "string" && SCOPES.includes(scope))) {
        throw new Error(`${key} needs "scopes", a non-empty array from ${JSON.stringify(SCOPES)}.`);
    }
    return { secret, scopes: Object.freeze([...new Set(scopes)]) };
};

// {§auth-oauth-clients} — every PLURNK_AUTH_CLIENT_<id> line declares one confidential client.
const environmentClients = (env: NodeJS.ProcessEnv): Readonly<Record<string, DeclaredClient>> => {
    const clients: Record<string, DeclaredClient> = {};
    for (const [key, raw] of Object.entries(env)) {
        const match = CLIENT_KEY.exec(key);
        if (match === null || raw === undefined) continue;
        const id = match[1];
        if (id === OPERATOR_CLIENT) throw new Error(`${key}: "${OPERATOR_CLIENT}" is the operator's own client; declare another id.`);
        clients[id] = readClient(key, raw);
    }
    return Object.freeze(clients);
};

// {§auth-configuration} — reads and validates the authorization server's configuration from the assembled floor.
export const resolveModuleOptions = (options: ModuleOptions): ResolvedModuleOptions => {
    const env = options.env === undefined ? process.env : options.env;
    const number = (option: "accessTtlSec" | "refreshTtlSec", key: string, minimum: number): number =>
        safeInteger(options[option] === undefined ? env[key] : options[option], options[option] === undefined ? key : `ModuleOptions.${option}`, minimum);
    const clients = options.clients === undefined ? environmentClients(env) : options.clients;
    for (const [id, client] of Object.entries(clients)) {
        if (id === OPERATOR_CLIENT || !CLIENT_KEY.test(`PLURNK_AUTH_CLIENT_${id}`)) throw new Error(`ModuleOptions.clients: "${id}" is not a client id.`);
        readClient(`ModuleOptions.clients.${id}`, JSON.stringify(client));
    }
    if (options.auth !== undefined && typeof options.auth !== "boolean") throw new Error(`ModuleOptions.auth must be a boolean; got ${JSON.stringify(options.auth)}.`);
    return {
        // {§credential-authority} — the posture is the shared panel's PLURNK_AUTH, never an inference.
        authenticates: options.auth === undefined ? Knob.flag("PLURNK_AUTH", env) : options.auth,
        issuer: floorString(options, env, "issuer", "PLURNK_AUTH_ISSUER"),
        password: floorString(options, env, "password", "PLURNK_PASS"),
        accessTtlSec: number("accessTtlSec", "PLURNK_AUTH_ACCESS_TTL_SEC", 1),
        refreshTtlSec: number("refreshTtlSec", "PLURNK_AUTH_REFRESH_TTL_SEC", 1),
        clients,
        // {§auth-cors} — the panel states the origin; only its own empty value sends no CORS header.
        allowOrigin: floorString(options, env, "allowOrigin", "PLURNK_AUTH_ALLOW_ORIGIN"),
    };
};
