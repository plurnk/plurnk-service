// {§session-loop-lifecycle} {§session-wait-timing} {§session-causal-admission}
// Per-session state-machine actor owning serialized queue transitions, rotated cancellation
// epochs, session-local poll timers, non-sliding completion wake coalescing, and local stream
// announcement barriers, self-reaping synchronously upon quiescence.

import { setTimeout as delay } from "node:timers/promises";
import type {
    DaemonNotificationEvent,
    DaemonNotificationPayloadMap,
    Effort,
    MessageEvidence,
} from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import { aggregateProviderAccounting, type ProviderSpec } from "@plurnk/plurnk-providers";
import type { MessageOpener, WakeSessionPayload } from "../core/ChannelWrite.ts";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import type { LoopUsage } from "../core/Engine.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import type LoopLifecycle from "../core/LoopLifecycle.ts";
import { readOptimisticSettlementMs } from "../core/optimistic-settlement.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import { LOOP_TERMINALS, recordCounter } from "../observe/metrics.ts";
import { observed } from "../observe/spans.ts";
import { daemonFailure } from "./daemon-results.ts";
import { routeForSpec } from "./model-route.ts";

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

export type DrainPolicyResolution = {
    providerSpec: ProviderSpec;
    effort: Effort;
    childProviderSpec: ProviderSpec | null;
};

export type DrainInjectionArgs = {
    workspaceId: number;
    sessionId: number;
    loopId?: number;
    prompt: string;
    source?: string;
    messageAddress?: string;
    evidence?: MessageEvidence;
    // Absent for an independent exterior arrival, required for operation-caused delivery.
    sourceLoopId?: number;
    providerSpec?: ProviderSpec;
    effort?: Effort;
    resolvePolicy?: (context: { activeLoopId: number | undefined }) => Promise<DrainPolicyResolution>;
    systemPrompt: string;
    childProviderSpec?: ProviderSpec | null;
    turnCeiling?: TurnCeilingSelection;
    openPaths?: string[];
    // {§loop-completion} — the session's own operation that sends the message.
    opener?: MessageOpener;
};

export type AdmittedDelivery = {
    action: "injected_next_turn" | "enqueued_new_loop";
    loopId: number;
    messageId: number;
    turnSeq?: number;
};

export type DrainInjectionResult = AdmittedDelivery & {
    firstLoopPromise?: Promise<DrainLoopResult>;
    drainPromise?: Promise<unknown>;
};

export type DrainStartResult = {
    firstLoopPromise: Promise<DrainLoopResult>;
    drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
};

export type RunLoop = (args: {
    workspaceId: number;
    sessionId: number;
    loopId: number;
    maxTurns: number;
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal;
    onSettled: (logEntryId: number) => Promise<void>;
}) => Promise<{ result: SchemeResult; hitMaxTurns: boolean }>;

export type DrainEngine = Pick<
    Engine,
    | "injectIntoLoop"
    | "loopUsage"
    | "loopAttributions"
    | "discardLoopNotices"
    | "cancelSubscription"
    | "subscriptionConcluded"
    | "reapLoopStreams"
>;

export type EmitEvent = <E extends DaemonNotificationEvent>(
    workspaceId: number,
    method: E,
    params: DaemonNotificationPayloadMap[E],
) => void;

export type SessionProcessState =
    | "idle"
    | "running"
    | "settling_exit"
    | "parked"
    | "coalescing"
    | "suspended"
    | "stopped";

export type ParkedNotification = Readonly<{
    workspaceId: number;
    sessionId: number;
    loopId: number;
    remainedParked: boolean;
}>;

type ClaimedLoop = {
    id: number;
    sequence: number;
    prompt: string;
    max_turns: number;
};

type IncarnationHandle = {
    readonly controller: AbortController;
    promise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
    readonly first: {
        settled: boolean;
        resolve: (result: DrainLoopResult) => void;
        reject: (error: unknown) => void;
    };
};

type PollTimerEntry = {
    readonly revision: number;
    readonly dueAt: number;
    readonly timer: NodeJS.Timeout;
};

type CoalesceGate = {
    conclusions: number;
    systemPrompt: string;
    poke: PromiseWithResolvers<void>;
    readonly signal: AbortSignal;
    readonly promise: Promise<void>;
};

export default class SessionProcess {
    readonly sessionId: number;
    readonly #db: Db;
    readonly #engine: DrainEngine;
    readonly #lifecycle: LoopLifecycle;
    readonly #runLoop: RunLoop;
    readonly #hasActiveStreams: (sessionId: number) => boolean;
    readonly #readSystemPrompt: () => Promise<string>;
    readonly #emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
    readonly #emit: EmitEvent;
    readonly #isAcceptingWork: () => boolean;
    readonly #isStopping: () => boolean;
    readonly #trackSettlement: (task: Promise<void>, label: string) => Promise<void>;
    readonly #requestDrain: (opts: { workspaceId: number; sessionId: number; systemPrompt: string }) => Promise<DrainStartResult | null>;
    readonly #requestCompletionWake: (workspaceId: number, sessionId: number, systemPrompt: string) => Promise<void>;
    readonly #onParked: (event: ParkedNotification) => Promise<void>;
    readonly #onQuiescent: (process: SessionProcess) => void;

