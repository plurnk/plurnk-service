// Driving one loop to its terminal: turn after turn under the workspace turn lock, strikes, and cancellation. Split out of Engine, which keeps the delegating entry point.
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { Db } from "./Db.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import { setTimeout as delay } from "node:timers/promises";
import Results, { type SchemeResult } from "./results.ts";
import NoticeChannel from "./NoticeChannel.ts";
import StrikeRail from "./StrikeRail.ts";
import { type ChatMessage } from "./PacketBuilder.ts";
import TurnRunner, { LOOP_TIMEOUT_REASON } from "./TurnRunner.ts";
import { observed } from "../observe/spans.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import type { AcquireWorkspaceTurn, WorkspaceTurnStarting } from "./Engine.ts";

const readMaxStrikes = (): number => {
    const raw = process.env.PLURNK_SERVICE_MAX_STRIKES;
    if (raw === undefined || raw.length === 0) return DEFAULT_MAX_STRIKES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STRIKES;
    return n;
};

const DEFAULT_MIN_CYCLES = 3;

const DEFAULT_MAX_CYCLE_PERIOD = 4;

const readPositiveInt = (envVar: string, fallback: number): number => {
    const raw = process.env[envVar];
    if (raw === undefined || raw.length === 0) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return n;
};

const readLoopTimeoutMs = (): number => readPositiveInt("PLURNK_SERVICE_LOOP_TIMEOUT", DEFAULT_LOOP_TIMEOUT_MS);

const DEFAULT_MAX_STRIKES = 3;

// {§operator-config-loop-timeout} — the loop's wall-clock budget (PLURNK_SERVICE_LOOP_TIMEOUT).
const DEFAULT_LOOP_TIMEOUT_MS = 86400000;

export default class LoopDriver {
    readonly #loopAborts: Map<number, AbortController>;
    readonly #db: Db;
    readonly #lifecycle: LoopLifecycle;
    readonly #schemes: SchemeRegistry;
    readonly #notices: NoticeChannel;
    readonly #strikes: StrikeRail;
    readonly #acquireWorkspaceTurn: AcquireWorkspaceTurn;
    readonly #workspaceTurnStarting: WorkspaceTurnStarting | undefined;
    readonly #runTurn: (args: Parameters<TurnRunner["runTurn"]>[0]) => ReturnType<TurnRunner["runTurn"]>;

    constructor({ loopAborts, db, lifecycle, schemes, notices, strikes, acquireWorkspaceTurn, workspaceTurnStarting, runTurn }: {
        loopAborts: Map<number, AbortController>;
        db: Db;
        lifecycle: LoopLifecycle;
        schemes: SchemeRegistry;
        notices: NoticeChannel;
        strikes: StrikeRail;
        acquireWorkspaceTurn: AcquireWorkspaceTurn;
        workspaceTurnStarting: WorkspaceTurnStarting | undefined;
        runTurn: (args: Parameters<TurnRunner["runTurn"]>[0]) => ReturnType<TurnRunner["runTurn"]>;
    }) {
        this.#loopAborts = loopAborts;
        this.#db = db;
        this.#lifecycle = lifecycle;
        this.#schemes = schemes;
        this.#notices = notices;
        this.#strikes = strikes;
        this.#acquireWorkspaceTurn = acquireWorkspaceTurn;
        this.#workspaceTurnStarting = workspaceTurnStarting;
        this.#runTurn = runTurn;
    }

