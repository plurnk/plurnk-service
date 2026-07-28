import type { PlurnkStatement, LineMarker } from "@plurnk/plurnk-grammar";

// Rail #38: action-entry statuses that DON'T accumulate strikes. Model adapted
// to a finding (not_found, op_not_supported); no penalty. Rummy parallel:
// SOFT_FAILURE_OUTCOMES = {"not_found", "unparsed"}.
// Exploratory misses are not failures: probing a path that doesn't exist (404), a line
// range that doesn't exist (416), or a capability a scheme lacks (501) is how discovery
// works — striking them prices caution into the motions we most want (range-reads ARE
// the surgical behavior under budget pressure). One simple set, evenly applied.
// 409 (premature-terminate refusal) is SOFT here: whether it strikes is decided by steerStruck
// (Engine sets it true for a stream/child refusal — discarding live work IS serious — and false
// for a retrievals-only refusal, which teaches without striking, §send-premature-terminate/#346).
// Counting the raw 409 status ALSO would double-strike the stream/child case and WRONGLY strike
// the retrieval-only case (a cloud atomic-turn model repeating read+conclude struck out 500 on
// firefast despite the ruling). The cycle detector remains the backstop for a genuinely-spinning
// model (508 loop-detected — the honest signal, not a 500 failure).
const SOFT_FAILURE_STATUSES: ReadonlySet<number> = new Set([404, 409, 416, 501]);

// Per-op fingerprint: op verb + target URI, plus an op-specific discriminator
// where the activity isn't fully captured by target alone:
//   - EDIT/COPY/MOVE: body excluded — re-writing the same target with varied
//     content IS cycling (the model is producing different versions of the
//     same artifact instead of progressing).
//   - FIND/READ/OPEN/FOLD: body IS the search/selection pattern; varied
//     matchers on the same target ARE different activities (the model is
//     exploring different queries, not repeating one).
const fingerprintOp = (stmt: PlurnkStatement): string => {
    const path = stmt.target;
    const matcherDiscriminator = (): string => {
        // For matcher-bearing ops, the body's `raw` (matcher source) plus
        // any lineMarker forms the activity discriminator.
        const parts: string[] = [];
        const body = (stmt as { body?: { raw?: unknown } | string | null }).body;
        if (body !== null && typeof body === "object" && typeof body.raw === "string") {
            parts.push(`body:${body.raw.slice(0, 64)}`);
        }
        const lm = (stmt as { lineMarker?: LineMarker | null }).lineMarker;
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
        //     SEND[X] are different intentions; same SEND[X] with
        //     different message bodies is the same termination signal.
        if (stmt.op === "EXEC") {
            const body = typeof stmt.body === "string" ? stmt.body : "";
            return `EXEC|(no-path)${body.length > 0 ? `|body:${body.slice(0, 64)}` : ""}`;
        }
        if (stmt.op === "SEND") {
            const signal = typeof stmt.signal === "number" ? stmt.signal : "";
            return `SEND|(no-path)|signal:${signal}`;
        }
        return `${stmt.op}|(no-path)`;
    }
    const base = path.kind === "url"
        ? `${stmt.op}|${path.scheme}://${path.pathname}`
        : `${stmt.op}|local:${path.raw}`;
    if (stmt.op === "FIND" || stmt.op === "READ" || stmt.op === "OPEN" || stmt.op === "FOLD") {
        return `${base}${matcherDiscriminator()}`;
    }
    return base;
};

// Rails #38 (strikes) + #39 (cycle detection): the per-loop failure-streak
// accounting that decides abandonment. Strike accounting is engine-internal
// bookkeeping. Per rummy precedent (plugins/error/error.js#verdict) and SPEC
// §operation-results policy: model sees failures from admitted operations and
// engine rails, never the engine's accounting about them (strike counts,
// cycle detection, sudden-death threshold). Surfacing internal state to the
// model creates a gamification surface — model optimizes for engine metrics
// rather than task progress.
export default class StrikeRail {
    // Per-turn fingerprint: sorted set of per-op fingerprints, joined. Order
    // within a turn doesn't matter — we want the SET of activities.
    static fingerprintTurn(ops: ReadonlyArray<PlurnkStatement>): string {
        return ops.map(fingerprintOp).toSorted().join(",");
    }

