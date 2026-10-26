import { isSafeInteger } from "@plurnk/plurnk-contracts";

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

const parsePositiveSafeInt = (key: string, raw: string | undefined, floor: number): number => {
    if (raw === undefined) return floor;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`${key} must be a positive safe integer; received '${raw}'`);
    }
    const n = Number(trimmed);
    if (!isSafeInteger(n) || n <= 0) {
        throw new Error(`${key} must be a positive safe integer; received '${raw}'`);
    }
    return n;
};

const parseHeartbeatMs = (raw: string | undefined, floor: number): number => {
    if (raw === undefined) return floor;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`PLURNK_ACP_HEARTBEAT_MS must be a safe integer in 0..2147483647; received '${raw}'`);
    }
    const n = Number(trimmed);
    if (!isSafeInteger(n) || n < 0 || n > 2147483647) {
        throw new Error(`PLURNK_ACP_HEARTBEAT_MS must be a safe integer in 0..2147483647; received '${raw}'`);
    }
    return n;
};

const parseMaxTurns = (raw: string | undefined, floor: number | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return floor;
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
        throw new Error(`PLURNK_ACP_MAX_TURNS must be -1 or a non-negative safe integer; received '${raw}'`);
    }
    const n = Number(trimmed);
    if (!isSafeInteger(n) || n < -1) {
        throw new Error(`PLURNK_ACP_MAX_TURNS must be -1 or a non-negative safe integer; received '${raw}'`);
    }
    return n;
};

const parseAllowOrigin = (raw: string | undefined, floor: string): string => raw ?? floor;

export const resolveModuleOptions = (opts: ModuleOptions = {}): ResolvedModuleOptions => {
    const env = opts.env ?? process.env;
    const allowOrigin = opts.allowOrigin ?? parseAllowOrigin(env.PLURNK_ACP_ALLOW_ORIGIN, "*");
    const maxTurns = opts.maxTurns ?? parseMaxTurns(env.PLURNK_ACP_MAX_TURNS, undefined);
    const heartbeatMs = opts.heartbeatMs ?? parseHeartbeatMs(env.PLURNK_ACP_HEARTBEAT_MS, 15000);
    const historyLoops = opts.historyLoops ?? parsePositiveSafeInt("PLURNK_ACP_HISTORY_LOOPS", env.PLURNK_ACP_HISTORY_LOOPS, 2);
    const historyPageChars = opts.historyPageChars ?? parsePositiveSafeInt("PLURNK_ACP_HISTORY_PAGE_CHARS", env.PLURNK_ACP_HISTORY_PAGE_CHARS, 2000000);
    const excerptChars = opts.excerptChars ?? parsePositiveSafeInt("PLURNK_ACP_EXCERPT_CHARS", env.PLURNK_ACP_EXCERPT_CHARS, 240);
    const overviewSessions = opts.overviewSessions ?? parsePositiveSafeInt("PLURNK_ACP_OVERVIEW_SESSIONS", env.PLURNK_ACP_OVERVIEW_SESSIONS, 200);
    return {
        allowOrigin,
        maxTurns,
        heartbeatMs,
        historyLoops,
        historyPageChars,
        excerptChars,
        overviewSessions,
    };
};