    async runLoop({
        provider, childProvider = provider, messages, recap = "", workspaceId, workerId, loopId,
        maxTurns = 50, maxStrikes = readMaxStrikes(),
        minCycles = readPositiveInt("PLURNK_SERVICE_MIN_CYCLES", DEFAULT_MIN_CYCLES),
        maxCyclePeriod = readPositiveInt("PLURNK_SERVICE_MAX_CYCLE_PERIOD", DEFAULT_MAX_CYCLE_PERIOD),
        signal, onDispatch, onSettled }: {
        provider: Provider;
        childProvider?: Provider;
        messages: ChatMessage[];
        // Optional Recap override; packet assembly owns default sourcing.
        recap?: string;
        workspaceId: number; workerId: number; loopId: number;
        maxTurns?: number;
        maxStrikes?: number;
        minCycles?: number;
        maxCyclePeriod?: number;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        onSettled?: (logEntryId: number) => void | Promise<void>;
    }): Promise<{ turnIds: number[]; result: SchemeResult; hitMaxTurns: boolean; reason: "provider_unavailable" | "max_turns" | "strike_threshold" | "token_budget" | "provider_capacity" | "loop_timeout" | "external" | null }> {
        // A 202 park suspends this durable loop and a later wake re-enters runLoop.
        // Its ceiling therefore counts every prior turn, not merely this process-local
        // execution segment.
        const turnIds = await this.#lifecycle.turnIds(loopId);
        let modelTurnCount = await this.#lifecycle.modelTurnCount(loopId);
        let invalidEmissionRecoveryEntryId: number | null = null;
        // Per-loop AbortController for scheme-side cancellation propagation.
        // Chained from the caller's `signal` so an external abort cascades.
        const loopAbort = new AbortController();
        if (signal !== undefined) {
            if (signal.aborted) loopAbort.abort(signal.reason);
            else signal.addEventListener("abort", () => loopAbort.abort(signal.reason), { once: true });
        }
        this.#loopAborts.set(loopId, loopAbort);

        // {§operator-config-loop-timeout} — the wall-clock budget. Expiry aborts the loop signal, so a
        // mid-flight provider call (generate rides this signal) and in-flight spawns tear down; the
        // loop terminates 504 (kin to the exec <T> reap's 504, {§exec-timeout}) — a legible engine
        // terminal, never an outside kill. unref'd: the wall never holds the process open.
        const wall = setTimeout(() => loopAbort.abort(LOOP_TIMEOUT_REASON), readLoopTimeoutMs());
        wall.unref();
        const timedOut = (): boolean => loopAbort.signal.aborted && loopAbort.signal.reason === LOOP_TIMEOUT_REASON;
        const ruleTimeout = async (): Promise<{ turnIds: number[]; result: SchemeResult; hitMaxTurns: boolean; reason: "loop_timeout" }> => {
            const failure = Results.failure(
                "engine:rails",
                "loop-timeout",
                504,
                `The loop exceeded its wall-clock deadline after ${modelTurnCount} model turns.`,
                {},
                {
                    turns: modelTurnCount,
                    stage: "loop",
                    retryable: false },
            );
            const result = await this.#lifecycle.finish(loopId, failure);
            if (result === null) throw new Error(`loop ${loopId} became terminal before timeout settlement`);
            cleanup("forceful", "loop_timeout");
            return { turnIds, result, hitMaxTurns: false, reason: "loop_timeout" };
        };

        // Cleanup splits by termination kind:
        // - "graceful" (SEND signal 202 Accepted): in-flight streaming-scheme spawns
        //   are ALLOWED to outlive the loop — they complete naturally, write final
        //   channel state, and wake-on-completion (E.4) opens a fresh loop. 202 is
        //   the only terminal that means "keep my async work."
        // - "forceful" (SEND signal 200 done, max_turns, strike, cancel, context-envelope rejection, 4xx/5xx):
        //   fire the loop-level abort so leftover spawns tear down. "Done" reaps.
        const cleanup = (kind: "graceful" | "forceful", reason?: string): void => {
            clearTimeout(wall);
            if (kind === "forceful" && !loopAbort.signal.aborted) {
                loopAbort.abort(reason ?? "loop_forceful_termination");
            }
            this.#loopAborts.delete(loopId);
            this.#strikes.delete(loopId);
            this.#notices.delete(loopId);
        };

        while (true) {
            const row = await this.#db.engine_loop_status.get<{ status: number }>({ loop_id: loopId });
            if (row === undefined) throw new Error(`Engine.runLoop: loop ${loopId} not found`);
            if (row.status === 100) {
                // NOT a terminal — a wake re-queued this loop while its own live drain was
                // between turns (a child concluded in the gap between our 202 write and this
                // check, {§worker-lifecycle-wake-requeue-not-terminal}). The wake's intent is KEEP
                // RUNNING: re-claim atomically and continue — the injected prompt is already
                // this loop's next turn. Returning it as "external" broadcast a QUEUED loop
                // as a terminal result with status 100 — the delegation-policy race.
                await this.#db.engine_reclaim_queued_loop.run({ loop_id: loopId });
                continue; // claimed (or a racer flipped it first — the re-read decides)
            }
            if (row.status !== 102) {
                // Only 202 (Accepted) lets spawns outlive — it IS the async wake
                // contract (E.4). Every other terminal, 200 included, reaps: "done"
                // must not leak running execs. Trust the code's declared intent.
                cleanup(row.status === 202 ? "graceful" : "forceful", `loop_terminal_${row.status}`);
                if (row.status === 202) {
                    return { turnIds, result: { status: 202 }, hitMaxTurns: false, reason: "external" };
                }
                const result = await this.#lifecycle.result(loopId);
                if (result === null) {
                    throw new Error(`terminal loop ${loopId} status ${row.status} has no operation result`);
                }
                return { turnIds, result, hitMaxTurns: false, reason: "external" };
            }

            // Durable disposition outranks a later process-local cancellation observation.
            // SEND may commit 202 immediately before daemon shutdown aborts this drain; reading
            // the abort first launders that lawful park into 499 under load. Only a still-running
            // 102 loop can be cancelled or time out at this boundary.
            if (timedOut()) return await ruleTimeout();
            signal?.throwIfAborted();

            if (maxTurns >= 0 && modelTurnCount >= maxTurns) {
                const failure = Results.failure(
                    "engine:rails",
                    "max-turns",
                    429,
                    `The configured turn ceiling (${maxTurns}) is exhausted.`,
                    {},
                    {
                        maximumTurns: maxTurns,
                        stage: "loop",
                        retryable: false },
                );
                const result = await this.#lifecycle.finish(loopId, failure);
                if (result === null) throw new Error(`loop ${loopId} became terminal before max-turn settlement`);
                cleanup("forceful", "max_turns");
                return { turnIds, result, hitMaxTurns: true, reason: "max_turns" };
            }

            const execHandler = this.#schemes.get("exec") as { hasActiveHoldSpawns?: (workerId: number, holdSet: ReadonlySet<string>) => boolean } | undefined;
            // {§exec-hold-until-concluded} — hold matching runtime/effect
            // streams until conclusion or the fail-open cap, then resume the
            // ordinary cycle without altering stream state.
            const holdSet = new Set((process.env.PLURNK_SERVICE_EXEC_HOLD ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0));
            const holdCapMs = Number(process.env.PLURNK_SERVICE_EXEC_HOLD_MS ?? "300000");
            if (holdSet.size > 0 && holdCapMs > 0 && execHandler?.hasActiveHoldSpawns !== undefined) {
                const holdStart = Date.now();
                while (execHandler.hasActiveHoldSpawns(workerId, holdSet) && Date.now() - holdStart < holdCapMs) {
                    await delay(150, undefined, { signal });
                }
            }
            let turn;
            const releaseWorkspace = await this.#acquireWorkspaceTurn(workspaceId, workerId);
            try {
                await this.#workspaceTurnStarting?.({ workspaceId, workerId, loopId });
                turn = await observed( // {§observability-boundary}
                    "loop.turn",
                    { workerId, "loop.id": loopId },
                    async (span) => {
                        const t = await this.#runTurn({
                            provider, childProvider, messages, recap, workspaceId, workerId, loopId, signal, onDispatch, onSettled,
                            turnNumber: modelTurnCount + 1, maxTurns,
                            allowUnobservedRetrievalCompletion: this.#strikes.streak(loopId) + 1 >= maxStrikes,
                            invalidEmissionRecoveryEntryId });
                        span.setAttribute("turn.id", t.turnId);
                        span.setAttribute("turn.producer", t.producer);
                        span.setAttribute("turn.kind", t.kind);
                        return t;
                    },
                );
            } catch (err) {
                // The wall fired mid-turn — the abort tore the turn down (generate rides the loop
                // signal); rule the legible 504, never a generic drain error.
                if (timedOut()) return await ruleTimeout();
                throw err;
            } finally {
                releaseWorkspace();
            }
            turnIds.push(...turn.createdTurnIds);