    #controlTail: Promise<unknown> = Promise.resolve();
    #controlPendingCount = 0;
    #epochController = new AbortController();
    #incarnation: IncarnationHandle | null = null;
    #activeIncarnationFibers = new Set<Promise<unknown>>();
    #settlingCount = 0;
    #pendingAnnouncements = 0;
    readonly #timers = new Map<number, PollTimerEntry>();
    readonly #streamAnnouncements = new Map<number, Promise<void>>();
    readonly #cancelledSubscriptions = new Set<number>();
    #coalesce: CoalesceGate | null = null;
    #suspendedCount = 0;
    #resumeGate: PromiseWithResolvers<void> | null = null;
    #stopped = false;

    constructor(args: {
        readonly sessionId: number;
        readonly db: Db;
        readonly engine: DrainEngine;
        readonly lifecycle: LoopLifecycle;
        readonly runLoop: RunLoop;
        readonly hasActiveStreams: (sessionId: number) => boolean;
        readonly readSystemPrompt: () => Promise<string>;
        readonly emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
        readonly emit: EmitEvent;
        readonly isAcceptingWork: () => boolean;
        readonly isStopping: () => boolean;
        readonly trackSettlement: (task: Promise<void>, label: string) => Promise<void>;
        readonly requestDrain: (opts: { workspaceId: number; sessionId: number; systemPrompt: string }) => Promise<DrainStartResult | null>;
        readonly requestCompletionWake: (workspaceId: number, sessionId: number, systemPrompt: string) => Promise<void>;
        readonly onParked: (event: ParkedNotification) => Promise<void>;
        readonly onQuiescent: (process: SessionProcess) => void;
    }) {
        this.sessionId = args.sessionId;
        this.#db = args.db;
        this.#engine = args.engine;
        this.#lifecycle = args.lifecycle;
        this.#runLoop = args.runLoop;
        this.#hasActiveStreams = args.hasActiveStreams;
        this.#readSystemPrompt = args.readSystemPrompt;
        this.#emitLogEntry = args.emitLogEntry;
        this.#emit = args.emit;
        this.#isAcceptingWork = args.isAcceptingWork;
        this.#isStopping = args.isStopping;
        this.#trackSettlement = args.trackSettlement;
        this.#requestDrain = args.requestDrain;
        this.#requestCompletionWake = args.requestCompletionWake;
        this.#onParked = args.onParked;
        this.#onQuiescent = args.onQuiescent;
    }

    get isStopped(): boolean {
        return this.#stopped;
    }

    get isDraining(): boolean {
        return this.#incarnation !== null;
    }

    get activeTimerCount(): number {
        return this.#timers.size;
    }

