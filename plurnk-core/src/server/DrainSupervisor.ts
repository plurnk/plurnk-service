import { setTimeout as delay } from "node:timers/promises";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import type { ReasoningPolicy } from "@plurnk/plurnk-contracts";
import { aggregateProviderAccounting } from "@plurnk/plurnk-providers";
import { routeForSpec } from "./model-route.ts";
import type { WakeWorkerPayload } from "../core/ChannelWrite.ts";
import ChannelWrite from "../core/ChannelWrite.ts";
import type { Db } from "../core/Db.ts";
import type { LoopUsage } from "../core/Engine.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";
import type { LoopFlags } from "../core/types.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import { observed } from "../observe/spans.ts";
import { LOOP_TERMINALS, recordCounter } from "../observe/metrics.ts";
import { readOptimisticSettlementMs } from "../core/optimistic-settlement.ts";
import { promptLoopPrefix } from "../core/plurnk-uri.ts";
import { execPollBackoffMs } from "./exec-poll-backoff.ts";

export interface DrainLoopResult {
    loopId: number;
    result: SchemeResult;
    hitMaxTurns: boolean;
    turnIds: number[];
    action?: string;
    usage?: LoopUsage;
    attributions?: string[];
}

export type TurnCeilingSelection = Readonly<{
    effective: number;
    source: "implicit" | "explicit";
}>;

export type DrainInjectionArgs = {
    workspaceId: number;
    workerId: number;
    prompt: string;
    source?: string;
    providerSpec: ProviderSpec;
    reasoningPolicy: ReasoningPolicy;
    // False = the client omitted a selector; a continuation must keep the loop's
    // durable provider rather than compare against a re-resolved boot default.
    // Absent/true = an explicit selection, so the compatibility check applies.
    providerSpecExplicit?: boolean;
    systemPrompt: string;
    childProviderSpec?: ProviderSpec | null;
    turnCeiling?: TurnCeilingSelection;
    flags?: Partial<LoopFlags>;
    openPaths?: string[];
};

export type DrainInjectionResult = {
    action: "injected_next_turn" | "enqueued_new_loop";
    loopId: number;
    turnSeq?: number;
    firstLoopPromise?: Promise<DrainLoopResult>;
    drainPromise?: Promise<unknown>;
};

type DrainStartResult = {
    firstLoopPromise: Promise<DrainLoopResult>;
    drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
};

type CompletionWakeGate = {
    conclusions: number;
    poke: PromiseWithResolvers<void>;
    promise: Promise<void>;
};

type InjectionCompatibility = Pick<
    DrainInjectionArgs,
    "workerId" | "providerSpec" | "providerSpecExplicit" | "reasoningPolicy" | "childProviderSpec" | "turnCeiling" | "flags"
> & { loopId: number };

type RunLoop = (args: {
    workspaceId: number;
    workerId: number;
    loopId: number;
    maxTurns: number;
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
    onSettled: (logEntryId: number) => Promise<void>;
}) => Promise<{ result: SchemeResult; hitMaxTurns: boolean }>;

type InjectPrompt = (
    workerId: number,
    prompt: string,
    openPaths: readonly string[],
    source?: string,
) => Promise<{ loopId: number; turnSeq: number } | null>;
type AssertInjectionCompatibility = (args: InjectionCompatibility) => Promise<void>;
type ReconcilePrompts = (workerId: number, endedLoopId: number) => Promise<void>;
type TakeParkDeadline = (loopId: number) => number | undefined;
type EmitEvent = (workspaceId: number, method: string, params: unknown) => void;

// Owns the worker-local queue consumer and every process-local edge that may
// wake, cancel, or retire it. Daemon retains provider/process policy and the
// external facade, supplying only the named capabilities below.
export default class DrainSupervisor {
    readonly #db: Db;
    readonly #lifecycle: LoopLifecycle;
    readonly #injectPrompt: InjectPrompt;
    readonly #assertInjectionCompatibility: AssertInjectionCompatibility;
    readonly #reconcilePrompts: ReconcilePrompts;
    readonly #runLoop: RunLoop;
    readonly #loopUsage: (loopId: number) => Promise<LoopUsage>;
    readonly #loopAttributions: (loopId: number) => Promise<string[]>;
    readonly #takeParkDeadline: TakeParkDeadline;
    readonly #cancelSubscription: (subscriptionId: number) => Promise<boolean>;
    readonly #hasActiveStreams: (workerId: number) => boolean;
    readonly #readSystemPrompt: () => Promise<string>;
    readonly #emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
    readonly #emit: EmitEvent;

    // The handle is the drain identity. Start/exit compare by reference so an
    // exiting drain cannot clobber a successor that raced in.
    readonly #activeDrains = new Map<number, { controller: AbortController; promise: Promise<unknown> }>();
    readonly #drainExitTasks = new Set<Promise<void>>();
    readonly #wakeTasks = new Set<Promise<void>>();
    readonly #wakeFailures: unknown[] = [];
    // One cancellation scope spans a worker's loops and streams. It outlives
    // any single drain and is replaced only after it has been aborted.
    readonly #workerAborts = new Map<number, AbortController>();
    readonly #parkTimers = new Map<number, NodeJS.Timeout>();
    readonly #pollTimers = new Map<number, ReturnType<typeof setTimeout>>();
    readonly #pollBackoff = new Map<number, number>();
    readonly #drainLocks = new Map<number, Promise<unknown>>();
    readonly #owedWakes = new Set<number>();
    readonly #completionWakeGates = new Map<number, CompletionWakeGate>();
    #acceptingWork = false;

