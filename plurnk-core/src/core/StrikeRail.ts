import { createHash } from "node:crypto";
import type { OperationResult, PlurnkStatement } from "@plurnk/plurnk-contracts";

// Operation outcome statuses that do not accumulate strikes. Exploratory misses are
// not failures: probing a path that doesn't exist (404), a line
// range that doesn't exist (416), or a capability a scheme lacks (501) is how discovery
// works — striking them prices caution into the motions we most want (range-reads ARE
// the surgical behavior under budget pressure). One simple set, evenly applied.
// 409 is SOFT here because Engine accounts for a refused final disposition
// through steerStruck ({§engine-rails}). Counting that raw status as well would
// double-count one ruling; other 409 outcomes remain soft. The cycle detector
// remains an independent backstop. EXEC outcomes are soft independently of
// status: executor errors remain evidence, not PLURNK contract violations — and so
// is the same evidence wherever it surfaces: a failed command's completion READ
// ({§exec-stream}) or the model's own READ of that stream carries an `executor/*`
// problem identity and never strikes (#425 F1). Structural violations do strike,
// by ruling: six in a row is a degenerated run at the weak end of competence.
const SOFT_FAILURE_STATUSES: ReadonlySet<number> = new Set([404, 409, 416, 501]);
const EXECUTOR_EVIDENCE_PREFIX = "https://problems.plurnk.xyz/executor/";

export type StrikeOutcome = {
    readonly op: PlurnkStatement["op"] | null;
    readonly status: number;
    readonly problemType?: string | null;
};

const isExecutorEvidence = ({ problemType }: StrikeOutcome): boolean =>
    typeof problemType === "string" && problemType.startsWith(EXECUTOR_EVIDENCE_PREFIX);

const SOURCE_DECORATION = new Set(["annotation", "delimiter", "position"]);

const observedResult = (result: OperationResult | undefined): unknown => result?.problem === undefined
    ? result
    : { ...result, problem: Object.fromEntries(Object.entries(result.problem).filter(([key]) => key !== "instance")) };

// {§engine-rails} — one per-loop rail owns the consecutive strike streak and
// cycle history. The model sees admitted operation and engine-rail failures,
// never this private accounting.
export default class StrikeRail {
    // {§engine-cycle-evidence}: compare operational inputs and observed results,
    // not an interpretation of the model's intent. Optional results support the
    // syntax-only Engine fingerprint helper; admitted turns always supply them.
    static fingerprintTurn(ops: ReadonlyArray<PlurnkStatement>, results?: ReadonlyArray<OperationResult>): string {
        if (results !== undefined && results.length !== ops.length) {
            throw new Error("cycle evidence requires one result per executed operation");
        }
        const activity = ops.flatMap((statement, index) => {
            if (statement.op === "PLAN") return [];
            const disposition = statement.op === "SEND" && statement.target === null && statement.status !== null;
            const operation = Object.fromEntries(Object.entries(statement).filter(([key]) =>
                !SOURCE_DECORATION.has(key) && !(disposition && key === "body")));
            return [[operation, observedResult(results?.[index])]];
        });
        const canonical = JSON.stringify(activity, (_key, value) =>
            value !== null && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
                : value);
        return createHash("sha256").update(canonical).digest("hex");
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
        const window = turn.minCycles * turn.maxCyclePeriod;
        if (state.history.length > window) state.history.splice(0, state.history.length - window);
        const cycle = StrikeRail.detectCycle(state.history, turn.minCycles, turn.maxCyclePeriod);
        const recordedFailed = turn.outcomes.some(
            (outcome) => outcome.op !== "EXEC"
                && outcome.status >= 400
                && !SOFT_FAILURE_STATUSES.has(outcome.status)
                && !isExecutorEvidence(outcome),
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
