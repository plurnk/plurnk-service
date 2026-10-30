import { MAX_TIMER_MS } from "@plurnk/plurnk-contracts";

export interface ModuleOptions {
    readonly allowOrigin?: string;
    readonly maxTurns?: number;
    readonly heartbeatMs?: number;
    readonly historyLoops?: number;
    readonly historyPageChars?: number;
    readonly excerptChars?: number;
    readonly overviewSessions?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedModuleOptions {
    readonly allowOrigin: string;
    readonly maxTurns: number | undefined;
    readonly heartbeatMs: number;
    readonly historyLoops: number;
    readonly historyPageChars: number;
    readonly excerptChars: number;
    readonly overviewSessions: number;
}

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
    return safeInteger(raw, "PLURNK_ACP_MAX_TURNS", -1);
};

// {§operator-config-precedence} — an absent key is a broken floor; only the panel's own value speaks.
const floorString = (
    options: ModuleOptions,
    env: Readonly<Record<string, string | undefined>>,
    option: keyof ModuleOptions,
    key: string,
): string => {
    const explicit = options[option];
    const value = explicit === undefined ? env[key] : explicit;
    if (value === undefined) throw new Error(`${key} is missing from the assembled environment floor.`);
    if (typeof value !== "string") throw new Error(`ModuleOptions.${option} must be a string; got ${JSON.stringify(value)}.`);
    return value;
};

export const resolveModuleOptions = (options: ModuleOptions = {}): ResolvedModuleOptions => {
    const env = options.env === undefined ? process.env : { ...process.env, ...options.env };
    const number = (
        option: "historyLoops" | "historyPageChars" | "excerptChars" | "overviewSessions",
        key: string,
        minimum: number,
    ): number =>
        safeInteger(
            options[option] === undefined ? env[key] : options[option],
            options[option] === undefined ? key : `ModuleOptions.${option}`,
            minimum,
        );
    return {
        allowOrigin: floorString(options, env, "allowOrigin", "PLURNK_ACP_ALLOW_ORIGIN"),
        maxTurns:
            options.maxTurns === undefined
                ? environmentMaxTurns(env.PLURNK_ACP_MAX_TURNS)
                : safeInteger(options.maxTurns, "ModuleOptions.maxTurns", -1),
        heartbeatMs: safeInteger(
            options.heartbeatMs === undefined ? env.PLURNK_ACP_HEARTBEAT_MS : options.heartbeatMs,
            options.heartbeatMs === undefined ? "PLURNK_ACP_HEARTBEAT_MS" : "ModuleOptions.heartbeatMs",
            0,
            MAX_TIMER_MS,
        ),
        historyLoops: number("historyLoops", "PLURNK_ACP_HISTORY_LOOPS", 1),
        historyPageChars: number("historyPageChars", "PLURNK_ACP_HISTORY_PAGE_CHARS", 1),
        excerptChars: number("excerptChars", "PLURNK_ACP_EXCERPT_CHARS", 1),
        overviewSessions: number("overviewSessions", "PLURNK_ACP_OVERVIEW_SESSIONS", 1),
    };
};
