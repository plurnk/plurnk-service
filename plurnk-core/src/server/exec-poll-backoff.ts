// #521 (§exec-poll, owner-ruled) — the exponential backoff schedule for a parked exec stream with
// no explicit `<,P>` cadence. Wake N fires at base·2^min(N, turns-1) seconds — doubling for `turns`
// steps, then holding at the cap forever (never reverts to blind). Pure so the curve is testable
// without racing a real timer.
export const execPollBackoffMs = (step: number, baseSec: number, turns: number): number =>
    baseSec * 2 ** Math.min(Math.max(step, 0), Math.max(turns - 1, 0)) * 1000;
