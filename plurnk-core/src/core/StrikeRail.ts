import { createHash } from "node:crypto";
import type { OperationResult, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";
import type { RuntimeTag } from "@plurnk/plurnk-contracts";

// {§engine-rails}: discovery misses and not-ready results are soft, and no answer to a completion claim strikes
// (a completion joins live work, {§completion-joins-live-work}; a claim over settled results
// defers, {§completion-defers-to-results}). Executor evidence is soft wherever it surfaces,
// including a completion READ ({§exec-stream}).
const SOFT_FAILURE_STATUSES: ReadonlySet<number> = new Set([404, 409, 416, 425, 501]);
const EXECUTOR_EVIDENCE_PREFIX = "https://problems.plurnk.xyz/executor/";

export type StrikeOutcome = {
    // The row op: an operation keyword, or an execution's runtime tag.
    readonly op: PlurnkStatement["op"] | RuntimeTag | null;
    readonly status: number;
    readonly problemType?: string | null;
};

type RailState = { strike_streak: number; cycle_history: string; cycle_wait_revision: number };

// {§engine-rails} — the three progress-contract sources, as a crossing terminal names them.
export type StrikeSource = "repetition" | "operation" | "no_operation";

const isExecutorEvidence = ({ problemType }: StrikeOutcome): boolean =>
    typeof problemType === "string" && problemType.startsWith(EXECUTOR_EVIDENCE_PREFIX);

const SOURCE_DECORATION = new Set(["aside", "position"]);

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
            const operation = Object.fromEntries(Object.entries(statement).filter(([key]) =>
                !SOURCE_DECORATION.has(key)));
            const result = results?.[index];
            // {§engine-cycle-evidence}: NOTE's assigned source coordinate is storage,
            // not an observation; its complete authored content remains in operation.
            const evidence = statement.op === "NOTE" && result !== undefined
                ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "resource")) as OperationResult
                : result;
            return [[operation, observedResult(evidence)]];
        });
        const canonical = JSON.stringify(activity, (_key, value) =>
            value !== null && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
                : value);
        return createHash("sha256").update(canonical).digest("hex");
    }

    // {§engine-cycle-evidence} — an empty turn performed no activity, so its text IS its
    // observable output and is what the detector compares. Fingerprinting the empty program
    // instead makes every empty turn identical, and the detector then reports a cycle over a
    // model that merely spoke three different times ({§empty-turn}) — 508 "loop detected" for a
    // loop that never repeated anything.
    static fingerprintEmptyTurn(text: string): string {
        return createHash("sha256").update(`empty:${text.trim()}`).digest("hex");
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

    // {§rail-accounting-private}: the rail's own counter, never model-facing and never sent.
    async streak(loopId: number): Promise<number> {
        return (await this.#state(loopId)).strike_streak;
    }

    // Per-turn strike accounting, including exhausted frame admission.
    // {§engine-rails} owns the complete source list and threshold semantics.
    async assess(loopId: number, turn: {
        waitRevision: number;
        fingerprint: string;
        outcomes: ReadonlyArray<StrikeOutcome>;
        emptyTurn?: boolean;
        minCycles: number;
        maxCyclePeriod: number;
        maxStrikes: number;
    }): Promise<{ cycleDetected: boolean; thresholdCrossed: boolean; crossedBy: StrikeSource | null }> {
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
            (outcome) => !isExecutionOp(outcome.op)
                && outcome.status >= 400
                && !SOFT_FAILURE_STATUSES.has(outcome.status)
                && !isExecutorEvidence(outcome),
        );
        // {§empty-turn} — a turn with no operation is one progress-contract strike.
        const struck = recordedFailed || cycle.detected || turn.emptyTurn === true;
        const streak = struck ? state.strike_streak + 1 : 0;
        // {§engine-rails} — which source struck this turn, so a crossing terminal can say what
        // actually happened instead of calling an unfenced reply a failed operation. A turn may
        // match more than one; the most specific wins, and repetition is the most specific fact.
        const crossedBy: StrikeSource | null = !struck ? null
            : cycle.detected ? "repetition"
            : recordedFailed ? "operation"
            : "no_operation";
        const saved = await this.#db.strike_rail_assess.run({
            loop_id: loopId,
            streak,
            history: JSON.stringify(history),
            wait_revision: turn.waitRevision,
        });
        if (saved.changes !== 1) throw new Error(`strike rail loop ${loopId} disappeared during assessment`);
        return { cycleDetected: cycle.detected, thresholdCrossed: struck && streak >= turn.maxStrikes, crossedBy };
    }
}
