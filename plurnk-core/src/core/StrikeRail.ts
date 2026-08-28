import type { PlurnkStatement, TextLineMarker } from "@plurnk/plurnk-contracts";
import { renderTarget } from "./plurnk-uri.ts";

// Operation outcome statuses that do not accumulate strikes. Exploratory misses are
// not failures: probing a path that doesn't exist (404), a line
// range that doesn't exist (416), or a capability a scheme lacks (501) is how discovery
// works — striking them prices caution into the motions we most want (range-reads ARE
// the surgical behavior under budget pressure). One simple set, evenly applied.
// 409 is SOFT here because Engine accounts for a refused final disposition
// through steerStruck ({§engine-rails}). Counting that raw status as well would
// double-count one ruling; other 409 outcomes remain soft. The cycle detector
// remains an independent backstop. EXEC outcomes are soft independently of
// status: executor errors remain evidence, not PLURNK contract violations.
const SOFT_FAILURE_STATUSES: ReadonlySet<number> = new Set([404, 409, 416, 501]);

export type StrikeOutcome = {
    readonly op: PlurnkStatement["op"] | null;
    readonly status: number;
};

// Per-op fingerprint: op verb + target URI, plus an op-specific discriminator
// where the activity isn't fully captured by target alone:
//   - EDIT/COPY/MOVE: body excluded — re-writing the same target with varied
//     content IS cycling (the model is producing different versions of the
//     same artifact instead of progressing).
//   - FIND/READ/OPEN/FOLD: body IS the search/selection pattern; varied
//     matchers on the same target ARE different activities (the model is
//     exploring different queries, not repeating one).
//   - BARE: the body is the complete isolated prompt and therefore the
//     activity identity, just as EXEC's body identifies its command.
const fingerprintOp = (stmt: PlurnkStatement): string => {
    const path = stmt.op === "COPY" || stmt.op === "MOVE" ? stmt.source.target : stmt.target;
    const matcherDiscriminator = (): string => {
        // For matcher-bearing ops, the body's `raw` (matcher source) plus
        // any lineMarker forms the activity discriminator.
        const parts: string[] = [];
        const body = (stmt as { body?: { raw?: unknown } | string | null }).body;
        if (body !== null && typeof body === "object" && typeof body.raw === "string") {
            parts.push(`body:${body.raw.slice(0, 64)}`);
        }
        const lm = (stmt as { lineMarker?: TextLineMarker | null }).lineMarker;
        if (lm !== null && lm !== undefined) parts.push(`L:${lm.marks.join(",")}`);
        return parts.length > 0 ? `|${parts.join("|")}` : "";
    };
    if (path === null) {
        // Path-less ops need an activity-defining discriminator other
        // than `target`. Picked per op so the cycle detector reflects
        // intent rather than syntax:
        //   - EXEC: the command body IS the activity. Without a body
        //     digest, varied shell commands (find / ls / wc) collapse to
        //     one fingerprint and the detector mislabels exploration
        //     as a loop.
        //   - SEND: the status code (signal) IS the activity. Different
        //     Different SEND signals are different intentions; the same signal with
        //     different message bodies is the same termination signal.
        if (stmt.op === "EXEC" || stmt.op === "BARE") {
            const body = typeof stmt.body === "string" ? stmt.body : "";
            return `${stmt.op}|(no-path)${body.length > 0 ? `|body:${body.slice(0, 64)}` : ""}`;
        }
        if (stmt.op === "SEND") {
            const signal = typeof stmt.signal === "number" ? stmt.signal : "";
            return `SEND|(no-path)|signal:${signal}`;
        }
        return `${stmt.op}|(no-path)`;
    }
    const base = path.kind === "url"
        ? `${stmt.op}|${renderTarget(path)}`
        : `${stmt.op}|local:${path.raw}`;
    if (stmt.op === "FIND" || stmt.op === "READ" || stmt.op === "OPEN" || stmt.op === "FOLD") {
        return `${base}${matcherDiscriminator()}`;
    }
    return base;
};

// {§engine-rails} — one per-loop rail owns the consecutive strike streak and
// cycle history. The model sees admitted operation and engine-rail failures,
// never this private accounting.
export default class StrikeRail {
    // Per-turn fingerprint: sorted set of per-op fingerprints, joined. Order
    // within a turn doesn't matter — we want the SET of activities.
    static fingerprintTurn(ops: ReadonlyArray<PlurnkStatement>): string {
        return ops.map(fingerprintOp).toSorted().join(",");
    }

    // {§engine-rails} cycle detector. For each candidate period k in [1, maxCyclePeriod],
    // check whether the last k*minCycles entries form minCycles repetitions of the
    // same length-k pattern. O(maxCyclePeriod × minCycles × max k) ≈ tiny.
    static detectCycle(
        history: ReadonlyArray<string>,
        minCycles: number,
        maxCyclePeriod: number,
    ): { detected: false } | { detected: true; period: number; cycles: number } {
        for (let k = 1; k <= maxCyclePeriod; k++) {
            const needed = k * minCycles;
            if (history.length < needed) continue;
            const tail = history.slice(-needed);
            const cycle = tail.slice(0, k);
            let match = true;
            outer: for (let rep = 0; rep < minCycles; rep++) {
                for (let j = 0; j < k; j++) {
                    if (tail[rep * k + j] !== cycle[j]) { match = false; break outer; }
                }
            }
            if (match) return { detected: true, period: k, cycles: minCycles };
        }
        return { detected: false };
    }

    // {§engine-rails} strike state per loop. `streak` resets on a clean turn;
    // `history` holds consecutive turn fingerprints for cycle detection.
    #state = new Map<number, { streak: number; history: string[] }>();

    // The loop's CURRENT strike streak — the same figure the 500-threshold compares. Rides
    // generate({strikes}) as first-party outbound metadata (Plurnk-Strikes,
    // {§strikes-first-party-metadata}): the hosted
    // router's escalation signal. NEVER model-facing ({§engine-rails} — a surfaced count is a
    // metric to game); the packet does not carry it.
    streak(loopId: number): number {
        return this.#state.get(loopId)?.streak ?? 0;
    }

    // Per-turn strike accounting, run by runLoop after every admitted turn.
    // {§engine-rails} owns the complete source list and threshold semantics.
    assess(loopId: number, turn: {
        fingerprint: string;
        outcomes: ReadonlyArray<StrikeOutcome>;
        steerStruck: boolean;
        minCycles: number;
        maxCyclePeriod: number;
        maxStrikes: number;
    }): { cycleDetected: boolean; thresholdCrossed: boolean } {
        // {§engine-rails}: cycle detection. Push this turn's fingerprint to
        // history and scan for repetition patterns. Detection is intentionally
        // not a model-facing notice; it is private engine accounting.
        const state = this.#state.get(loopId) ?? { streak: 0, history: [] };
        state.history.push(turn.fingerprint);
        const cycle = StrikeRail.detectCycle(state.history, turn.minCycles, turn.maxCyclePeriod);
        const recordedFailed = turn.outcomes.some(
            ({ op, status }) => op !== "EXEC" && status >= 400 && !SOFT_FAILURE_STATUSES.has(status),
        );
        const struck = recordedFailed || turn.steerStruck || cycle.detected;
        let thresholdCrossed = false;
        if (struck) {
            state.streak++;
            if (state.streak >= turn.maxStrikes) thresholdCrossed = true;
        } else {
            state.streak = 0;
        }
        this.#state.set(loopId, state);
        return { cycleDetected: cycle.detected, thresholdCrossed };
    }

    delete(loopId: number): void {
        this.#state.delete(loopId);
    }
}
