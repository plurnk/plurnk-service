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
import LoopLifecycle, { taskTiming, type TaskSchedule, type TaskTiming } from "../core/LoopLifecycle.ts";
import { DEFAULT_LOOP_POLICY } from "../core/scheme-types.ts";
import type { LoopPolicy } from "../core/types.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import { observed } from "../observe/spans.ts";
import { LOOP_TERMINALS, recordCounter } from "../observe/metrics.ts";
import { readOptimisticSettlementMs } from "../core/optimistic-settlement.ts";
import { promptLoopPrefix } from "../core/plurnk-uri.ts";
import { execPollBackoffMs } from "./exec-poll-backoff.ts";

interface DrainLoopResult {
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
    // Absent for an independent exterior arrival, required for operation-caused delivery.
    sourceLoopId?: number;
    schedule?: TaskSchedule;
    providerSpec: ProviderSpec;
    reasoningPolicy: ReasoningPolicy;
    // False = the client omitted a selector; a continuation must keep the loop's
    // durable provider rather than compare against a re-resolved boot default.
    // Absent/true = an explicit selection, so the compatibility check applies.
    providerSpecExplicit?: boolean;
    systemPrompt: string;
    childProviderSpec?: ProviderSpec | null;
    turnCeiling?: TurnCeilingSelection;
    policy?: Partial<LoopPolicy>;
    // Delegated authority applies only when injection creates a fresh loop;
    // active and parked loops retain their immutable policy.
    freshLoopPolicy?: LoopPolicy;
    openPaths?: string[];
};