            // {§overflow-turn-only} — packetless kernel chronology is not a
            // model attempt and never enters emission or strike accounting.
            if (turn.kind === "overflow") {
                if (turn.curationFailure !== undefined) {
                    const result = await this.#lifecycle.finish(loopId, turn.curationFailure);
                    if (result === null) throw new Error(`loop ${loopId} became terminal before token-overflow settlement`);
                    cleanup("forceful", "token_budget_overflow");
                    return { turnIds, result, hitMaxTurns: false, reason: "token_budget" };
                }
                continue;
            }
            modelTurnCount++;

            // {§engine-rails} Contract Strikes: every emission exhaustion is one
            // frame-contract violation. The next turn is always informed (it carries
            // the rejected emission), and the strike rail — not a bespoke terminal —
            // decides how many consecutive violations the loop survives.
            if (turn.emissionExhausted) {
                if (turn.rejectedModelEntryId === undefined) {
                    throw new Error("an invalid-emission recovery requires its rejected emissionAttempt identity");
                }
                invalidEmissionRecoveryEntryId = turn.rejectedModelEntryId;
            } else {
                invalidEmissionRecoveryEntryId = null;
            }

            // {§provider-surface-capacity}: the provider rejected the changed request for capacity.
            if (turn.capacityHardStop) {
                if (turn.capacityFailure === undefined) {
                    throw new Error("a provider-capacity stop requires its exact failure");
                }
                const result = await this.#lifecycle.finish(loopId, turn.capacityFailure);
                if (result === null) throw new Error(`loop ${loopId} became terminal before provider-capacity settlement`);
                cleanup("forceful", "provider_capacity");
                return { turnIds, result, hitMaxTurns: false, reason: "provider_capacity" };
            }
            if (turn.providerParked) {
                // {§provider-recovery} — the provider stayed unavailable past the recovery budget:
                // the loop parks like a [202] wait, spawns outlive it, and the ordinary wake resumes it.
                if (!await this.#lifecycle.park(loopId)) throw new Error(`loop ${loopId} could not park after provider recovery`);
                cleanup("graceful", "provider_unavailable");
                return { turnIds, result: { status: 202 }, hitMaxTurns: false, reason: "provider_unavailable" };
            }

            // {§engine-rails} — per-turn strike accounting (cycle detection,
            // steer coupling, hard operation outcomes). StrikeRail owns the
            // bookkeeping; runLoop owns abandonment.
            const verdict = this.#strikes.assess(loopId, {
                fingerprint: turn.fingerprint,
                outcomes: turn.outcomes,
                steerStruck: turn.steerStruck,
                minCycles, maxCyclePeriod, maxStrikes });
            if (verdict.thresholdCrossed) {
                // {§engine-rails} — the source on the crossing turn classifies
                // the engine verdict: cycle-driven is 508; every other strike is 500.
                const status = verdict.cycleDetected ? 508 : 500;
                const failure = Results.failure(
                    "engine:rails",
                    "strike-threshold",
                    status,
                    verdict.cycleDetected
                        ? `The loop reached its strike threshold after ${modelTurnCount} model turns because its operations and results repeated.`
                        : `The loop reached its strike threshold after ${modelTurnCount} model turns because consecutive turns failed.`,
                    {},
                    {
                        turns: modelTurnCount,
                        stage: "loop",
                        retryable: false },
                );
                const result = await this.#lifecycle.finish(loopId, failure);
                if (result === null) throw new Error(`loop ${loopId} became terminal before strike settlement`);
                cleanup("forceful", "strike_threshold");
                return { turnIds, result, hitMaxTurns: false, reason: "strike_threshold" };
            }
        }
    }

}