    // Rail #39 cycle detector. For each candidate period k in [1, maxCyclePeriod],
    // check whether the last k*minCycles entries form minCycles repetitions of the
    // same length-k pattern. O(maxCyclePeriod × minCycles × max k) ≈ tiny. Rummy
    // parallel: src/plugins/error/error.js detectCycle.
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

    // Rail #38 strike state per loop. `streak` = consecutive struck turns;
    // resets on a clean turn. `turnErrors` is bumped by per-turn rails (cycle
    // detection #39, grinder, steer) — read and reset at end of each turn.
    // `history` holds per-turn fingerprints for rail #39 cycle detection.
    #state = new Map<number, { streak: number; turnErrors: number; history: string[] }>();

    // The loop's CURRENT strike streak — the same figure the 500-threshold compares. Rides
    // generate({strikes}) as first-party outbound metadata (Plurnk-Strikes, #313): the hosted
    // router's escalation signal. NEVER model-facing (§engine-rails — a surfaced count is a
    // metric to game); the packet does not carry it.
    streak(loopId: number): number {
        return this.#state.get(loopId)?.streak ?? 0;
    }

    // Per-turn strike accounting, run by runLoop after every turn. Three
    // sources strike a turn:
    //  1. recordedFailed — any action-entry at hard failure status
    //     (>= 400 and not in SOFT_FAILURE_STATUSES).
    //  2. noOps — the turn emitted no ops at all (per #41).
    //  3. turnErrors — bumped by per-turn rails (#39 cycle, grinder, steer).
    // Struck → streak++; clean → streak = 0. Threshold → thresholdCrossed,
    // and runLoop owns the abandonment.
    assess(loopId: number, turn: {
        fingerprint: string;
        statuses: ReadonlyArray<number>;
        noOps: boolean;
        budgetStruck: boolean;
        steerStruck: boolean;
        minCycles: number;
        maxCyclePeriod: number;
        maxStrikes: number;
    }): { cycleDetected: boolean; thresholdCrossed: boolean } {
        // Rail #39: cycle detection. Push this turn's fingerprint to
        // history, scan for repetition patterns. Detection bumps
        // turnErrors so the strike system handles abandonment
        // naturally — same internal-only role rummy gave it
        // (plugins/error/error.js#verdict). Intentionally NOT a
        // model-facing notices kind: model sees the strike pile-up
        // (which IS the actionable signal); cycle is the engine's
        // reason for treating the turn as a failure, not its own alert.
        const state = this.#state.get(loopId) ?? { streak: 0, turnErrors: 0, history: [] };
        state.history.push(turn.fingerprint);
        const cycle = StrikeRail.detectCycle(state.history, turn.minCycles, turn.maxCyclePeriod);
        if (cycle.detected) state.turnErrors++;
        // SPEC §grinder: a non-soft grinder fire counts toward the strike streak.
        if (turn.budgetStruck) state.turnErrors++; // a grinder fire bumps the strike streak — §grinder-strike-coupling
        if (turn.steerStruck) state.turnErrors++; // idle / premature-terminate steer struck — §send the terminal contract
        const recordedFailed = turn.statuses.some((s) => s >= 400 && !SOFT_FAILURE_STATUSES.has(s));
        const struck = turn.noOps || recordedFailed || state.turnErrors > 0;
        let thresholdCrossed = false;
        if (struck) {
            state.streak++;
            if (state.streak >= turn.maxStrikes) thresholdCrossed = true;
        } else {
            state.streak = 0;
        }
        state.turnErrors = 0;
        this.#state.set(loopId, state);
        return { cycleDetected: cycle.detected, thresholdCrossed };
    }

    delete(loopId: number): void {
        this.#state.delete(loopId);
    }
}