    constructor({
        db,
        lifecycle,
        injectPrompt,
        assertInjectionCompatibility,
        reconcilePrompts,
        runLoop,
        loopUsage,
        loopAttributions,
        takeParkDeadline,
        cancelSubscription,
        hasActiveStreams,
        readSystemPrompt,
        emitLogEntry,
        emit,
    }: {
        db: Db;
        lifecycle: LoopLifecycle;
        injectPrompt: InjectPrompt;
        assertInjectionCompatibility: AssertInjectionCompatibility;
        reconcilePrompts: ReconcilePrompts;
        runLoop: RunLoop;
        loopUsage: (loopId: number) => Promise<LoopUsage>;
        loopAttributions: (loopId: number) => Promise<string[]>;
        takeParkDeadline: TakeParkDeadline;
        cancelSubscription: (subscriptionId: number) => Promise<boolean>;
        hasActiveStreams: (workerId: number) => boolean;
        readSystemPrompt: () => Promise<string>;
        emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
        emit: EmitEvent;
    }) {
        this.#db = db;
        this.#lifecycle = lifecycle;
        this.#injectPrompt = injectPrompt;
        this.#assertInjectionCompatibility = assertInjectionCompatibility;
        this.#reconcilePrompts = reconcilePrompts;
        this.#runLoop = runLoop;
        this.#loopUsage = loopUsage;
        this.#loopAttributions = loopAttributions;
        this.#takeParkDeadline = takeParkDeadline;
        this.#cancelSubscription = cancelSubscription;
        this.#hasActiveStreams = hasActiveStreams;
        this.#readSystemPrompt = readSystemPrompt;
        this.#emitLogEntry = emitLogEntry;
        this.#emit = emit;
    }

    start(): void {
        this.#acceptingWork = true;
    }

