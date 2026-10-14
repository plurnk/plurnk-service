import { MAX_TIMER_MS } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";

/** {§agui-oauth-authority} The resources a credential of this daemon may name: the client interface, and the A2A exposure. */
export const SCOPES: readonly string[] = Object.freeze(["agui", "a2a"]);

/** {§agui-oauth-clients} A confidential client the operator declared: its secret and the scopes it may hold. */
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
    readonly loginAttempts?: number;
    readonly loginWindowSec?: number;
    readonly clients?: Readonly<Record<string, DeclaredClient>>;
    readonly allowOrigin?: string;
    readonly maxTurns?: number;
    readonly heartbeatMs?: number;
    readonly env?: NodeJS.ProcessEnv;
}

export interface ResolvedModuleOptions {
    /** {§agui-oauth} The daemon authenticates when `PLURNK_AUTH` says so, never by inference. */
    readonly authenticates: boolean;
    readonly issuer: string;
    readonly password: string;
    readonly accessTtlSec: number;
    readonly refreshTtlSec: number;
    readonly loginAttempts: number;
    readonly loginWindowSec: number;
    readonly clients: Readonly<Record<string, DeclaredClient>>;
    readonly allowOrigin: string;
    readonly maxTurns?: number;
    readonly heartbeatMs: number;
}

const CLIENT_KEY = /^PLURNK_AGUI_CLIENT_([A-Za-z0-9._-]+)$/u;
// The operator's own built-in client, which their tools use with PLURNK_SECRET ({§agui-oauth-clients}).
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

const environmentMaxTurns = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw === "") return undefined;
    return safeInteger(raw, "PLURNK_AGUI_MAX_TURNS", -1);
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
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${key} must be a JSON object.`);
    const { secret, scopes } = parsed as { secret?: unknown; scopes?: unknown };
    if (typeof secret !== "string" || secret.length === 0) throw new Error(`${key} needs a non-empty "secret".`);
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || !SCOPES.includes(scope))) {
        throw new Error(`${key} needs "scopes", a non-empty array from ${JSON.stringify(SCOPES)}.`);
    }
    return { secret, scopes: Object.freeze([...new Set(scopes as string[])]) };
};

// {§agui-oauth-clients} — every PLURNK_AGUI_CLIENT_<id> line declares one confidential client.
const environmentClients = (env: NodeJS.ProcessEnv): Readonly<Record<string, DeclaredClient>> => {
    const clients: Record<string, DeclaredClient> = {};
    for (const [key, raw] of Object.entries(env)) {
        const match = CLIENT_KEY.exec(key);
        if (match === null || raw === undefined) continue;
        const id = match[1]!;
        if (id === OPERATOR_CLIENT) throw new Error(`${key}: "${OPERATOR_CLIENT}" is the operator's own client; declare another id.`);
        clients[id] = readClient(key, raw);
    }
    return Object.freeze(clients);
};

export const resolveModuleOptions = (options: ModuleOptions): ResolvedModuleOptions => {
    const env = options.env === undefined ? process.env : options.env;
    const number = (option: "accessTtlSec" | "refreshTtlSec" | "loginAttempts" | "loginWindowSec", key: string, minimum: number, maximum?: number): number =>
        safeInteger(options[option] === undefined ? env[key] : options[option], options[option] === undefined ? key : `ModuleOptions.${option}`, minimum, maximum);
    const clients = options.clients === undefined ? environmentClients(env) : options.clients;
    for (const [id, client] of Object.entries(clients)) {
        if (id === OPERATOR_CLIENT || !CLIENT_KEY.test(`PLURNK_AGUI_CLIENT_${id}`)) throw new Error(`ModuleOptions.clients: "${id}" is not a client id.`);
        readClient(`ModuleOptions.clients.${id}`, JSON.stringify(client));
    }
    if (options.auth !== undefined && typeof options.auth !== "boolean") throw new Error(`ModuleOptions.auth must be a boolean; got ${JSON.stringify(options.auth)}.`);
    return {
        // {§credential-authority} — the posture is the shared panel's PLURNK_AUTH, never an inference.
        authenticates: options.auth === undefined ? Knob.flag("PLURNK_AUTH", env) : options.auth,
        issuer: floorString(options, env, "issuer", "PLURNK_AGUI_ISSUER"),
        password: floorString(options, env, "password", "PLURNK_PASS"),
        accessTtlSec: number("accessTtlSec", "PLURNK_AGUI_ACCESS_TTL_SEC", 1),
        refreshTtlSec: number("refreshTtlSec", "PLURNK_AGUI_REFRESH_TTL_SEC", 1),
        loginAttempts: number("loginAttempts", "PLURNK_AGUI_LOGIN_ATTEMPTS", 0),
        loginWindowSec: number("loginWindowSec", "PLURNK_AGUI_LOGIN_WINDOW_SEC", 1, Math.floor(MAX_TIMER_MS / 1000)),
        clients,
        // {§agui-cors} — the panel states the origin; only its own empty value sends no CORS header.
        allowOrigin: floorString(options, env, "allowOrigin", "PLURNK_AGUI_ALLOW_ORIGIN"),
        maxTurns: options.maxTurns === undefined
            ? environmentMaxTurns(env.PLURNK_AGUI_MAX_TURNS)
            : safeInteger(options.maxTurns, "ModuleOptions.maxTurns", -1),
        heartbeatMs: safeInteger(
            options.heartbeatMs === undefined ? env.PLURNK_AGUI_HEARTBEAT_MS : options.heartbeatMs,
            options.heartbeatMs === undefined ? "PLURNK_AGUI_HEARTBEAT_MS" : "ModuleOptions.heartbeatMs",
            0,
            MAX_TIMER_MS,
        ),
    };
};
