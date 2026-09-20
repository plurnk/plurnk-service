// {§exec-lifetime} — how long a spawn may live, stated once in the fence's metadata. A duration
// bounds it (504 at the deadline); `loop` — the default, and what absence means — ends it with the
// loop; `turn` ends it at the worker's next pre-turn; `detached` outlives the loop and is nobody's
// obligation. Cadence is not here and is not the model's: the daemon's backoff observes an open
// stream, and a recurring check on the calendar is a schedule.
const DURATION = /^([1-9]\d*)(s|m|h)$/u;
const PER_UNIT = { s: 1, m: 60, h: 3600 } as const;

export interface ExecLifetime {
    readonly timeoutSec?: number;
    readonly turnScoped?: boolean;
    readonly detached?: boolean;
}

export const LIFETIME_SYNTAX = 'a duration ("30s", "30m", "2h"), or "loop", "turn", or "detached"';

// The authored form of a bounded lifetime, for the deadline's own Problem.
export const formatLifetime = (seconds: number): string =>
    seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;

// An absent field is the loop-bound default. A value that is neither a duration nor one of the
// three words is refused by the caller with its own source.
export const parseExecLifetime = (raw: unknown): ExecLifetime | { readonly invalid: string } => {
    if (raw === undefined) return {};
    if (typeof raw !== "string") return { invalid: `A lifetime is ${LIFETIME_SYNTAX}.` };
    if (raw === "loop") return {};
    if (raw === "turn") return { turnScoped: true };
    if (raw === "detached") return { detached: true };
    const duration = DURATION.exec(raw);
    if (duration === null) return { invalid: `'${raw}' is not a lifetime; state ${LIFETIME_SYNTAX}.` };
    return { timeoutSec: Number(duration[1]) * PER_UNIT[duration[2] as keyof typeof PER_UNIT] };
};
