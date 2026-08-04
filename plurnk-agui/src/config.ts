export interface ModuleOptions {
    readonly host: string;
    readonly port: number;
    readonly token?: string;
    readonly maxTurns?: number;
    readonly heartbeatMs?: number;
    readonly env?: NodeJS.ProcessEnv;
}

export interface ResolvedModuleOptions {
    readonly host: string;
    readonly port: number;
    readonly token: string;
    readonly maxTurns?: number;
    readonly heartbeatMs: number;
}

const MAX_TIMER_MS = 2_147_483_647;

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

export const resolveModuleOptions = (options: ModuleOptions): ResolvedModuleOptions => {
    const env = options.env === undefined ? process.env : options.env;
    const token = options.token === undefined ? env.PLURNK_AGUI_TOKEN ?? "" : options.token;
    if (typeof token !== "string") {
        throw new Error(`ModuleOptions.token must be a string; got ${JSON.stringify(token)}.`);
    }
    return {
        host: options.host,
        port: options.port,
        token,
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