    get state(): SessionProcessState {
        if (this.#stopped) return "stopped";
        if (this.#settlingCount > 0 || this.#pendingAnnouncements > 0) return "settling_exit";
        if (this.#suspendedCount > 0) return "suspended";
        if (this.#incarnation !== null) return "running";
        if (this.#coalesce !== null) return "coalescing";
        if (this.#timers.size > 0) return "parked";
        return "idle";
    }

    activePromises(): ReadonlyArray<Promise<unknown>> {
        return [...this.#activeIncarnationFibers];
    }

    // {§session-loop-lifecycle} — FIFO control mailbox for bounded per-session state transitions;
    // never encloses inference, tool execution, or cross-session awaits.
    #enqueueControl<T>(fn: () => Promise<T>): Promise<T> {
        this.#controlPendingCount++;
        const prev = this.#controlTail;
        const run = prev.then(fn, fn);
        const settled = run.then(
            () => {
                this.#controlPendingCount--;
                this.#checkQuiescent();
            },
            () => {
                this.#controlPendingCount--;
                this.#checkQuiescent();
            },
        );
        this.#controlTail = settled;
        return run;
    }

    #isQuiescent(): boolean {
        return (
            this.#controlPendingCount === 0
            && this.#incarnation === null
            && this.#activeIncarnationFibers.size === 0
            && this.#settlingCount === 0
            && this.#pendingAnnouncements === 0
            && this.#timers.size === 0
            && this.#coalesce === null
            && this.#streamAnnouncements.size === 0
            && this.#cancelledSubscriptions.size === 0
            && this.#suspendedCount === 0
            && !this.#hasActiveStreams(this.sessionId)
        );
    }

    #checkQuiescent(): void {
        if (this.#stopped || !this.#isQuiescent()) return;
        this.#stopped = true;
        this.#onQuiescent(this);
    }

    suspend(): () => Promise<void> {
        this.#suspendedCount++;
        if (this.#resumeGate === null) {
            this.#resumeGate = Promise.withResolvers<void>();
        }
        let released = false;
        return async (): Promise<void> => {
            if (released) return;
            released = true;
            if (this.#suspendedCount > 0) this.#suspendedCount--;
            if (this.#suspendedCount === 0 && this.#resumeGate !== null) {
                const gate = this.#resumeGate;
                this.#resumeGate = null;
                gate.resolve();
            }
            this.#checkQuiescent();
        };
    }

    // {§session-causal-admission} — rotate the cancellation epoch atomically under WorkspaceAdmission
    // so live turns and spawned streams abort while future loops receive an uncontaminated epoch.
    cancelEpoch(reason: string, subscriptionIds: readonly number[]): Promise<unknown> | undefined {
        this.#clearAllTimers();
        for (const id of subscriptionIds) this.#cancelledSubscriptions.add(id);
        const retired = this.#epochController;
        if (this.#isAcceptingWork()) {
            this.#epochController = new AbortController();
        }
        if (!retired.signal.aborted) retired.abort(reason);
        const draining = this.#incarnation?.promise;
        this.#checkQuiescent();
        return draining;
    }

    beginStop(reason: string): void {
        this.#clearAllTimers();
        if (this.#suspendedCount > 0) {
            this.#suspendedCount = 0;
            const gate = this.#resumeGate;
            this.#resumeGate = null;
            gate?.resolve();
        }
        if (!this.#epochController.signal.aborted) {
            this.#epochController.abort(reason);
        }
        this.#checkQuiescent();
    }

    // {§session-wait-timing} — recipient selection, turn-ceiling validation, prompt injection or
    // fresh-loop enqueue, and immediate wake check execute atomically in one control turn.
    admitDelivery(args: DrainInjectionArgs): Promise<AdmittedDelivery> {
        return this.#enqueueControl(async () => {
            if (!this.#isAcceptingWork()) throw new Error("The daemon is not accepting work.");
            const { workspaceId, prompt } = args;
            const resolvePolicy = async (activeLoopId: number | undefined): Promise<DrainPolicyResolution> => {
                if (args.resolvePolicy !== undefined) return args.resolvePolicy({ activeLoopId });
                if (args.providerSpec === undefined || args.effort === undefined) {
                    throw new Error("DrainSupervisor.inject requires resolvePolicy or explicit providerSpec and effort");
                }
                return {
                    providerSpec: args.providerSpec,
                    effort: args.effort,
                    childProviderSpec: args.childProviderSpec ?? null,
                };
            };
            const active = await this.#db.drain_message_recipient.get<{ id: number }>({
                session_id: this.sessionId,
                loop_id: args.loopId ?? null,
            });
            if (active === undefined && args.loopId !== undefined) {
                throw new OperationFailureError(Results.failure(
                    "daemon:admission",
                    "loop-not-open",
                    409,
                    `Loop ${args.loopId} is not an unfinished recipient of Session ${this.sessionId}; no message was admitted.`,
                    {},
                    { loopId: args.loopId, sessionId: this.sessionId, retryable: false },
                ));
            }
            if (active !== undefined) {
                await this.#assertLoopMaxTurns(
                    active.id,
                    args.turnCeiling?.source === "explicit" ? args.turnCeiling.effective : undefined,
                );
                await resolvePolicy(active.id);
                const result = await this.#engine.injectIntoLoop(
                    active.id,
                    prompt,
                    args.openPaths ?? [],
                    args.source,
                    args.evidence,
                    args.messageAddress,
                    args.opener,
                );
                if (result !== null) {
                    await this.#wakeLoopLocked(workspaceId, result.loopId);
                    return {
                        action: "injected_next_turn",
                        loopId: result.loopId,
                        messageId: result.messageId,
                        turnSeq: result.turnSeq,
                    };
                }
                if (args.loopId !== undefined) {
                    throw new OperationFailureError(Results.failure(
                        "daemon:admission",
                        "loop-not-open",
                        409,
                        `Loop ${args.loopId} is not an unfinished recipient of Session ${this.sessionId}; no message was admitted.`,
                        {},
                        { loopId: args.loopId, sessionId: this.sessionId, retryable: false },
                    ));
                }
            }
            const freshPolicy = await resolvePolicy(undefined);
            const accepted = await this.#enqueueFreshLoop({
                prompt,
                ...(args.source === undefined ? {} : { source: args.source }),
                providerSpec: freshPolicy.providerSpec,
                effort: freshPolicy.effort,
                childProviderSpec: freshPolicy.childProviderSpec,
                maxTurns: args.turnCeiling?.effective,
                openPaths: args.openPaths,
                evidence: args.evidence,
                messageAddress: args.messageAddress,
                ...(args.opener === undefined ? {} : { opener: args.opener }),
            });
            return { action: "enqueued_new_loop", ...accepted };
        });
    }

    async ensureRunning(opts: { workspaceId: number; systemPrompt: string }): Promise<DrainStartResult | null> {
        let needsTimerSync = false;
        const started = await this.#enqueueControl(async () => {
            if (!this.#isAcceptingWork()) return null;
            if (this.#incarnation !== null && !this.#incarnation.controller.signal.aborted) {
                return null;
            }
            if (await this.#db.drain_ready_loop.get({ session_id: this.sessionId }) === undefined) {
                needsTimerSync = true;
                return null;
            }
            if (!this.#isAcceptingWork()) return null;
            return this.#spawnIncarnation(opts);
        });
        if (needsTimerSync) await this.scheduleWakes(opts.workspaceId, opts.systemPrompt);
        return started;
    }

    scheduleWakes(workspaceId: number, systemPrompt: string): Promise<void> {
        return this.#enqueueControl(async () => {
            await this.#syncTimersLocked(workspaceId, systemPrompt);
        });
    }

    notifyStreamConcluded(payload: WakeSessionPayload): Promise<void> {
        const { subscriptionId } = payload;
        const announced = Promise.withResolvers<void>();
        const delivered = announced.promise;
        this.#streamAnnouncements.set(subscriptionId, delivered);
        return this.#handleStreamConcluded(payload, announced.resolve).finally(() => {
            announced.resolve();
            if (this.#streamAnnouncements.get(subscriptionId) === delivered) {
                this.#streamAnnouncements.delete(subscriptionId);
            }
            this.#checkQuiescent();
        });
    }

    async awaitStreamConcluded(subscriptionId: number): Promise<void> {
        try {
            await this.#engine.subscriptionConcluded(subscriptionId);
            await this.#streamAnnouncements.get(subscriptionId);
        } finally {
            this.#cancelledSubscriptions.delete(subscriptionId);
            this.#checkQuiescent();
        }
    }

    async announceLoopTermination(
        workspaceId: number,
        loopId: number,
        result: SchemeResult,
        hitMaxTurns = false,
    ): Promise<DrainLoopResult> {
        this.#pendingAnnouncements++;
        try {
            const [usage, attributions, turnIds] = await Promise.all([
                this.#engine.loopUsage(loopId),
                this.#engine.loopAttributions(loopId),
                this.#lifecycle.turnIds(loopId),
            ]);
            const loopResult: DrainLoopResult = {
                loopId,
                turnIds,
                result,
                hitMaxTurns,
                usage,
                attributions,
            };
            await this.#publishTermination(workspaceId, { ...loopResult, usage, attributions });
            return loopResult;
        } finally {
            this.#pendingAnnouncements--;
            this.#checkQuiescent();
        }
    }

    // {§session-causal-admission} — non-sliding Coalescing state: sibling completions share the
    // initial deadline and wake immediately once live obligations reach zero.
    settleCompletionWake(workspaceId: number, systemPrompt: string): Promise<void> {
        if (this.#coalesce !== null) {
            this.#coalesce.conclusions++;
            this.#coalesce.systemPrompt = systemPrompt;
            this.#coalesce.poke.resolve();
            return this.#coalesce.promise;
        }

        const completed = Promise.withResolvers<void>();
        const gate: CoalesceGate = {
            conclusions: 1,
            systemPrompt,
            poke: Promise.withResolvers<void>(),
            signal: this.#epochController.signal,
            promise: completed.promise,
        };
        this.#coalesce = gate;
        void this.#runCoalescing(workspaceId, gate)
            .then(completed.resolve, completed.reject)
            .finally(() => {
                if (this.#coalesce === gate) this.#coalesce = null;
                this.#checkQuiescent();
            });
        return gate.promise;
    }

    #spawnIncarnation(opts: { workspaceId: number; systemPrompt: string }): DrainStartResult {
        if (this.#epochController.signal.aborted && this.#isAcceptingWork()) {
            this.#epochController = new AbortController();
        }
        const controller = this.#epochController;
        const firstLoop = Promise.withResolvers<DrainLoopResult>();
        const handle: IncarnationHandle = {
            controller,
            promise: Promise.resolve({ loopsDrained: 0, lastResult: null }),
            first: { settled: false, resolve: firstLoop.resolve, reject: firstLoop.reject },
        };
        this.#incarnation = handle;
        const drainPromise = this.#runIncarnation(opts.workspaceId, opts.systemPrompt, handle);
        handle.promise = drainPromise;
        this.#activeIncarnationFibers.add(drainPromise);
        drainPromise.catch(() => {});
        firstLoop.promise.catch(() => {});
        return { firstLoopPromise: firstLoop.promise, drainPromise };
    }

    async #waitUntilResumed(signal: AbortSignal): Promise<void> {
        while (this.#suspendedCount > 0 && this.#resumeGate !== null) {
            signal.throwIfAborted();
            const gatePromise = this.#resumeGate.promise;
            const onAbort = Promise.withResolvers<never>();
            const abortListener = (): void => {
                onAbort.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            };
            signal.addEventListener("abort", abortListener, { once: true });
            if (signal.aborted) {
                signal.removeEventListener("abort", abortListener);
                signal.throwIfAborted();
            }
            try {
                await Promise.race([gatePromise, onAbort.promise]);
            } finally {
                signal.removeEventListener("abort", abortListener);
            }
        }
        signal.throwIfAborted();
    }

    async #runIncarnation(
        workspaceId: number,
        systemPrompt: string,
        handle: IncarnationHandle,
    ): Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }> {
        const { controller, first } = handle;
        let loopsDrained = 0;
        let lastResult: DrainLoopResult | null = null;
        let currentLoopId: number | null = null;
        let failed = false;
        try {
            while (true) {
                controller.signal.throwIfAborted();
                await this.#waitUntilResumed(controller.signal);
                const loopRow = await this.#claimNextLoop(handle);
                if (loopRow === undefined) break;
                currentLoopId = loopRow.id;
                const result = await this.#runClaimedLoop(workspaceId, systemPrompt, controller.signal, loopRow);
                if (result.result.status === 202) {
                    const parked = await this.#completePark(workspaceId, systemPrompt, loopRow.id);
                    currentLoopId = null;
                    await this.#onParked(parked);
                    continue;
                }
                const loopResult = await this.#settleCompletedLoop(workspaceId, loopRow.id, result);
                loopsDrained++;
                lastResult = loopResult;
                if (!first.settled) {
                    first.settled = true;
                    first.resolve(loopResult);
                }
                currentLoopId = null;
            }
        } catch (err) {
            if (controller.signal.aborted) {
                await this.#settleAbortedIncarnation(workspaceId, handle, currentLoopId);
            } else {
                failed = true;
                await this.#settleFailedIncarnation(workspaceId, handle, currentLoopId, err);
            }
            throw err;
        } finally {
            if (!first.settled) {
                first.settled = true;
                first.reject(new Error("drain exited without producing a result"));
            }
            if (this.#incarnation === handle) this.#incarnation = null;
            try {
                if (failed && !controller.signal.aborted) {
                    const resumed = await this.#requestDrain({
                        workspaceId,
                        sessionId: this.sessionId,
                        systemPrompt,
                    });
                    resumed?.drainPromise.catch((cause: unknown) => {
                        if (this.#isAcceptingWork()) {
                            console.error("recovery drain failed:", cause instanceof Error ? cause.message : String(cause));
                        }
                    });
                } else {
                    await this.scheduleWakes(workspaceId, systemPrompt);
                }
            } finally {
                this.#activeIncarnationFibers.delete(handle.promise);
                this.#checkQuiescent();
            }
        }
        return { loopsDrained, lastResult };
    }

    #claimNextLoop(handle: IncarnationHandle): Promise<ClaimedLoop | undefined> {
        return this.#enqueueControl(async () => {
            if (!this.#isAcceptingWork() || handle.controller.signal.aborted) {
                if (this.#incarnation === handle) this.#incarnation = null;
                return undefined;
            }
            const claimed = await this.#db.drain_claim_next_loop.get<ClaimedLoop>({
                session_id: this.sessionId,
            });
            if (claimed === undefined && this.#incarnation === handle) {
                this.#incarnation = null;
            }
            return claimed;
        });
    }

    async #runClaimedLoop(
        workspaceId: number,
        systemPrompt: string,
        signal: AbortSignal,
        loopRow: ClaimedLoop,
    ): Promise<{ result: SchemeResult; hitMaxTurns: boolean }> {
        this.#clearTimer(loopRow.id);
        await this.#emitLoopStatus(workspaceId, loopRow.id, 102);
        const onSettled = async (logEntryId: number): Promise<void> => {
            await this.#emitLogEntry(workspaceId, logEntryId).catch((error: unknown) => {
                console.error("log/entry broadcast failed:", error instanceof Error ? error.message : String(error));
            });
        };
        return observed(
            "loop.run",
            { workspaceId, sessionId: this.sessionId, "loop.id": loopRow.id },
            async (span) => {
                const loopResult = await this.#runLoop({
                    workspaceId,
                    sessionId: this.sessionId,
                    loopId: loopRow.id,
                    maxTurns: loopRow.max_turns,
                    prompt: loopRow.prompt,
                    systemPrompt,
                    signal,
                    onSettled,
                });
                span.setAttribute("status", loopResult.result.status);
                recordCounter(LOOP_TERMINALS, { status: loopResult.result.status });
                return loopResult;
            },
        );
    }

    // {§session-loop-lifecycle} {§session-wait-timing} — single atomic control turn for 202 status
    // notice, timer reconciliation, racing-message wake check, and eventOnly wake check.
    #completePark(workspaceId: number, systemPrompt: string, loopId: number): Promise<ParkedNotification> {
        return this.#enqueueControl(async () => {
            const waits = await this.#lifecycle.parked(this.sessionId);
            const currentWait = waits.find(({ id }) => id === loopId);
            if (currentWait !== undefined) {
                const { loopSeq, claimedAt, packetCount } = await this.#lifecycle.observation(loopId);
                this.#emit(workspaceId, "notice/event", {
                    sessionId: this.sessionId,
                    loopId,
                    notice: {
                        source: "engine:lifecycle",
                        kind: "loop_status",
                        level: "info",
                        status: 202,
                        loopSeq,
                        waitUntil: currentWait.wait_poll_at ?? null,
                        packetCount,
                        claimedAt,
                    },
                });
            }
            if (this.#isAcceptingWork()) {
                this.#reconcileTimersFromWaits(workspaceId, systemPrompt, waits);
            }
            const unpublished = await this.#db.drain_unpublished_messages_for_loop.get<{ id: number }>({
                loop_id: loopId,
            });
            if (unpublished !== undefined) {
                const woke = await this.#wakeLoopLocked(workspaceId, loopId);
                if (woke) {
                    return { workspaceId, sessionId: this.sessionId, loopId, remainedParked: false };
                }
            }
            const wokeByEvent = await this.#wakeLoopLocked(workspaceId, loopId, { eventOnly: true });
            return {
                workspaceId,
                sessionId: this.sessionId,
                loopId,
                remainedParked: currentWait !== undefined && !wokeByEvent,
            };
        });
    }

    async #settleCompletedLoop(
        workspaceId: number,
        loopId: number,
        result: { result: SchemeResult; hitMaxTurns: boolean },
    ): Promise<DrainLoopResult> {
        this.#settlingCount++;
        try {
            const cancelled = await this.#lifecycle.cancelled(loopId);
            if (!cancelled) {
                await this.#reapLoop(loopId);
                return await this.announceLoopTermination(workspaceId, loopId, result.result, result.hitMaxTurns);
            }
            const [usage, attributions, turnIds] = await Promise.all([
                this.#engine.loopUsage(loopId),
                this.#engine.loopAttributions(loopId),
                this.#lifecycle.turnIds(loopId),
            ]);
            return {
                loopId,
                turnIds,
                result: result.result,
                hitMaxTurns: result.hitMaxTurns,
                usage,
                attributions,
            };
        } finally {
            this.#settlingCount--;
            this.#checkQuiescent();
        }
    }

    async #settleAbortedIncarnation(
        workspaceId: number,
        handle: IncarnationHandle,
        currentLoopId: number | null,
    ): Promise<void> {
        this.#settlingCount++;
        try {
            const message = ErrorDetail.preview(handle.controller.signal.reason ?? "user_cancelled")
                || "no reason was supplied";
            const cancelledResult = (): SchemeResult => Results.failure(
                "lifecycle:cancel",
                "loop-cancelled",
                499,
                `The loop was cancelled: ${message}.`,
                {},
                { reason: message, stage: "loop", retryable: false },
            );
            let settledLoopResult: DrainLoopResult | null = null;
            let usage: LoopUsage = {
                accounting: aggregateProviderAccounting([]),
                curationWeight: null,
                curationBudget: null,
                contextTokens: null,
                contextCapacity: null,
                meta: {},
            };
            if (currentLoopId !== null) {
                const finished = await this.#lifecycle.finish(
                    currentLoopId,
                    cancelledResult(),
                    { terminatedBy: "cancel" },
                );
                if (finished !== null || !await this.#lifecycle.cancelled(currentLoopId)) {
                    const settled = finished ?? await this.#lifecycle.result(currentLoopId);
                    if (settled !== null) {
                        await this.#reapLoop(currentLoopId);
                        settledLoopResult = await this.announceLoopTermination(
                            workspaceId,
                            currentLoopId,
                            settled,
                            false,
                        );
                        usage = settledLoopResult.usage ?? usage;
                    }
                } else {
                    usage = await this.#engine.loopUsage(currentLoopId);
                }
            }
            if (!handle.first.settled) {
                handle.first.settled = true;
                if (settledLoopResult !== null) {
                    handle.first.resolve(settledLoopResult);
                } else {
                    handle.first.resolve({
                        loopId: currentLoopId ?? 0,
                        turnIds: [],
                        result: currentLoopId === null
                            ? cancelledResult()
                            : await this.#lifecycle.result(currentLoopId) ?? cancelledResult(),
                        hitMaxTurns: false,
                        usage,
                    });
                }
            }
        } finally {
            this.#settlingCount--;
            this.#checkQuiescent();
        }
    }

    async #settleFailedIncarnation(
        workspaceId: number,
        handle: IncarnationHandle,
        currentLoopId: number | null,
        err: unknown,
    ): Promise<void> {
        this.#settlingCount++;
        try {
            console.error(
                `drain error (workspace ${workspaceId}, session ${this.sessionId}, loop ${currentLoopId ?? "?"}):`,
                err,
            );
            if (currentLoopId !== null) {
                const cause = ErrorDetail.preview(err);
                const failure = err instanceof OperationFailureError
                    ? err.result
                    : Results.failure(
                        "daemon:drain",
                        "loop-threw",
                        500,
                        cause.length > 0
                            ? `The loop failed outside its operation result contract: ${cause}`
                            : "The loop failed outside its operation result contract.",
                        {},
                        { stage: "loop", retryable: false },
                    );
                const finished = await this.#lifecycle.finish(currentLoopId, failure);
                if (finished !== null || !await this.#lifecycle.cancelled(currentLoopId)) {
                    const settled = finished ?? await this.#lifecycle.result(currentLoopId);
                    if (settled === null) {
                        throw new Error(`drain could not settle loop ${currentLoopId}`, { cause: err });
                    }
                    await this.#reapLoop(currentLoopId);
                    await this.announceLoopTermination(workspaceId, currentLoopId, settled, false);
                }
            }
            if (!handle.first.settled) {
                handle.first.settled = true;
                handle.first.reject(err);
            }
        } catch (settlementErr) {
            if (!handle.first.settled) {
                handle.first.settled = true;
                handle.first.reject(settlementErr);
            }
            throw settlementErr;
        } finally {
            this.#settlingCount--;
            this.#checkQuiescent();
        }
    }

    async #reapLoop(loopId: number): Promise<void> {
        const reaped = await this.#engine.reapLoopStreams(loopId);
        await Promise.all(reaped.map((subscriptionId) => this.awaitStreamConcluded(subscriptionId)));
    }

    async #handleStreamConcluded(payload: WakeSessionPayload, announced: () => void): Promise<void> {
        const { workspaceId, ...conclusion } = payload;
        const conclude = (wakeAction: string): void => {
            this.#emit(workspaceId, "stream/concluded", { ...conclusion, wakeAction });
            announced();
        };
        const scopeCancelled =
            this.#isStopping()
            || this.#cancelledSubscriptions.delete(payload.subscriptionId)
            || this.#incarnation?.controller.signal.aborted === true;
        if (scopeCancelled) {
            conclude(payload.result.status === 499 ? "skipped-aborted" : "skipped-cancelled");
            return;
        }

        const systemPrompt = await this.#readSystemPrompt(); // {§packet-inject}

        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({
            session_id: payload.sessionId,
        });
        if (slept !== undefined) {
            const settlement = this.#requestCompletionWake(workspaceId, payload.sessionId, systemPrompt);
            conclude("wake-pending");
            await settlement;
            return;
        }

        if (this.#incarnation !== null) {
            conclude("no-op-active-loop");
            return;
        }

        conclude("no-loop");
    }

    async #runCoalescing(workspaceId: number, gate: CoalesceGate): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({
            session_id: this.sessionId,
        });
        if (slept === undefined) {
            this.#releaseCoalesce(gate);
            return this.#wakeParkedLoops(workspaceId, gate.systemPrompt);
        }

        const timeoutMs = readOptimisticSettlementMs();
        if (timeoutMs === 0 || !(await this.#sessionHasLiveObligation())) {
            this.#releaseCoalesce(gate);
            return this.#wakeParkedLoops(workspaceId, gate.systemPrompt);
        }

        return observed(
            "session.wake.settlement",
            { "window.ms": timeoutMs },
            async (span) => {
                const startedAt = performance.now();
                const signal = gate.signal;
                const deadline = delay(timeoutMs, "deadline" as const, { signal, ref: false })
                    .catch((cause: unknown) => {
                        if (signal.aborted) return "cancelled" as const;
                        throw cause;
                    });
                let release: "quiescent" | "deadline" | "cancelled" = "quiescent";
                while (await this.#sessionHasLiveObligation()) {
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
                const latestPrompt = gate.systemPrompt;
                this.#releaseCoalesce(gate);
                if (release === "cancelled") return;
                return this.#wakeParkedLoops(workspaceId, latestPrompt);
            },
        );
    }

    #releaseCoalesce(gate: CoalesceGate): void {
        if (this.#coalesce === gate) this.#coalesce = null;
    }

    async #sessionHasLiveObligation(): Promise<boolean> {
        const held = await this.#db.session_live_obligations.get<{ streams: 0 | 1; sessions: 0 | 1 }>({
            session_id: this.sessionId,
        });
        return held !== undefined && (held.streams === 1 || held.sessions === 1);
    }

    async #wakeParkedLoops(workspaceId: number, systemPrompt: string): Promise<void> {
        if (!this.#isAcceptingWork()) return;
        const woke = await this.#enqueueControl(async () => {
            if (!this.#isAcceptingWork()) return false;
            const waits = await this.#lifecycle.parked(this.sessionId);
            let changed = false;
            for (const wait of waits) {
                if (await this.#wakeLoopLocked(workspaceId, wait.id, { revision: wait.wait_revision, eventOnly: true })) {
                    changed = true;
                }
            }
            return changed;
        });
        if (!woke) return;
        const started = await this.#requestDrain({
            workspaceId,
            sessionId: this.sessionId,
            systemPrompt,
        });
        started?.drainPromise?.catch((err: unknown) => {
            if (this.#isAcceptingWork()) {
                console.error("wake-parked resume drain failed:", err instanceof Error ? err.message : String(err));
            }
        });
    }

    async #syncTimersLocked(workspaceId: number, systemPrompt: string): Promise<void> {
        if (!this.#isAcceptingWork()) return;
        const waits = await this.#lifecycle.parked(this.sessionId);
        if (!this.#isAcceptingWork()) return;
        this.#reconcileTimersFromWaits(workspaceId, systemPrompt, waits);
    }

    #reconcileTimersFromWaits(
        workspaceId: number,
        systemPrompt: string,
        waits: ReadonlyArray<{ id: number; wait_revision: number; wait_poll_at: number | null }>,
    ): void {
        for (const loopId of this.#timers.keys()) {
            if (!waits.some(({ id }) => id === loopId)) this.#clearTimer(loopId);
        }
        for (const wait of waits) {
            if (wait.wait_poll_at === null) continue;
            this.#armTimer(workspaceId, systemPrompt, wait.id, wait.wait_revision, wait.wait_poll_at);
        }
    }

    #armTimer(
        workspaceId: number,
        systemPrompt: string,
        loopId: number,
        revision: number,
        dueAt: number,
    ): void {
        if (!this.#isAcceptingWork()) return;
        const prior = this.#timers.get(loopId);
        if (prior?.revision === revision && prior.dueAt === dueAt) return;
        this.#clearTimer(loopId);
        // Node.js timers clamp delays exceeding a signed 32-bit integer to 1ms; #wakeTimedLoop re-arms if early.
        const delayMs = Math.max(1, Math.min(dueAt - Date.now(), 0x7fff_ffff));
        const timer = setTimeout(() => {
            if (this.#timers.get(loopId)?.timer !== timer) return;
            this.#timers.delete(loopId);
            void this.#trackSettlement(
                this.#wakeTimedLoop(workspaceId, systemPrompt, loopId, revision),
                "wake-on-completion",
            );
            this.#checkQuiescent();
        }, delayMs);
        timer.unref();
        this.#timers.set(loopId, { revision, dueAt, timer });
    }

    #clearTimer(loopId: number): void {
        const current = this.#timers.get(loopId);
        if (current === undefined) return;
        clearTimeout(current.timer);
        this.#timers.delete(loopId);
    }

    #clearAllTimers(): void {
        for (const { timer } of this.#timers.values()) clearTimeout(timer);
        this.#timers.clear();
    }

    async #wakeTimedLoop(
        workspaceId: number,
        systemPrompt: string,
        loopId: number,
        revision: number,
    ): Promise<void> {
        if (!this.#isAcceptingWork()) return;
        const woke = await this.#enqueueControl(() =>
            this.#wakeLoopLocked(workspaceId, loopId, { revision, dueAt: Date.now() }),
        );
        if (woke) {
            await this.#requestDrain({ workspaceId, sessionId: this.sessionId, systemPrompt });
        } else {
            await this.scheduleWakes(workspaceId, systemPrompt);
        }
    }

    async #wakeLoopLocked(
        workspaceId: number,
        loopId: number,
        condition: Parameters<LoopLifecycle["wake"]>[1] = {},
    ): Promise<boolean> {
        if (!this.#isAcceptingWork() || this.#epochController.signal.aborted) return false;
        const woke = await this.#lifecycle.wake(loopId, condition);
        if (woke) {
            this.#clearTimer(loopId);
            await this.#emitLoopStatus(workspaceId, loopId, 100);
        }
        return woke;
    }

    async #emitLoopStatus(workspaceId: number, loopId: number, status: 100 | 102): Promise<void> {
        const { loopSeq, claimedAt, packetCount } = await this.#lifecycle.observation(loopId);
        this.#emit(workspaceId, "notice/event", {
            sessionId: this.sessionId,
            loopId,
            notice: {
                source: "engine:lifecycle",
                kind: "loop_status",
                level: "info",
                status,
                loopSeq,
                waitUntil: null,
                packetCount,
                claimedAt,
            },
        });
    }

    async #assertLoopMaxTurns(loopId: number, requested: number | undefined): Promise<void> {
        if (requested === undefined) return;
        const durable = await this.#db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId });
        if (durable === undefined) throw new Error(`inject: loop ${loopId} has no durable turn ceiling`);
        if (durable.max_turns !== requested) {
            throw daemonFailure(
                "daemon:loop",
                "turn-ceiling-conflict",
                409,
                `Loop ${loopId} has turn ceiling ${durable.max_turns}, not ${requested}.`,
                {
                    loopId,
                    selectedMaximumTurns: durable.max_turns,
                    requestedMaximumTurns: requested,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another turn ceiling.",
                    retryable: false,
                },
            );
        }
    }

    async #enqueueFreshLoop(args: {
        prompt: string;
        source?: string;
        messageAddress?: string;
        evidence?: MessageEvidence;
        providerSpec: ProviderSpec;
        effort: Effort;
        childProviderSpec: ProviderSpec | null;
        maxTurns?: number;
        openPaths?: string[];
        opener?: MessageOpener;
    }): Promise<{ loopId: number; messageId: number }> {
        const modelRouteId = await routeForSpec(this.#db, args.providerSpec);
        const spawnRouteId = await routeForSpec(this.#db, args.childProviderSpec);
        const loopRow = await this.#db.drain_enqueue_loop.get<{ id: number }>({
            session_id: this.sessionId,
            prompt: args.prompt,
            prompt_source: args.source ?? null,
            model_route_id: modelRouteId,
            spawn_model_route_id: spawnRouteId,
            effort: args.effort,
            max_turns: args.maxTurns ?? Knob.integer("PLURNK_SERVICE_MAX_TURNS", -1),
        });
        if (loopRow === undefined) throw new Error("enqueueFreshLoop: loop enqueue returned no row");
        const seeded = await this.#db.drain_enqueue_message.get<{ id: number; ordinal: number }>({
            loop_id: loopRow.id,
            source: args.source ?? null,
            body: args.prompt,
            open_paths: JSON.stringify(args.openPaths ?? []),
            evidence: JSON.stringify(args.evidence ?? {}),
            address: args.messageAddress ?? null,
            opened_turn_id: args.opener?.turnId ?? null,
            opened_sequence: args.opener?.sequence ?? null,
        });
        if (seeded === undefined) throw new Error("enqueueFreshLoop: message enqueue returned no row");
        return { loopId: loopRow.id, messageId: seeded.id };
    }

    async #publishTermination(
        workspaceId: number,
        event: DrainLoopResult & { usage: LoopUsage; attributions: string[] },
    ): Promise<void> {
        const { loopSeq, terminatedAt } = await this.#lifecycle.observation(event.loopId);
        if (terminatedAt === null) throw new Error(`loop ${event.loopId} has no terminatedAt at termination`);
        await Promise.all(this.#streamAnnouncements.values());
        this.#engine.discardLoopNotices(event.loopId);
        this.#emit(workspaceId, "loop/terminated", {
            sessionId: this.sessionId,
            ...event,
            loopSeq,
            terminatedAt,
        });
        void this.#trackSettlement(
            this.#notifyTerminationWakes(workspaceId, event.loopId),
            "wake-on-completion",
        );
    }

    async #notifyTerminationWakes(workspaceId: number, loopId: number): Promise<void> {
        const recipients = new Set<number>();
        const parent = await this.#db.session_parent_id.get<{ parent_session_id: number | null }>({
            session_id: this.sessionId,
        });
        if (parent?.parent_session_id != null) recipients.add(parent.parent_session_id);
        const linked = await this.#db.loop_termination_wake_recipients.all<{ session_id: number }>({
            session_id: this.sessionId,
            loop_id: loopId,
        });
        for (const row of linked) recipients.add(row.session_id);
        if (recipients.size === 0) return;
        const systemPrompt = await this.#readSystemPrompt();
        await Promise.all(
            [...recipients].map((recipientId) =>
                this.#requestCompletionWake(workspaceId, recipientId, systemPrompt),
            ),
        );
    }
}
