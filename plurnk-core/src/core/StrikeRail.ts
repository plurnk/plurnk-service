import { TurnDisposition } from "@plurnk/plurnk-contracts";
import { createHash } from "node:crypto";
import type { OperationResult, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";

// {§engine-rails}: discovery misses are soft. Refused dispositions strike via
// steerStruck, never by counting their raw 409 a second time. Executor evidence
// is soft wherever it surfaces, including a completion READ ({§exec-stream}).
const SOFT_FAILURE_STATUSES: ReadonlySet<number> = new Set([404, 409, 416, 501]);
const EXECUTOR_EVIDENCE_PREFIX = "https://problems.plurnk.xyz/executor/";

export type StrikeOutcome = {
    readonly op: PlurnkStatement["op"] | null;
    readonly status: number;
    readonly problemType?: string | null;
};

type RailState = { strike_streak: number; cycle_history: string; cycle_wait_revision: number };

const isExecutorEvidence = ({ problemType }: StrikeOutcome): boolean =>
    typeof problemType === "string" && problemType.startsWith(EXECUTOR_EVIDENCE_PREFIX);

const SOURCE_DECORATION = new Set(["annotation", "position"]);

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
            const disposition = TurnDisposition.is(statement);
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

    readonly #db: Db;

    constructor(db: Db) {
        this.#db = db;
    }

    async #state(loopId: number): Promise<RailState> {
        const state = await this.#db.strike_rail_state.get<RailState>({ loop_id: loopId });
        if (state === undefined) throw new Error(`strike rail loop ${loopId} not found`);
        return state;
    }

    // {§strikes-first-party-metadata}: provider metadata, never a model-facing counter.
    async streak(loopId: number): Promise<number> {
        return (await this.#state(loopId)).strike_streak;
    }

    // Per-turn strike accounting, run by runLoop after every admitted turn.
    // {§engine-rails} owns the complete source list and threshold semantics.
    async assess(loopId: number, turn: {
        waitRevision: number;
        fingerprint: string;
        outcomes: ReadonlyArray<StrikeOutcome>;
        steerStruck: boolean;
        minCycles: number;
        maxCyclePeriod: number;
        maxStrikes: number;
    }): Promise<{ cycleDetected: boolean; thresholdCrossed: boolean }> {
        // {§engine-rails}: cycle detection. Push this turn's fingerprint to
        // history and scan for repetition patterns. Detection is intentionally
        // not a model-facing notice; it is private engine accounting.
        const state = await this.#state(loopId);
        // The ending turn remains in its opening wait revision. A real park
        // closes that window even if a wake already reclaimed the same drain.
        const history: string[] = state.cycle_wait_revision === turn.waitRevision
            ? JSON.parse(state.cycle_history) : [];
        history.push(turn.fingerprint);
        const window = turn.minCycles * turn.maxCyclePeriod;
        if (history.length > window) history.splice(0, history.length - window);
        const cycle = StrikeRail.detectCycle(history, turn.minCycles, turn.maxCyclePeriod);
        const recordedFailed = turn.outcomes.some(
            (outcome) => outcome.op !== "EXEC"
                && outcome.status >= 400
                && !SOFT_FAILURE_STATUSES.has(outcome.status)
                && !isExecutorEvidence(outcome),
        );
        const struck = recordedFailed || turn.steerStruck || cycle.detected;
        const streak = struck ? state.strike_streak + 1 : 0;
        const saved = await this.#db.strike_rail_assess.run({
            loop_id: loopId,
            streak,
            history: JSON.stringify(history),
            wait_revision: turn.waitRevision,
        });
        if (saved.changes !== 1) throw new Error(`strike rail loop ${loopId} disappeared during assessment`);
        return { cycleDetected: cycle.detected, thresholdCrossed: struck && streak >= turn.maxStrikes };
    }
}