    beginStop(reason: string): void {
        this.#acceptingWork = false;
        for (const scope of this.#workerAborts.values()) {
            if (!scope.signal.aborted) scope.abort(reason);
        }
        for (const timer of this.#pollTimers.values()) clearTimeout(timer);
        for (const timer of this.#parkTimers.values()) clearTimeout(timer);
        this.#pollBackoff.clear();
        this.#pollTimers.clear();
        this.#parkTimers.clear();
    }

    async idle(): Promise<void> {
        for (;;) {
            const pending = [
                ...[...this.#activeDrains.values()].map(({ promise }) => promise),
                ...this.#drainExitTasks,
                ...this.#wakeTasks,
            ];
            if (pending.length === 0) break;
            await Promise.allSettled(pending);
        }
        const failures = this.#wakeFailures.splice(0);
        if (failures.length > 0) {
            throw new AggregateError(failures, "wake-on-completion settlement failed");
        }
    }

    async inject(args: DrainInjectionArgs): Promise<DrainInjectionResult> {
        const { workspaceId, workerId, prompt } = args;
        const activeInjection = await this.#withDrainLock(workerId, async () => {
            if (!this.#activeDrains.has(workerId)) return null;
            const active = await this.#db.drain_current_loop_for_worker.get<{ id: number }>({ worker_id: workerId });
            if (active !== undefined) {
                await this.#assertInjectionCompatibility({
                    workerId,
                    loopId: active.id,
                    providerSpec: args.providerSpec,
                    providerSpecExplicit: args.providerSpecExplicit,
                    reasoningPolicy: args.reasoningPolicy,
                    ...(args.childProviderSpec === undefined ? {} : { childProviderSpec: args.childProviderSpec }),
                    ...(args.turnCeiling === undefined ? {} : { turnCeiling: args.turnCeiling }),
                    ...(args.flags === undefined ? {} : { flags: args.flags }),
                });
            }
            const result = await this.#injectPrompt(workerId, prompt, args.openPaths ?? [], args.source);
            if (result !== null) {
                // runLoop may already have parked in the database while this drain
                // is still registered. Wake that state now; if it is still running,
                // the serialized park-boundary check below supplies the wake edge.
                await this.#lifecycle.wake(result.loopId);
                return { action: "injected_next_turn", loopId: result.loopId, turnSeq: result.turnSeq } as const;
            }
            return null;
        });
        if (activeInjection !== null) return activeInjection;

        // A parked worker resumes the same durable loop; a wake is not a new
        // loop and cannot silently replace its flags/provider/turn ceiling.
        if (!this.#activeDrains.has(workerId)) {
            const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
            if (slept !== undefined) {
                await this.#assertInjectionCompatibility({
                    workerId,
                    loopId: slept.id,
                    providerSpec: args.providerSpec,
                    providerSpecExplicit: args.providerSpecExplicit,
                    reasoningPolicy: args.reasoningPolicy,
                    ...(args.childProviderSpec === undefined ? {} : { childProviderSpec: args.childProviderSpec }),
                    ...(args.turnCeiling === undefined ? {} : { turnCeiling: args.turnCeiling }),
                    ...(args.flags === undefined ? {} : { flags: args.flags }),
                });
                const injected = await this.#injectPrompt(workerId, prompt, args.openPaths ?? [], args.source);
                await this.#lifecycle.wake(slept.id);
                const started = await this.ensureDrain({ workspaceId, workerId, systemPrompt: args.systemPrompt });
                return {
                    action: "injected_next_turn",
                    loopId: slept.id,
                    ...(injected?.turnSeq === undefined ? {} : { turnSeq: injected.turnSeq }),
                    ...(started ?? {}),
                };
            }
        }

        const loopId = await this.enqueueFreshLoop({
            workerId,
            prompt,
            ...(args.source === undefined ? {} : { source: args.source }),
            providerSpec: args.providerSpec,
            reasoningPolicy: args.reasoningPolicy,
            childProviderSpec: args.childProviderSpec ?? null,
            maxTurns: args.turnCeiling?.effective,
            flags: args.flags,
            openPaths: args.openPaths,
        });
        const started = await this.ensureDrain({ workspaceId, workerId, systemPrompt: args.systemPrompt });
        return { action: "enqueued_new_loop", loopId, ...(started ?? {}) };
    }

    enqueueFreshLoop(args: {
        workerId: number;
        prompt: string;
        source?: string;
        providerSpec: ProviderSpec;
        reasoningPolicy: ReasoningPolicy;
        childProviderSpec: ProviderSpec | null;
        maxTurns?: number;
        flags?: Partial<LoopFlags>;
        openPaths?: string[];
    }): Promise<number> {
        return this.#withDrainLock(args.workerId, async () => {
            const seqRow = await this.#db.loop_run_next_sequence.get<{ next: number }>({ worker_id: args.workerId });
            if (seqRow === undefined) throw new Error("enqueueFreshLoop: next-sequence query returned no row");
            // {§worker-model-selection} — resolve the complete route before persistence;
            // the loop snapshot stores the immutable route ids, never re-serialized JSON.
            const modelRouteId = await routeForSpec(this.#db, args.providerSpec);
            const spawnRouteId = await routeForSpec(this.#db, args.childProviderSpec);
            const loopRow = await this.#db.drain_enqueue_loop.get<{ id: number }>({
                worker_id: args.workerId,
                sequence: seqRow.next,
                prompt: args.prompt,
                prompt_source: args.source ?? null,
                model_route_id: modelRouteId,
                spawn_model_route_id: spawnRouteId,
                reasoning_policy: args.reasoningPolicy,
                max_turns: args.maxTurns ?? Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
            });
            if (loopRow === undefined) throw new Error("enqueueFreshLoop: loop enqueue returned no row");
            if (args.flags !== undefined) {
                await this.#db.engine_set_loop_flags.run({
                    loop_id: loopRow.id,
                    flags: JSON.stringify({ ...DEFAULT_LOOP_FLAGS, ...args.flags }),
                });
            }
            if (args.openPaths !== undefined && args.openPaths.length > 0) {
                await this.#db.engine_set_loop_open_paths.run({
                    loop_id: loopRow.id,
                    open_paths: JSON.stringify(args.openPaths),
                });
            }
            return loopRow.id;
        });
    }

    // Consume one worker's durable queue until a lock-held empty re-claim
    // relinquishes this exact drain identity.
    #startDrain(opts: {
        workspaceId: number; workerId: number;
        systemPrompt: string;
    }): DrainStartResult {
        const { workspaceId, workerId, systemPrompt } = opts;
        // The drain runs under the worker's cancellation scope (shared with the
        // execs its loops spawn), so loop.cancel/shutdown abort it as a unit.
        const controller = this.#workerSignal(workerId);
        const handle: { controller: AbortController; promise: Promise<unknown> } = {
            controller, promise: Promise.resolve(),
        };

        let resolveFirst: (v: DrainLoopResult) => void = () => {};
        let rejectFirst: (e: unknown) => void = () => {};
        const firstLoopPromise = new Promise<DrainLoopResult>((res, rej) => {
            resolveFirst = res; rejectFirst = rej;
        });
        let firstSettled = false;

        const claim = () => this.#db.drain_claim_next_loop.get<{
            id: number; sequence: number; prompt: string; max_turns: number;
        }>({ worker_id: workerId });

        const drainPromise = (async () => {
            let loopsDrained = 0;
            let lastResult: DrainLoopResult | null = null;
            let currentLoopId: number | null = null; // the loop being drained — for abort→499 settlement
            try {
                while (true) {
                    controller.signal.throwIfAborted();
                    let loopRow = await claim();
                    if (loopRow === undefined) {
                        // Queue empty → teardown UNDER the per-worker drain lock (R4 / I1),
                        // serialized against ensureDrain so a concurrent inject can't
                        // start a 2nd drain in the gap. Re-claim while holding the lock;
                        // relinquish the registry slot only if it's empty too. A loop
                        // that raced in is returned and run — we stay registered, so
                        // there's no transient delete for ensureDrain to catch.
                        loopRow = await this.#withDrainLock(workerId, async () => {
                            const claimed = await claim();
                            if (claimed === undefined && this.#activeDrains.get(workerId) === handle) {
                                this.#activeDrains.delete(workerId);
                            }
                            return claimed;
                        });
                        if (loopRow === undefined) break;
                    }
                    currentLoopId = loopRow.id;
                    const onSettled = async (logEntryId: number): Promise<void> => {
                        await this.#emitLogEntry(workspaceId, logEntryId).catch((error: unknown) => {
                            console.error("log/entry broadcast failed:", error instanceof Error ? error.message : String(error));
                        });
                    };
                    const result = await observed(
                        "loop.run",
                        { workspaceId, workerId, "loop.id": loopRow.id },
                        async (span) => {
                            const loopResult = await this.#runLoop({
                                workspaceId,
                                workerId,
                                loopId: loopRow.id,
                                maxTurns: loopRow.max_turns,
                                prompt: loopRow.prompt,
                                systemPrompt,
                                signal: controller.signal,
                                onSettled,
                            });
                            span.setAttribute("status", loopResult.result.status);
                            recordCounter(LOOP_TERMINALS, { status: loopResult.result.status });
                            return loopResult;
                        },
                    );
                    if (result.result.status === 202) {
                        // The loop slept via SEND signal 202 — suspended, not terminated. Leave it at 202
                        // (resumable); no loop/terminated, no orphan-reconcile. A stream conclusion
                        // through handleWakeWorker re-queues it; if it holds a polled stream, a poll timer
                        // wakes it every P to inspect ({§exec-poll}). {§worker-lifecycle-wake-liveness}.
                        void this.schedulePollWake(workspaceId, workerId, systemPrompt).catch((err: unknown) => console.error("poll-wake scheduling failed:", err instanceof Error ? err.message : String(err)));
                        // {§send-premature-terminate}/scoped SEND signal 202 — the park deadline:
                        // dispatcher recorded the marker's seconds; a bounded park is woken at T
                        // regardless of arrivals, so a park always has a next turn. -1 (indefinite:
                        // the butler, a [300] ask) schedules nothing — irc/inject/conclusions wake it.
                        // In-memory: a daemon restart drops pending deadlines.
                        if (currentLoopId !== null) {
                            const deadline = this.#takeParkDeadline(currentLoopId);
                            const prior = this.#parkTimers.get(workerId);
                            if (prior !== undefined) { clearTimeout(prior); this.#parkTimers.delete(workerId); }
                            if (deadline !== undefined && deadline > 0) {
                                const t = setTimeout(() => {
                                    this.#parkTimers.delete(workerId);
                                    void this.#wakeParkedWorker(workspaceId, workerId, systemPrompt).catch((err: unknown) => console.error("park-deadline wake failed:", err instanceof Error ? err.message : String(err)));
                                }, deadline * 1000);
                                t.unref();
                                this.#parkTimers.set(workerId, t);
                            }
                        }
                        // Serialize the park boundary against active prompt injection.
                        // Whichever side arrives first owns a wake edge: injection wakes
                        // an already-parked loop, while this check wakes a prompt written
                        // just before runLoop finished parking.
                        const promptWaiting = await this.#withDrainLock(workerId, async () => {
                            const prefix = promptLoopPrefix(loopRow.sequence);
                            const undelivered = await this.#db.drain_undelivered_prompts_for_loop.get<{ pathname: string }>({
                                owner_id: workerId,
                                pattern: `${prefix}%`,
                                prefix_len: prefix.length,
                                loop_id: loopRow.id,
                            });
                            if (undelivered === undefined) return false;
                            await this.#lifecycle.wake(loopRow.id);
                            return true;
                        });
                        if (promptWaiting) {
                            currentLoopId = null;
                            continue;
                        }
                        // Honor an OWED wake ({§worker-lifecycle-child-wake}): a child/stream concluded while
                        // this worker was mid-turn, before it slept — resume in place rather than park blind,
                        // so a worker hibernation always returns. The loop is 202 here; reset to
                        // claimable and the drain re-runs it on the next claim below.
                        if (this.#owedWakes.delete(workerId)) {
                            await this.#lifecycle.wake(loopRow.id);
                            currentLoopId = null;
                            continue;
                        }
                        // The loop is blocked at 202 on a live obligation ({§wait-obligation-matrix});
                        // that obligation's conclusion is its wake edge (the owed-wake above covers the
                        // conclude-before-block race). An idle wait never reaches here — it concluded at dispatch.
                        currentLoopId = null;
                        continue;
                    }
                    this.#owedWakes.delete(workerId); // the loop concluded (non-202) — no park to honor a held wake at
                    const [usage, attributions, turnIds] = await Promise.all([
                        this.#loopUsage(loopRow.id),
                        this.#loopAttributions(loopRow.id),
                        this.#lifecycle.turnIds(loopRow.id),
                    ]);
                    this.#emit(workspaceId, "loop/terminated", {
                        workerId,
                        loopId: loopRow.id,
                        result: result.result,
                        hitMaxTurns: result.hitMaxTurns,
                        turnIds,
                        usage,
                        attributions,
                    });
                    loopsDrained++;
                    const loopResult: DrainLoopResult = {
                        loopId: loopRow.id,
                        turnIds,
                        result: result.result,
                        hitMaxTurns: result.hitMaxTurns,
                        usage,
                        attributions,
                    };
                    lastResult = loopResult;
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst(loopResult);
                    }
                    // A next-turn prompt this loop ended before consuming (a
                    // wake conclusion or a runLoop-while-active prompt) is promoted to
                    // a fresh queued loop so it's never silently dropped.
                    await this.reconcileOrphanedPrompts(workerId, loopRow.id);
                    currentLoopId = null;
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // {§methods-loop-cancel} — loop.cancel / shutdown aborted the live drain. A cancellation
                    // is the loop's TERMINAL state (499), delivered via loop/terminated (runLoop no
                    // longer blocks to return it). A genuine error rejects firstLoopPromise.
                    let usage: LoopUsage = {
                        accounting: aggregateProviderAccounting([]),
                        curationWeight: null,
                        curationBudget: null,
                        contextTokens: null,
                        contextCapacity: null,
                        meta: {},
                    };
                    let attributions: string[] = [];
                    const message = ErrorDetail.preview(controller.signal.reason ?? "user_cancelled")
                        || "no reason was supplied";
                    if (currentLoopId !== null) {
                        // {§methods-loop-cancel}/{§worker-lifecycle-terminal-result} —
                        // persist the exact 499 cancellation result before broadcasting it.
                        const cancelled = await this.#lifecycle.finish(
                            currentLoopId,
                            Results.failure(
                                "lifecycle:cancel",
                                "loop-cancelled",
                                499,
                                `The loop was cancelled: ${message}.`,
                                {},
                                {
                                    reason: message,
                                    stage: "loop",
                                    retryable: false,
                                },
                            ),
                            { terminatedBy: "cancel" },
                        );
                        [usage, attributions] = await Promise.all([
                            this.#loopUsage(currentLoopId),
                            this.#loopAttributions(currentLoopId),
                        ]);
                        if (cancelled !== null) {
                            this.#emit(workspaceId, "loop/terminated", {
                                workerId,
                                loopId: currentLoopId,
                                result: cancelled,
                                hitMaxTurns: false,
                                turnIds: await this.#lifecycle.turnIds(currentLoopId),
                                usage,
                                attributions,
                            });
                        }
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst({
                            loopId: currentLoopId ?? 0,
                            turnIds: [],
                            result: currentLoopId === null
                                ? Results.failure(
                                    "lifecycle:cancel",
                                    "loop-cancelled",
                                    499,
                                    `The loop was cancelled: ${message}.`,
                                    {},
                                    {
                                        reason: message,
                                        stage: "loop",
                                        retryable: false,
                                    },
                                )
                                : await this.#lifecycle.result(currentLoopId)
                                    ?? Results.failure(
                                        "lifecycle:cancel",
                                        "loop-cancelled",
                                        499,
                                        `The loop was cancelled: ${message}.`,
                                        {},
                                        {
                                            reason: message,
                                            stage: "loop",
                                            retryable: false,
                                        },
                                    ),
                            hitMaxTurns: false,
                            usage,
                        });
                    }
                } else {
                    // {§worker-lifecycle-terminal-result} — a non-abort drain
                    // failure becomes an exact durable 500 and terminal notification;
                    // daemon diagnostics retain the complete caught error.
                    console.error(`drain error (workspace ${workspaceId}, worker ${workerId}, loop ${currentLoopId ?? "?"}):`, err);
                    if (currentLoopId !== null) {
                        const failure = err instanceof OperationFailureError
                            ? err.result
                            : Results.failure(
                                "daemon:drain",
                                "loop-threw",
                                500,
                                "The loop failed outside its operation result contract.",
                                {},
                                {
                                    stage: "loop",
                                    retryable: false,
                                },
                            );
                        const settled = await this.#lifecycle.finish(currentLoopId, failure)
                            ?? await this.#lifecycle.result(currentLoopId);
                        if (settled === null) {
                            throw new Error(`drain could not settle loop ${currentLoopId}`, { cause: err });
                        }
                        const [usage, attributions] = await Promise.all([
                            this.#loopUsage(currentLoopId),
                            this.#loopAttributions(currentLoopId),
                        ]);
                        this.#emit(workspaceId, "loop/terminated", {
                            workerId,
                            loopId: currentLoopId,
                            result: settled,
                            hitMaxTurns: false,
                            turnIds: await this.#lifecycle.turnIds(currentLoopId),
                            usage,
                            attributions,
                        });
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        rejectFirst(err);
                    }
                }
                throw err;
            } finally {
                if (!firstSettled) {
                    firstSettled = true;
                    rejectFirst(new Error("drain exited without producing a result"));
                }
                if (this.#activeDrains.get(workerId) === handle) this.#activeDrains.delete(workerId);
            }
            return { loopsDrained, lastResult };
        })();

        handle.promise = drainPromise;
        this.#activeDrains.set(workerId, handle);
        // Topology join ({§worker-loop-lifecycle}): when this drain exits having CONCLUDED the worker, wake its parent
        // if parked. Runs after the drain fully tears down (settled promise) so the quiescence check sees
        // final state; speculative (#onDrainExit no-ops unless the worker concluded AND the parent is parked).
        const drainExitTask = drainPromise.then(
            () => this.#onDrainExit(workspaceId, workerId, systemPrompt),
            () => this.#onDrainExit(workspaceId, workerId, systemPrompt),
        );
        this.#drainExitTasks.add(drainExitTask);
        void drainExitTask.catch((err: unknown) => {
            console.error(`parent wake after worker ${workerId} settlement failed:`, err);
        }).finally(() => {
            this.#drainExitTasks.delete(drainExitTask);
        });
        // Swallow unhandled rejections (drain aborts with no awaiter); the
        // error already surfaced via firstLoopPromise or was logged inside.
        drainPromise.catch(() => {});
        firstLoopPromise.catch(() => {});
        return { firstLoopPromise, drainPromise };
    }

    // Per-worker drain-transition lock (R4 / {§worker-lifecycle-single-drain}). ensureDrain's
    // start and a drain's teardown relinquish both run under it, serialized, so the two
    // can't interleave and register two drains for one worker. The critical section is the
    // registry decision only (never a loop's work) — a sub-ms hop at drain boundaries.
    // A promise-chain mutex: each caller awaits the prior holder; the tail self-prunes
    // when idle so the Map stays bounded to workers mid-transition.
    #withDrainLock<T>(workerId: number, fn: () => Promise<T>): Promise<T> {
        const prev = this.#drainLocks.get(workerId) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        const tail = run.catch(() => {});
        this.#drainLocks.set(workerId, tail);
        void tail.then(() => { if (this.#drainLocks.get(workerId) === tail) this.#drainLocks.delete(workerId); });
        return run;
    }

    // The drain guarantee, serialized per worker via #withDrainLock so it can't race a
    // sibling drain's teardown relinquish into a double-drain (R4). A live drain
    // (registered, NOT aborting) will claim the just-enqueued loop in its own iteration
    // or its lock-held exit re-claim → return null. A registered-but-ABORTING drain is
    // in teardown and won't claim, so we don't defer to it — start fresh, or the loop
    // strands on a cancel/resume race (I6 no-lost-loop). Otherwise start one.
    ensureDrain(opts: {
        workspaceId: number; workerId: number;
        systemPrompt: string;
    }): Promise<DrainStartResult | null> {
        return this.#withDrainLock(opts.workerId, async () => {
            const existing = this.#activeDrains.get(opts.workerId);
            if (existing !== undefined && !existing.controller.signal.aborted) return null;
            return this.#startDrain(opts);
        });
    }

    // Prompt promotion shares the worker lock with enqueue and drain teardown,
    // while Daemon retains the durable prompt-policy implementation.
    reconcileOrphanedPrompts(workerId: number, endedLoopId: number): Promise<void> {
        return this.#withDrainLock(workerId, () => this.#reconcilePrompts(workerId, endedLoopId));
    }

    #workerSignal(workerId: number): AbortController {
        const existing = this.#workerAborts.get(workerId);
        if (existing !== undefined && !existing.signal.aborted) return existing;
        const fresh = new AbortController();
        this.#workerAborts.set(workerId, fresh);
        return fresh;
    }

    async #cancelTree(workerId: number, reason: string, includeRoot: boolean): Promise<void> {
        const cancelled = await this.#lifecycle.cancelTree(workerId, reason, includeRoot);
        for (const targetWorkerId of cancelled.workerIds) {
            const pollTimer = this.#pollTimers.get(targetWorkerId);
            if (pollTimer !== undefined) {
                clearTimeout(pollTimer);
                this.#pollTimers.delete(targetWorkerId);
            }
            const parkTimer = this.#parkTimers.get(targetWorkerId);
            if (parkTimer !== undefined) {
                clearTimeout(parkTimer);
                this.#parkTimers.delete(targetWorkerId);
            }
            this.#pollBackoff.delete(targetWorkerId);
            this.#owedWakes.delete(targetWorkerId);
            const scope = this.#workerAborts.get(targetWorkerId);
            if (scope !== undefined && !scope.signal.aborted) scope.abort(reason);
        }
        await Promise.all(cancelled.workerIds.map(async (targetWorkerId) => this.#reapWorkerStreams(targetWorkerId)));
        for (const { loopId, workerId: targetWorkerId, result } of cancelled.loops) {
            const row = await this.#db.drain_get_worker_workspace.get<{ workspace_id: number }>({
                worker_id: targetWorkerId,
            });
            if (row === undefined) continue;
            const [usage, attributions] = await Promise.all([
                this.#loopUsage(loopId),
                this.#loopAttributions(loopId),
            ]);
            this.#emit(row.workspace_id, "loop/terminated", {
                workerId: targetWorkerId,
                loopId,
                result,
                hitMaxTurns: false,
                turnIds: await this.#lifecycle.turnIds(loopId),
                usage,
                attributions,
            });
        }
    }

    cancelWorkerTree(workerId: number, reason: string): Promise<void> {
        return this.#cancelTree(workerId, reason, true);
    }

    cancelDescendants(workerId: number, reason: string): Promise<void> {
        return this.#cancelTree(workerId, reason, false);
    }

    // {§worker-model-selection} — the 409 boundary: a worker with a live drain
    // holding a loop, or a parked (slept) loop, owns active work; a model
    // selection must not mutate underneath it.
    async hasLiveWork(workerId: number): Promise<boolean> {
        if (this.#activeDrains.has(workerId)) {
            const active = await this.#db.drain_current_loop_for_worker.get<{ id: number }>({ worker_id: workerId });
            if (active !== undefined) return true;
        }
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        return slept !== undefined;
    }

    cancel(workerId: number, reason: string = "user_cancelled"): boolean {
        const hadDrain = this.#activeDrains.has(workerId);
        const hadWork = hadDrain || this.#hasActiveStreams(workerId);
        const pollTimer = this.#pollTimers.get(workerId);
        if (pollTimer !== undefined) {
            clearTimeout(pollTimer);
            this.#pollTimers.delete(workerId);
        }
        void this.cancelWorkerTree(workerId, reason).catch((error: unknown) => {
            console.error(`cancelTree(${workerId}) failed:`, error);
        });
        return hadWork;
    }

    async #reapWorkerStreams(workerId: number): Promise<void> {
        const open = await ChannelWrite.findOpenSubscriptionsForWorker(this.#db, workerId);
        await Promise.all(open.map(({ id }) => this.#cancelSubscription(id)));
    }

    // {§module-shutdown-order}: the producer emits synchronously, while the
    // supervisor owns the asynchronous scheduler work and its shutdown truth.
    notifyWakeWorker(payload: WakeWorkerPayload): void {
        const task = this.#handleWakeWorker(payload);
        this.#wakeTasks.add(task);
        void task.then(
            () => { this.#wakeTasks.delete(task); },
            (error: unknown) => {
                this.#wakeTasks.delete(task);
                this.#wakeFailures.push(error);
                console.error("wake-on-completion failed:", error);
            },
        );
    }

    async #handleWakeWorker(payload: WakeWorkerPayload): Promise<void> {
        const { entryOwnerId, workspaceId, ...wake } = payload;
        const conclusion = { ...wake, workerId: entryOwnerId };
        // Aborted streams don't wake — the abort was deliberate.
        if (payload.result.status === 499) {
            this.#emit(workspaceId, "stream/concluded", {
                ...conclusion, wakeAction: "skipped-aborted",
            });
            return;
        }

        // No resurrection ({§worker-lifecycle-no-resurrection}): a non-499 completion whose
        // worker was cancelled (idle + its scope aborted) must not start a fresh drain —
        // the cancel was deliberate. The deliverable is already in the channel/log and
        // surfaces as a `collect` environment delta ({§env-delta}) if the worker is read or
        // resumed; we just don't inject a turn. (An active worker folds the wake into its
        // next turn via inject below; a resumed worker is active, never aborted, so it is
        // unaffected.)
        const scope = this.#workerAborts.get(payload.workerId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(payload.workerId)) {
            this.#emit(workspaceId, "stream/concluded", {
                ...conclusion, wakeAction: "skipped-cancelled",
            });
            return;
        }

        const systemPrompt = await this.#readSystemPrompt();

        // A slept (202) loop means the worker parked via SEND signal 202 → resume it in place: re-queue
        // it (202→100) so the drain re-claims and CONTINUES it (seq>1 → no re-foist). Checked
        // FIRST: the slept status is the worker's true disposition regardless of a draining
        // sibling mid-teardown (the ensureDrain lock serializes the re-claim). No fresh loop,
        // no summary-as-prompt — the resumed loop reads the concluded stream's own state from
        // the manifest. {§worker-lifecycle-wake-liveness}.
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: payload.workerId });
        if (slept !== undefined) {
            // {§worker-optimistic-settlement} — publish this conclusion now,
            // then let the worker-local gate coalesce only the provider
            // dispatch. Concurrent stream/child callbacks join that one gate.
            const settlement = this.settleCompletionWake(
                workspaceId,
                payload.workerId,
                systemPrompt,
                false,
            );
            this.#emit(workspaceId, "stream/concluded", {
                ...conclusion, wakeAction: "resumed-loop", wakeLoopId: slept.id,
            });
            await settlement;
            return;
        }

        // No slept loop. A live loop surfaces the concluded stream ambiently via the
        // environment-observation injector ({§exec-stream}) on its next turn — there is no prompt
        // to inject and NO task to overwrite. The obsolete "automated environment update"
        // synthesis (which clobbered the model's actual goal) is retired; just tell the client.
        if (this.#activeDrains.has(payload.workerId)) {
            this.#emit(workspaceId, "stream/concluded", {
                ...conclusion, wakeAction: "no-op-active-loop",
            });
            return;
        }

        // No slept loop, no active drain — nothing to resume (e.g. a SEND-200-done worker whose
        // streams were swept). Surface the conclusion without opening a loop.
        this.#emit(workspaceId, "stream/concluded", {
            ...conclusion, wakeAction: "no-loop",
        });
    }

    async schedulePollWake(workspaceId: number, workerId: number, systemPrompt: string): Promise<void> {
        const existing = this.#pollTimers.get(workerId);
        if (existing !== undefined) { clearTimeout(existing); this.#pollTimers.delete(workerId); }
        const row = await this.#db.drain_worker_min_poll.get<{ open_count: number; poll_seconds: number | null }>({ worker_id: workerId });
        if ((row?.open_count ?? 0) === 0) {
            this.#pollBackoff.delete(workerId);
            return;
        }
        const pollSec = row?.poll_seconds ?? null;
        // {§exec-poll} — a positive explicit cadence wins, zero opts out,
        // and an absent cadence uses the worker's exponential-backoff step.
        let delayMs: number;
        if (pollSec !== null && pollSec > 0) {
            this.#pollBackoff.delete(workerId);
            delayMs = pollSec * 1000;
        } else if (pollSec === 0) {
            this.#pollBackoff.delete(workerId);
            return; // explicit opt-out
        } else {
            // An open stream without an explicit cadence uses the stream polling floor.
            // Child joins never enter this branch: durable child settlement is their only wake edge.
            const base = Number(process.env.PLURNK_SERVICE_EXEC_POLL_SEC ?? "60");
            const turns = Number(process.env.PLURNK_SERVICE_EXEC_POLL_TURNS ?? "8");
            const step = this.#pollBackoff.get(workerId) ?? 0;
            delayMs = execPollBackoffMs(step, base, turns);
            this.#pollBackoff.set(workerId, step + 1);
        }
        // Floored by the optimistic settlement cap so a `<…,1>` cannot wake a
        // parked loop faster than the preceding turn's settlement scale.
        const optimisticWaitMs = readOptimisticSettlementMs();
        const timer = setTimeout(() => {
            this.#pollTimers.delete(workerId);
            void this.#wakeParkedWorker(workspaceId, workerId, systemPrompt);
        }, Math.max(delayMs, optimisticWaitMs));
        timer.unref();
        this.#pollTimers.set(workerId, timer);
    }

    /** Resume `workerId`'s slept (202) loop in place — the same 202→100 resume handleWakeWorker uses, minus a
     *  wake payload. The shared wake primitive: a poll cadence ({§exec-poll}), a watched stream concluding,
     *  or a child worker finishing ({§worker-loop-lifecycle} topology join) all call this. A no-op if the worker was
     *  cancelled or isn't actually parked (no slept loop) — so calling it speculatively is safe. */
    async #wakeParkedWorker(workspaceId: number, workerId: number, systemPrompt: string, oweIfActive = true): Promise<void> {
        if (!this.#acceptingWork) return;
        const scope = this.#workerAborts.get(workerId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(workerId)) return; // cancelled — no resurrection
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept === undefined) {
            // Not parked. If a drain is still ACTIVE, the worker is mid-turn and about to park — the
            // conclusion that fired this wake arrived before the 202 committed (the conclude-before-park
            // race). Owe the wake: the drain honors it at park so a worker hibernation never deadlocks.
            // (No active drain → already concluded/running; nothing to wake.)
            if (this.#activeDrains.has(workerId)) {
                if (oweIfActive) this.#owedWakes.add(workerId);
            }
            return;
        }
        const woke = await this.#lifecycle.wake(slept.id);
        if (!woke) return;
        const started = await this.ensureDrain({
            workspaceId, workerId, systemPrompt,
        });
        started?.drainPromise?.catch((err: unknown) => {
            if (this.#acceptingWork) {
                console.error("wake-parked resume drain failed:", err instanceof Error ? err.message : String(err));
            }
        });
    }

    async #workerHasLiveObligation(workerId: number): Promise<boolean> {
        const [openSubscriptions, liveChild] = await Promise.all([
            this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId }),
            this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId }),
        ]);
        return openSubscriptions.length > 0 || liveChild !== undefined;
    }

    settleCompletionWake(
        workspaceId: number,
        workerId: number,
        systemPrompt: string,
        oweIfActive = true,
    ): Promise<void> {
        const existing = this.#completionWakeGates.get(workerId);
        if (existing !== undefined) {
            existing.conclusions++;
            existing.poke.resolve();
            return existing.promise;
        }

        const completed = Promise.withResolvers<void>();
        const gate: CompletionWakeGate = {
            conclusions: 1,
            poke: Promise.withResolvers<void>(),
            promise: completed.promise,
        };
        this.#completionWakeGates.set(workerId, gate);
        void this.#runCompletionWake(
            workspaceId,
            workerId,
            systemPrompt,
            oweIfActive,
            gate,
        ).then(completed.resolve, completed.reject).finally(() => {
            if (this.#completionWakeGates.get(workerId) === gate) {
                this.#completionWakeGates.delete(workerId);
            }
        });
        return gate.promise;
    }

    async #runCompletionWake(
        workspaceId: number,
        workerId: number,
        systemPrompt: string,
        oweIfActive: boolean,
        gate: CompletionWakeGate,
    ): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept === undefined) {
            this.#releaseCompletionWake(workerId, gate);
            return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt, oweIfActive);
        }

        const timeoutMs = readOptimisticSettlementMs();
        if (timeoutMs === 0 || !(await this.#workerHasLiveObligation(workerId))) {
            this.#releaseCompletionWake(workerId, gate);
            return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt, false);
        }

        return observed(
            "worker.wake.settlement",
            { "window.ms": timeoutMs },
            async (span) => {
                const startedAt = performance.now();
                const signal = this.#workerAborts.get(workerId)?.signal;
                const deadline = delay(timeoutMs, "deadline" as const, { signal, ref: false })
                    .catch((cause: unknown) => {
                        if (signal?.aborted === true) return "cancelled" as const;
                        throw cause;
                    });
                let release: "quiescent" | "deadline" | "cancelled" = "quiescent";
                while (await this.#workerHasLiveObligation(workerId)) {
                    const poke = gate.poke;
                    const outcome = await Promise.race([
                        poke.promise.then(() => "arrival" as const),
                        deadline,
                    ]);
                    if (outcome === "arrival") {
                        if (gate.poke === poke) gate.poke = Promise.withResolvers<void>();
                        continue;
                    }
                    release = outcome;
                    break;
                }
                span.setAttribute("release", release);
                span.setAttribute("conclusions", gate.conclusions);
                span.setAttribute("elapsed.ms", Math.round(performance.now() - startedAt));
                this.#releaseCompletionWake(workerId, gate);
                if (release === "cancelled") return;
                return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt, false);
            },
        );
    }

    #releaseCompletionWake(workerId: number, gate: CompletionWakeGate): void {
        if (this.#completionWakeGates.get(workerId) === gate) {
            this.#completionWakeGates.delete(workerId);
        }
    }

    /** A worker's drain exited. If the worker truly CONCLUDED — no 202-blocked loop, no open stream — then
     *  wake its PARENT in place if the parent is blocked on the join (the structured-concurrency join — a
     *  child finishing is the wake edge for a parent that waited on it, {§worker-lifecycle-child-wake}). A worker
     *  blocked at 202, or still holding a stream, is NOT concluded — its own wake edges drive it, not this.
     *  The parent reads the child's deliverable from its own log (the {§worker-scheme-collect} delta) on
     *  resume — control edge here, never an injected prompt. Recurses up via the parent's own drain-exit. */
    async #onDrainExit(workspaceId: number, workerId: number, systemPrompt: string): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept !== undefined) return; // parked at 202 — not concluded, the worker is still alive
        const openSubs = await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        if (openSubs.length > 0) return; // a stream still runs — its conclusion re-evaluates, not this exit
        const parent = await this.#db.worker_parent_id.get<{ parent_worker_id: number | null }>({ worker_id: workerId });
        if (parent?.parent_worker_id == null) return; // a root worker — nobody to wake
        await this.settleCompletionWake(workspaceId, parent.parent_worker_id, systemPrompt);
    }
}