export type DrainInjectionResult = TaskTiming & {
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
    "workerId" | "providerSpec" | "providerSpecExplicit" | "reasoningPolicy" | "childProviderSpec" | "turnCeiling" | "policy"
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
    loopId: number,
    prompt: string,
    openPaths: readonly string[],
    source?: string,
) => Promise<{ loopId: number; turnSeq: number } | null>;
type AssertInjectionCompatibility = (args: InjectionCompatibility) => Promise<void>;
type ReconcilePrompts = (workerId: number, endedLoopId: number) => Promise<void>;
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
    readonly #cancelSubscription: (subscriptionId: number) => Promise<boolean>;
    readonly #hasActiveStreams: (workerId: number) => boolean;
    readonly #readSystemPrompt: () => Promise<string>;
    readonly #emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
    readonly #emit: EmitEvent;

    // The handle is the drain identity. Start/exit compare by reference so an
    // exiting drain cannot clobber a successor that raced in.
    readonly #activeDrains = new Map<number, { controller: AbortController; promise: Promise<unknown> }>();
    readonly #settlementTasks = new Set<Promise<void>>();
    readonly #settlementFailures: unknown[] = [];
    // One cancellation scope spans a worker's loops and streams. It outlives
    // any single drain and is replaced only after it has been aborted.
    readonly #workerAborts = new Map<number, AbortController>();
    readonly #loopTimers = new Map<number, {
        workerId: number; status: 100 | 202; revision: number; dueAt: number; timer: NodeJS.Timeout;
    }>();
    readonly #pollBackoff = new Map<number, number>();
    readonly #drainLocks = new Map<number, Promise<unknown>>();
    readonly #admissionLocks = new Map<number, Promise<unknown>>();
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
        for (const { timer } of this.#loopTimers.values()) clearTimeout(timer);
        this.#pollBackoff.clear();
        this.#loopTimers.clear();
    }

    async idle(): Promise<void> {
        for (;;) {
            const pending = [
                ...[...this.#activeDrains.values()].map(({ promise }) => promise),
                ...this.#settlementTasks,
            ];
            if (pending.length === 0) break;
            await Promise.allSettled(pending);
        }
        const failures = this.#settlementFailures.splice(0);
        if (failures.length > 0) {
            throw new AggregateError(failures, "worker lifecycle settlement failed");
        }
    }

    async inject(args: DrainInjectionArgs): Promise<DrainInjectionResult> {
        if (args.policy !== undefined && args.freshLoopPolicy !== undefined) {
            throw new Error("drain injection cannot combine an explicit policy with a fresh-loop policy");
        }
        const { workspaceId, workerId, prompt } = args;
        const delivery = await this.#withAdmissionLock(workspaceId, () => this.#withDrainLock(workerId, async () => {
            if (!this.#acceptingWork) throw new Error("The daemon is not accepting work.");
            if (args.sourceLoopId !== undefined) {
                const source = await this.#db.drain_message_source.get<{ workspace_id: number; status: number }>({
                    loop_id: args.sourceLoopId,
                });
                if (source === undefined || source.workspace_id !== workspaceId) {
                    throw new Error(`message source loop ${args.sourceLoopId} does not belong to workspace ${workspaceId}`);
                }
                if (source.status !== 102) {
                    throw new OperationFailureError(Results.failure(
                        "daemon:admission", "source-not-running", 409,
                        `The originating task is not running (status ${source.status}); no message was admitted.`,
                        {}, { loopId: args.sourceLoopId, sourceStatus: source.status, retryable: false },
                    ));
                }
            }
            const active = args.schedule === undefined
                ? await this.#db.drain_current_loop_for_worker.get<{ id: number }>({ worker_id: workerId })
                : undefined;
            if (active !== undefined) {
                await this.#assertInjectionCompatibility({
                    workerId,
                    loopId: active.id,
                    providerSpec: args.providerSpec,
                    providerSpecExplicit: args.providerSpecExplicit,
                    reasoningPolicy: args.reasoningPolicy,
                    ...(args.childProviderSpec === undefined ? {} : { childProviderSpec: args.childProviderSpec }),
                    ...(args.turnCeiling === undefined ? {} : { turnCeiling: args.turnCeiling }),
                    ...(args.policy === undefined ? {} : { policy: args.policy }),
                });
            }
            const result = active === undefined ? null
                : await this.#injectPrompt(active.id, prompt, args.openPaths ?? [], args.source);
            if (result !== null) {
                // runLoop may already have parked in the database while this drain
                // is still registered. Wake that state now; if it is still running,
                // the serialized park-boundary check below supplies the wake edge.
                await this.#wakeLoop(workerId, result.loopId);
                return { action: "injected_next_turn", loopId: result.loopId, turnSeq: result.turnSeq } as const;
            }
            const accepted = await this.#enqueueFreshLoop({
                workerId,
                prompt,
                ...(args.source === undefined ? {} : { source: args.source }),
                providerSpec: args.providerSpec,
                reasoningPolicy: args.reasoningPolicy,
                childProviderSpec: args.childProviderSpec ?? null,
                maxTurns: args.turnCeiling?.effective,
                policy: args.policy ?? args.freshLoopPolicy,
                openPaths: args.openPaths,
                schedule: args.schedule,
            });
            return { action: "enqueued_new_loop", ...accepted } as const;
        }));
        const started = await this.ensureDrain({ workspaceId, workerId, systemPrompt: args.systemPrompt });
        return { ...delivery, ...(started ?? {}) };
    }

    async #enqueueFreshLoop(args: {
        workerId: number;
        prompt: string;
        source?: string;
        providerSpec: ProviderSpec;
        reasoningPolicy: ReasoningPolicy;
        childProviderSpec: ProviderSpec | null;
        maxTurns?: number;
        policy?: Partial<LoopPolicy>;
        openPaths?: string[];
        schedule?: TaskSchedule;
    }): Promise<{ loopId: number } & TaskTiming> {
        const now = Date.now();
        if (args.schedule !== undefined) {
            const { delayMs, intervalMs } = args.schedule;
            if (!Number.isSafeInteger(delayMs) || delayMs < 0 || now + delayMs > 8.64e15
                || (intervalMs !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || now + delayMs + intervalMs > 8.64e15))) {
                throw new TypeError("task schedule requires nonnegative delay and positive interval in safe integer milliseconds within the supported date range");
            }
        }
        // {§worker-model-selection} — resolve the complete route before persistence;
        // the loop snapshot stores the immutable route ids, never re-serialized JSON.
        const modelRouteId = await routeForSpec(this.#db, args.providerSpec);
        const spawnRouteId = await routeForSpec(this.#db, args.childProviderSpec);
        const loopRow = await this.#db.drain_enqueue_loop.get<{
            id: number; scheduled_at: number | null; repeat_interval_ms: number | null;
        }>({
            worker_id: args.workerId,
            prompt: args.prompt,
            prompt_source: args.source ?? null,
            model_route_id: modelRouteId,
            spawn_model_route_id: spawnRouteId,
            reasoning_policy: args.reasoningPolicy,
            max_turns: args.maxTurns ?? Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
            policy: JSON.stringify({ ...DEFAULT_LOOP_POLICY, ...args.policy }),
            open_paths: JSON.stringify(args.openPaths ?? []),
            scheduled_at: args.schedule === undefined ? null : now + args.schedule.delayMs,
            repeat_interval_ms: args.schedule?.intervalMs ?? null,
        });
        if (loopRow === undefined) throw new Error("enqueueFreshLoop: loop enqueue returned no row");
        return { loopId: loopRow.id, ...taskTiming(loopRow) };
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
        }>({ worker_id: workerId, now: Date.now() });

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
                    this.#clearLoopTimer(loopRow.id);
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
                        // The loop parked — suspended, not terminated. Leave it at 202
                        // (resumable); no loop/terminated, no orphan-reconcile. A stream conclusion
                        // through handleWakeWorker re-queues it; if it holds a polled stream, a poll timer
                        // wakes it every P to inspect ({§exec-poll}). {§worker-lifecycle-wake-liveness}.
                        await this.scheduleWakes(workspaceId, workerId, systemPrompt);
                        // Serialize the park boundary against active prompt injection.
                        // Whichever side arrives first owns a wake edge: injection wakes
                        // an already-parked loop, while this check wakes a prompt written
                        // just before runLoop finished parking.
                        const promptWaiting = await this.#withDrainLock(workerId, async () => {
                            const prefix = promptLoopPrefix(loopRow.sequence);
                            const undelivered = await this.#db.drain_undelivered_prompts_for_loop.get<{ pathname: string }>({
                                worker_id: workerId,
                                pattern: `${prefix}%`,
                                prefix_len: prefix.length,
                                loop_id: loopRow.id,
                            });
                            if (undelivered === undefined) return false;
                            return this.#wakeLoop(workerId, loopRow.id);
                        });
                        if (promptWaiting) {
                            currentLoopId = null;
                            continue;
                        }
                        // {§loop-wake-identity}: events observed by another loop
                        // cannot consume this loop's completion wake.
                        if (await this.#wakeLoop(workerId, loopRow.id, { eventOnly: true })) {
                            currentLoopId = null;
                            continue;
                        }
                        // {§worker-wait-timing}: the wait now belongs to its
                        // durable clock or completion obligations, not this drain.
                        currentLoopId = null;
                        continue;
                    }
                    this.#pollBackoff.delete(loopRow.id);
                    const [usage, attributions, turnIds] = await Promise.all([
                        this.#loopUsage(loopRow.id),
                        this.#loopAttributions(loopRow.id),
                        this.#lifecycle.turnIds(loopRow.id),
                    ]);
                    this.#publishTermination(workspaceId, {
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
                            this.#publishTermination(workspaceId, {
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
                        this.#publishTermination(workspaceId, {
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
                await this.scheduleWakes(workspaceId, workerId, systemPrompt);
            }
            return { loopsDrained, lastResult };
        })();

        handle.promise = drainPromise;
        this.#activeDrains.set(workerId, handle);
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
        return DrainSupervisor.#withLock(this.#drainLocks, workerId, fn);
    }

    // {§worker-causal-admission}: workspace control precedes worker queue control;
    // neither encloses provider/tool execution or waits for a drain to finish.
    #withAdmissionLock<T>(workspaceId: number, fn: () => Promise<T>): Promise<T> {
        return DrainSupervisor.#withLock(this.#admissionLocks, workspaceId, fn);
    }

    static #withLock<T>(locks: Map<number, Promise<unknown>>, id: number, fn: () => Promise<T>): Promise<T> {
        const prev = locks.get(id) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        const tail = run.catch(() => {});
        locks.set(id, tail);
        void tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
        return run;
    }

    // The drain guarantee, serialized per worker via #withDrainLock so it can't race a
    // sibling drain's teardown relinquish into a double-drain (R4). A live drain
    // (registered, NOT aborting) will claim the just-enqueued loop in its own iteration
    // or its lock-held exit re-claim → return null. A registered-but-ABORTING drain is
    // in teardown and won't claim, so we don't defer to it — start fresh, or the loop
    // strands on a cancel/resume race (I6 no-lost-loop). Otherwise start one.
    async ensureDrain(opts: {
        workspaceId: number; workerId: number;
        systemPrompt: string;
    }): Promise<DrainStartResult | null> {
        let deferred = false;
        const started = await this.#withDrainLock(opts.workerId, async () => {
            if (!this.#acceptingWork) return null;
            const existing = this.#activeDrains.get(opts.workerId);
            if (existing !== undefined && !existing.controller.signal.aborted) return null;
            if (await this.#db.drain_ready_loop.get({ worker_id: opts.workerId, now: Date.now() }) === undefined) {
                deferred = true;
                return null;
            }
            if (!this.#acceptingWork) return null;
            return this.#startDrain(opts);
        });
        if (deferred) await this.scheduleWakes(opts.workspaceId, opts.workerId, opts.systemPrompt);
        return started;
    }

    // Prompt promotion shares the worker lock with enqueue and drain teardown,
    // while Daemon retains the durable prompt-policy implementation.
    async reconcileOrphanedPrompts(workerId: number, endedLoopId: number): Promise<void> {
        const row = await this.#db.drain_get_worker_workspace.get<{ workspace_id: number }>({ worker_id: workerId });
        if (row === undefined) throw new Error(`prompt promotion worker ${workerId} does not exist`);
        return this.#withAdmissionLock(row.workspace_id, () =>
            this.#withDrainLock(workerId, () => this.#reconcilePrompts(workerId, endedLoopId)));
    }

    #workerSignal(workerId: number): AbortController {
        const existing = this.#workerAborts.get(workerId);
        if (existing !== undefined && !existing.signal.aborted) return existing;
        const fresh = new AbortController();
        this.#workerAborts.set(workerId, fresh);
        return fresh;
    }

    async #cancelTree(workerId: number, reason: string, includeRoot: boolean): Promise<void> {
        const owner = await this.#db.drain_get_worker_workspace.get<{ workspace_id: number }>({ worker_id: workerId });
        if (owner === undefined) throw new Error(`cancellation worker ${workerId} does not exist`);
        const { cancelled, subscriptions } = await this.#withAdmissionLock(owner.workspace_id, async () => {
            const cancelled = await this.#lifecycle.cancelTree(workerId, reason, includeRoot);
            const subscriptions = (await Promise.all(cancelled.workerIds.map((id) =>
                ChannelWrite.findOpenSubscriptionsForWorker(this.#db, id)))).flat();
            for (const targetWorkerId of cancelled.workerIds) {
                for (const [loopId, timer] of this.#loopTimers) {
                    if (timer.workerId === targetWorkerId) this.#clearLoopTimer(loopId);
                }
                const scope = this.#workerAborts.get(targetWorkerId);
                if (scope !== undefined && !scope.signal.aborted) scope.abort(reason);
            }
            return { cancelled, subscriptions };
        });
        for (const { loopId } of cancelled.loops) this.#pollBackoff.delete(loopId);
        await Promise.all(subscriptions.map(({ id }) => this.#cancelSubscription(id)));
        for (const { loopId, workerId: targetWorkerId, result } of cancelled.loops) {
            const row = await this.#db.drain_get_worker_workspace.get<{ workspace_id: number }>({
                worker_id: targetWorkerId,
            });
            if (row === undefined) continue;
            const [usage, attributions] = await Promise.all([
                this.#loopUsage(loopId),
                this.#loopAttributions(loopId),
            ]);
            this.#publishTermination(row.workspace_id, {
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
        return this.#trackSettlement(this.#cancelTree(workerId, reason, true), `cancelTree(${workerId})`);
    }

    cancelDescendants(workerId: number, reason: string): Promise<void> {
        return this.#trackSettlement(this.#cancelTree(workerId, reason, false), `cancelDescendants(${workerId})`);
    }

    cancel(workerId: number, reason: string = "user_cancelled"): boolean {
        const hadDrain = this.#activeDrains.has(workerId);
        const hadWork = hadDrain || this.#hasActiveStreams(workerId);
        void this.cancelWorkerTree(workerId, reason);
        return hadWork;
    }

    // {§module-shutdown-order}: the producer emits synchronously, while the
    // supervisor owns the asynchronous scheduler work and its shutdown truth.
    notifyWakeWorker(payload: WakeWorkerPayload): void {
        this.#trackSettlement(this.#handleWakeWorker(payload), "wake-on-completion");
    }

    #trackSettlement(task: Promise<void>, label: string): Promise<void> {
        this.#settlementTasks.add(task);
        void task.then(
            () => { this.#settlementTasks.delete(task); },
            (error: unknown) => {
                this.#settlementTasks.delete(task);
                this.#settlementFailures.push(error);
                console.error(`${label} failed:`, error);
            },
        );
        return task;
    }

    async #handleWakeWorker(payload: WakeWorkerPayload): Promise<void> {
        const { workspaceId, ...conclusion } = payload;
        // {§worker-lifecycle-no-resurrection}: scope cancellation, not the
        // command's result code, prevents a wake. Cancelling one command still
        // produces an observation owed to its live worker.
        const scope = this.#workerAborts.get(payload.workerId);
        if (scope?.signal.aborted === true) {
            this.#emit(workspaceId, "stream/concluded", {
                ...conclusion, wakeAction: payload.result.status === 499 ? "skipped-aborted" : "skipped-cancelled",
            });
            return;
        }

        const systemPrompt = await this.#readSystemPrompt();

        // {§notifications-stream-concluded}: publish the terminal stream fact
        // before settlement. Rechecked wait identities, not this event, decide
        // whether any loop actually resumes.
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: payload.workerId });
        if (slept !== undefined) {
            // {§worker-optimistic-settlement} — publish this conclusion now,
            // then let the worker-local gate coalesce only the provider
            // dispatch. Concurrent stream/child callbacks join that one gate.
            const settlement = this.settleCompletionWake(
                workspaceId,
                payload.workerId,
                systemPrompt,
            );
            this.#emit(workspaceId, "stream/concluded", {
                ...conclusion, wakeAction: "wake-pending",
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

        // No slept loop, no active drain — nothing to resume (e.g. a completed worker whose
        // streams were swept). Surface the conclusion without opening a loop.
        this.#emit(workspaceId, "stream/concluded", {
            ...conclusion, wakeAction: "no-loop",
        });
    }

    #clearLoopTimer(loopId: number): void {
        const current = this.#loopTimers.get(loopId);
        if (current === undefined) return;
        clearTimeout(current.timer);
        this.#loopTimers.delete(loopId);
    }

    async scheduleWakes(workspaceId: number, workerId: number, systemPrompt: string): Promise<void> {
        await this.#withDrainLock(workerId, async () => {
            if (!this.#acceptingWork) return;
            const waits = await this.#lifecycle.parked(workerId);
            const queued = await this.#db.drain_scheduled_loops.all<{
                id: number; wait_revision: number; scheduled_at: number;
            }>({ worker_id: workerId });
            if (!this.#acceptingWork) return;
            for (const [loopId, timer] of this.#loopTimers) {
                if (timer.workerId === workerId && !waits.some(({ id }) => id === loopId)
                    && !queued.some(({ id }) => id === loopId)) this.#clearLoopTimer(loopId);
            }
            for (const wait of waits) {
                if (wait.wait_poll_interval === null && wait.wait_poll_at === null) {
                    const interval = await this.#inheritedPollMs(workerId, wait.id);
                    if (!this.#acceptingWork) return;
                    if (interval !== null) {
                        wait.wait_poll_at = Date.now() + interval;
                        await this.#lifecycle.inheritPoll(wait.id, wait.wait_revision, wait.wait_poll_at);
                    }
                }
                const dueAt = Math.min(wait.wait_deadline_at ?? Infinity, wait.wait_poll_at ?? Infinity);
                if (!Number.isFinite(dueAt)) continue;
                this.#armTimer(workspaceId, workerId, systemPrompt, wait.id, 202, wait.wait_revision, dueAt);
            }
            for (const task of queued) {
                this.#armTimer(workspaceId, workerId, systemPrompt, task.id, 100, task.wait_revision, task.scheduled_at);
            }
        });
    }

    #armTimer(workspaceId: number, workerId: number, systemPrompt: string, loopId: number, status: 100 | 202, revision: number, dueAt: number): void {
        if (!this.#acceptingWork) return;
        const prior = this.#loopTimers.get(loopId);
        if (prior?.revision === revision && prior.status === status && prior.dueAt === dueAt) return;
        this.#clearLoopTimer(loopId);
        const timer = setTimeout(() => {
            if (this.#loopTimers.get(loopId)?.timer !== timer) return;
            this.#loopTimers.delete(loopId);
            this.#trackSettlement(this.#wakeTimedLoop(workspaceId, workerId, systemPrompt, loopId, status, revision), "wake-on-completion");
        }, Math.max(1, Math.min(dueAt - Date.now(), 2_147_483_647)));
        timer.unref();
        this.#loopTimers.set(loopId, { workerId, status, revision, dueAt, timer });
    }

    async #wakeTimedLoop(workspaceId: number, workerId: number, systemPrompt: string, loopId: number, status: 100 | 202, revision: number): Promise<void> {
        if (!this.#acceptingWork) return;
        if (status === 100 || await this.#wakeLoop(workerId, loopId, { revision, dueAt: Date.now() })) {
            await this.ensureDrain({ workspaceId, workerId, systemPrompt });
        } else {
            // A capped timer or backwards clock may fire before the durable due time.
            await this.scheduleWakes(workspaceId, workerId, systemPrompt);
        }
    }

    async #inheritedPollMs(workerId: number, loopId: number): Promise<number | null> {
        const row = await this.#db.drain_worker_min_poll.get<{ open_count: number; poll_seconds: number | null }>({ worker_id: workerId });
        if (!this.#acceptingWork) return null;
        if ((row?.open_count ?? 0) === 0) {
            this.#pollBackoff.delete(loopId);
            return null;
        }
        const pollSec = row?.poll_seconds ?? null;
        // {§exec-poll} — a positive explicit cadence wins, zero opts out,
        // and an absent cadence uses the worker's exponential-backoff step.
        let delayMs: number;
        if (pollSec !== null && pollSec > 0) {
            this.#pollBackoff.delete(loopId);
            delayMs = pollSec * 1000;
        } else if (pollSec === 0) {
            this.#pollBackoff.delete(loopId);
            return null; // explicit opt-out
        } else {
            // An open stream without an explicit cadence uses the stream polling floor.
            // Child joins never enter this branch: durable child settlement is their only wake edge.
            const base = Number(process.env.PLURNK_SERVICE_EXEC_POLL_SEC ?? "60");
            const turns = Number(process.env.PLURNK_SERVICE_EXEC_POLL_TURNS ?? "8");
            const step = this.#pollBackoff.get(loopId) ?? 0;
            delayMs = execPollBackoffMs(step, base, turns);
            this.#pollBackoff.set(loopId, step + 1);
        }
        // Floored by the optimistic settlement cap so a `<…,1>` cannot wake a
        // parked loop faster than the preceding turn's settlement scale.
        return Math.max(delayMs, readOptimisticSettlementMs());
    }

    async #wakeLoop(workerId: number, loopId: number, condition: Parameters<LoopLifecycle["wake"]>[1] = {}): Promise<boolean> {
        // {§worker-lifecycle-durable-disposition}: test admission at the mutation,
        // after asynchronous prompt, completion, or deadline selection.
        if (!this.#acceptingWork || this.#workerAborts.get(workerId)?.signal.aborted) return false;
        return this.#lifecycle.wake(loopId, condition);
    }

    async #wakeParkedWorker(workspaceId: number, workerId: number, systemPrompt: string): Promise<void> {
        if (!this.#acceptingWork) return;
        const waits = await this.#lifecycle.parked(workerId);
        let woke = false;
        for (const wait of waits) {
            if (await this.#wakeLoop(workerId, wait.id, { revision: wait.wait_revision, eventOnly: true })) {
                this.#clearLoopTimer(wait.id);
                woke = true;
            }
        }
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
        // {§worker-obligations} — the same row the completion gate reads.
        const held = await this.#db.worker_live_obligations.get<{ streams: 0 | 1; workers: 0 | 1 }>({ worker_id: workerId });
        return held !== undefined && (held.streams === 1 || held.workers === 1);
    }

    settleCompletionWake(
        workspaceId: number,
        workerId: number,
        systemPrompt: string,
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
        gate: CompletionWakeGate,
    ): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept === undefined) {
            this.#releaseCompletionWake(workerId, gate);
            return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt);
        }

        const timeoutMs = readOptimisticSettlementMs();
        if (timeoutMs === 0 || !(await this.#workerHasLiveObligation(workerId))) {
            this.#releaseCompletionWake(workerId, gate);
            return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt);
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
                return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt);
            },
        );
    }

    #releaseCompletionWake(workerId: number, gate: CompletionWakeGate): void {
        if (this.#completionWakeGates.get(workerId) === gate) {
            this.#completionWakeGates.delete(workerId);
        }
    }

    #publishTermination(workspaceId: number, event: DrainLoopResult & { workerId: number }): void {
        this.#emit(workspaceId, "loop/terminated", event);
        this.#trackSettlement(this.#notifyParentCompletion(workspaceId, event.workerId), "wake-on-completion");
    }

    // {§worker-lifecycle-child-wake}: completion belongs to a task, not drain teardown.
    async #notifyParentCompletion(workspaceId: number, workerId: number): Promise<void> {
        const parent = await this.#db.worker_parent_id.get<{ parent_worker_id: number | null }>({ worker_id: workerId });
        if (parent?.parent_worker_id == null) return;
        await this.settleCompletionWake(workspaceId, parent.parent_worker_id, await this.#readSystemPrompt());
    }
}
