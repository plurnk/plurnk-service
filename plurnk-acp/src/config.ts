import { MAX_TIMER_MS } from "@plurnk/plurnk-contracts";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";

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

const parseHeartbeatMs = (env: Readonly<Record<string, string | undefined>>): number => {
    const n = Knob.integer("PLURNK_ACP_HEARTBEAT_MS", 0, env);
    if (n > MAX_TIMER_MS) {
        throw new ConfigurationError(
            "PLURNK_ACP_HEARTBEAT_MS",
            `PLURNK_ACP_HEARTBEAT_MS must be a safe integer in 0..${MAX_TIMER_MS}; got ${JSON.stringify(env.PLURNK_ACP_HEARTBEAT_MS)}.`,
        );
    }
    return n;
};

export const resolveModuleOptions = (opts: ModuleOptions = {}): ResolvedModuleOptions => {
    const env = opts.env === undefined ? process.env : { ...process.env, ...opts.env };
    const allowOrigin = opts.allowOrigin ?? Knob.text("PLURNK_ACP_ALLOW_ORIGIN", env);
    const maxTurns = opts.maxTurns ?? (Knob.optionalInteger("PLURNK_ACP_MAX_TURNS", -1, env) ?? undefined);
    const heartbeatMs = opts.heartbeatMs ?? parseHeartbeatMs(env);
    const historyLoops = opts.historyLoops ?? Knob.integer("PLURNK_ACP_HISTORY_LOOPS", 1, env);
    const historyPageChars = opts.historyPageChars ?? Knob.integer("PLURNK_ACP_HISTORY_PAGE_CHARS", 1, env);
    const excerptChars = opts.excerptChars ?? Knob.integer("PLURNK_ACP_EXCERPT_CHARS", 1, env);
    const overviewSessions = opts.overviewSessions ?? Knob.integer("PLURNK_ACP_OVERVIEW_SESSIONS", 1, env);
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
