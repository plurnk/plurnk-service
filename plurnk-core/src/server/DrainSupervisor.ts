import { setTimeout as delay } from "node:timers/promises";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import type { MessageEvidence, Effort } from "@plurnk/plurnk-contracts";
import { aggregateProviderAccounting } from "@plurnk/plurnk-providers";
import { routeForSpec } from "./model-route.ts";
import type { MessageOpener, WakeSessionPayload } from "../core/ChannelWrite.ts";
import ChannelWrite from "../core/ChannelWrite.ts";
import type { Db } from "../core/Db.ts";
import type { LoopUsage } from "../core/Engine.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import type LoopLifecycle from "../core/LoopLifecycle.ts";
import MessageResources from "../core/MessageResources.ts";
import { Knob } from "@plurnk/plurnk-meta";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import { observed } from "../observe/spans.ts";
import { LOOP_TERMINALS, recordCounter } from "../observe/metrics.ts";
import { readOptimisticSettlementMs } from "../core/optimistic-settlement.ts";

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
    sessionId: number;
    loopId?: number;
    prompt: string;
    source?: string;
    messageAddress?: string;
    evidence?: MessageEvidence;
    // Absent for an independent exterior arrival, required for operation-caused delivery.
    sourceLoopId?: number;
    providerSpec: ProviderSpec;
    effort: Effort;
    // False = the client omitted a selector; a continuation must keep the loop's
    // durable provider rather than compare against a re-resolved boot default.
    // Absent/true = an explicit selection, so the compatibility check applies.
    providerSpecExplicit?: boolean;
    systemPrompt: string;
    childProviderSpec?: ProviderSpec | null;
    turnCeiling?: TurnCeilingSelection;
    openPaths?: string[];
    // {§loop-completion} — the session's own operation that sends the message.
    opener?: MessageOpener;
};

export type DrainInjectionResult = {
    action: "injected_next_turn" | "enqueued_new_loop";
    loopId: number;
    messageId: number;
    turnSeq?: number;
    firstLoopPromise?: Promise<DrainLoopResult>;
    drainPromise?: Promise<unknown>;
};

type DrainStartResult = {
    firstLoopPromise: Promise<DrainLoopResult>;
    drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
};

// The handle is the drain identity. Start/exit compare by reference so an
// exiting drain cannot clobber a successor that raced in.
type DrainHandle = { controller: AbortController; promise: Promise<unknown> };

// A loop as the queue hands it to its drain.
type ClaimedLoop = { id: number; sequence: number; prompt: string; max_turns: number };

// What one drain's steps share: the session, its cancellation scope, the drain's identity, and the first
// loop's settlement, delivered once to whoever started the drain — its result, the drain's error, or an
// exit with neither.
type DrainScope = {
    workspaceId: number;
    sessionId: number;
    systemPrompt: string;
    controller: AbortController;
    handle: DrainHandle;
    first: { settled: boolean; resolve: (result: DrainLoopResult) => void; reject: (error: unknown) => void };
};

type CompletionWakeGate = {
    conclusions: number;
    poke: PromiseWithResolvers<void>;
    promise: Promise<void>;
};

type InjectionCompatibility = Pick<
    DrainInjectionArgs,
    "sessionId" | "providerSpec" | "providerSpecExplicit" | "effort" | "childProviderSpec" | "turnCeiling"
> & { loopId: number };

type RunLoop = (args: {
    workspaceId: number;
    sessionId: number;
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
    evidence?: MessageEvidence,
    messageAddress?: string,
    opener?: MessageOpener,
) => Promise<{ loopId: number; turnSeq: number; messageId: number } | null>;
type AssertInjectionCompatibility = (args: InjectionCompatibility) => Promise<void>;
// {§loop-completion} — completes, 499, the messages other sessions sent that an ended loop left unanswered.
type CompleteAbandonedMessages = (workspaceId: number, sessionId: number, loopId: number, status: number) => Promise<unknown>;
type EmitEvent = (workspaceId: number, method: string, params: unknown) => void;

// Owns the session-local queue consumer and every process-local edge that may
// wake, cancel, or retire it. Daemon retains provider/process policy and the
// external facade, supplying only the named capabilities below.
export default class DrainSupervisor {
    readonly #db: Db;
    readonly #lifecycle: LoopLifecycle;
    readonly #injectPrompt: InjectPrompt;
    readonly #assertInjectionCompatibility: AssertInjectionCompatibility;
    readonly #runLoop: RunLoop;
    readonly #loopUsage: (loopId: number) => Promise<LoopUsage>;
    readonly #loopAttributions: (loopId: number) => Promise<string[]>;
    readonly #discardLoopNotices: (loopId: number) => void;
    readonly #cancelSubscription: (subscriptionId: number) => Promise<boolean>;
    readonly #subscriptionConcluded: (subscriptionId: number) => Promise<void>;
    readonly #reapLoopStreams: (loopId: number) => Promise<readonly number[]>;
    readonly #hasActiveStreams: (sessionId: number) => boolean;
    readonly #readSystemPrompt: () => Promise<string>;
    readonly #emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
    readonly #emit: EmitEvent;
    readonly #completeAbandonedMessages: CompleteAbandonedMessages;

    readonly #activeDrains = new Map<number, DrainHandle>();
    readonly #settlementTasks = new Set<Promise<void>>();
    readonly #settlementFailures: unknown[] = [];
    // One cancellation scope spans a session's loops and streams. It outlives
    // any single drain and is replaced only after it has been aborted.
    readonly #sessionAborts = new Map<number, AbortController>();
    readonly #loopTimers = new Map<number, {
        sessionId: number; revision: number; dueAt: number; timer: NodeJS.Timeout;
    }>();
    readonly #drainLocks = new Map<number, Promise<unknown>>();
    readonly #admissionLocks = new Map<number, Promise<unknown>>();
    readonly #completionWakeGates = new Map<number, CompletionWakeGate>();
    // {§notifications} A closed subscription's `stream/concluded`, until it is published.
    readonly #streamAnnouncements = new Map<number, { sessionId: number; delivered: Promise<void> }>();
    #acceptingWork = false;

    constructor({
        db,
        lifecycle,
        injectPrompt,
        assertInjectionCompatibility,
        runLoop,
        loopUsage,
        loopAttributions,
        discardLoopNotices,
        cancelSubscription,
        subscriptionConcluded,
        reapLoopStreams,
        hasActiveStreams,
        readSystemPrompt,
        emitLogEntry,
        emit,
        completeAbandonedMessages,
    }: {
        db: Db;
        lifecycle: LoopLifecycle;
        injectPrompt: InjectPrompt;
        assertInjectionCompatibility: AssertInjectionCompatibility;
        runLoop: RunLoop;
        loopUsage: (loopId: number) => Promise<LoopUsage>;
        loopAttributions: (loopId: number) => Promise<string[]>;
        discardLoopNotices: (loopId: number) => void;
        cancelSubscription: (subscriptionId: number) => Promise<boolean>;
        subscriptionConcluded: (subscriptionId: number) => Promise<void>;
        reapLoopStreams: (loopId: number) => Promise<readonly number[]>;
        hasActiveStreams: (sessionId: number) => boolean;
        readSystemPrompt: () => Promise<string>;
        emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
        emit: EmitEvent;
        completeAbandonedMessages?: CompleteAbandonedMessages;
    }) {
        this.#completeAbandonedMessages = completeAbandonedMessages ?? (async () => {});
        this.#db = db;
        this.#lifecycle = lifecycle;
        this.#injectPrompt = injectPrompt;
        this.#assertInjectionCompatibility = assertInjectionCompatibility;
        this.#runLoop = runLoop;
        this.#loopUsage = loopUsage;
        this.#loopAttributions = loopAttributions;
        this.#discardLoopNotices = discardLoopNotices;
        this.#cancelSubscription = cancelSubscription;
        this.#subscriptionConcluded = subscriptionConcluded;
        this.#reapLoopStreams = reapLoopStreams;
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
        for (const scope of this.#sessionAborts.values()) {
            if (!scope.signal.aborted) scope.abort(reason);
        }
        for (const { timer } of this.#loopTimers.values()) clearTimeout(timer);
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
            throw new AggregateError(failures, "session lifecycle settlement failed");
        }
    }

    async inject(args: DrainInjectionArgs): Promise<DrainInjectionResult> {
        const { workspaceId, sessionId, prompt } = args;
        // {§session-wait-timing} — selection, compatibility, admission and the wake check share one lock.
        const delivery = await this.#withAdmissionLock(workspaceId, () => this.#withDrainLock(sessionId, async () => {
            if (!this.#acceptingWork) throw new Error("The daemon is not accepting work.");
            if (args.messageAddress !== undefined) {
                // {§methods} Admission refuses every repeat: other words reuse the key, and the same words
                // duplicate a message already accepted.
                const accepted = await this.#db.message_source_by_address.get<{ loop_id: number; body: string }>({
                    workspace_id: workspaceId, path: args.messageAddress,
                });
                if (accepted !== undefined && accepted.body !== prompt) throw MessageResources.reused(args.messageAddress, accepted.loop_id);
                if (accepted !== undefined) throw new OperationFailureError(Results.failure(
                    "daemon:admission", "message-already-accepted", 409,
                    "This message address has already been accepted in this workspace.",
                    {}, { address: args.messageAddress, loopId: accepted.loop_id, retryable: false },
                ));
            }
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
            const active = await this.#db.drain_message_recipient.get<{ id: number }>({ session_id: sessionId, loop_id: args.loopId ?? null });
            if (active !== undefined) {
                await this.#assertInjectionCompatibility({
                    sessionId,
                    loopId: active.id,
                    providerSpec: args.providerSpec,
                    providerSpecExplicit: args.providerSpecExplicit,
                    effort: args.effort,
                    ...(args.childProviderSpec === undefined ? {} : { childProviderSpec: args.childProviderSpec }),
                    ...(args.turnCeiling === undefined ? {} : { turnCeiling: args.turnCeiling }),
                });
            }
            const result = active === undefined ? null
                : await this.#injectPrompt(active.id, prompt, args.openPaths ?? [], args.source, args.evidence, args.messageAddress, args.opener);
            if (result !== null) {
                // runLoop may already have parked in the database while this drain
                // is still registered. Wake that state now; if it is still running,
                // the serialized park-boundary check below supplies the wake edge.
                await this.#wakeLoop(workspaceId, sessionId, result.loopId);
                return { action: "injected_next_turn", loopId: result.loopId, messageId: result.messageId, turnSeq: result.turnSeq } as const;
            }
            if (args.loopId !== undefined) {
                throw new OperationFailureError(Results.failure(
                    "daemon:admission", "loop-not-open", 409,
                    `Loop ${args.loopId} is not an unfinished recipient of Session ${sessionId}; no message was admitted.`,
                    {}, { loopId: args.loopId, sessionId, retryable: false },
                ));
            }
            const accepted = await this.#enqueueFreshLoop({
                sessionId,
                prompt,
                ...(args.source === undefined ? {} : { source: args.source }),
                providerSpec: args.providerSpec,
                effort: args.effort,
                childProviderSpec: args.childProviderSpec ?? null,
                maxTurns: args.turnCeiling?.effective,
                openPaths: args.openPaths,
                evidence: args.evidence,
                messageAddress: args.messageAddress,
                ...(args.opener === undefined ? {} : { opener: args.opener }),
            });
            return { action: "enqueued_new_loop", ...accepted } as const;
        }));
        const started = await this.ensureDrain({ workspaceId, sessionId, systemPrompt: args.systemPrompt });
        return { ...delivery, ...started };
    }

    async #enqueueFreshLoop(args: {
        sessionId: number;
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
        // {§session-model-selection} — resolve the complete route before persistence;
        // the loop snapshot stores the immutable route ids, never re-serialized JSON.
        const modelRouteId = await routeForSpec(this.#db, args.providerSpec);
        const spawnRouteId = await routeForSpec(this.#db, args.childProviderSpec);
        const loopRow = await this.#db.drain_enqueue_loop.get<{ id: number }>({
            session_id: args.sessionId,
            prompt: args.prompt,
            prompt_source: args.source ?? null,
            model_route_id: modelRouteId,
            spawn_model_route_id: spawnRouteId,
            effort: args.effort,
            max_turns: args.maxTurns ?? Knob.integer("PLURNK_SERVICE_MAX_TURNS", -1),
        });
        if (loopRow === undefined) throw new Error("enqueueFreshLoop: loop enqueue returned no row");
        // {§message-arrival}: the loop's initial message is ordinal 1 of its inbox; the loop row's
        // `prompt` is its headline for listings.
        const seeded = await this.#db.drain_enqueue_message.get<{ id: number; ordinal: number }>({
            loop_id: loopRow.id, source: args.source ?? null, body: args.prompt, open_paths: JSON.stringify(args.openPaths ?? []),
            evidence: JSON.stringify(args.evidence ?? {}),
            address: args.messageAddress ?? null,
            opened_turn_id: args.opener?.turnId ?? null, opened_sequence: args.opener?.sequence ?? null,
        });
        if (seeded === undefined) throw new Error("enqueueFreshLoop: message enqueue returned no row");
        return { loopId: loopRow.id, messageId: seeded.id };
    }

    // Consume one session's durable queue until a lock-held empty re-claim
    // relinquishes this exact drain identity.
    #startDrain(opts: {
        workspaceId: number; sessionId: number;
        systemPrompt: string;
    }): DrainStartResult {
        const { workspaceId, sessionId, systemPrompt } = opts;
        // The drain runs under the session's cancellation scope (shared with the
        // execs its loops spawn), so loop.cancel/shutdown abort it as a unit.
        const controller = this.#sessionSignal(sessionId);
        const handle: DrainHandle = { controller, promise: Promise.resolve() };
        const firstLoop = Promise.withResolvers<DrainLoopResult>();
        const first: DrainScope["first"] = { settled: false, resolve: firstLoop.resolve, reject: firstLoop.reject };
        const drainPromise = this.#drain({ workspaceId, sessionId, systemPrompt, controller, handle, first });
        handle.promise = drainPromise;
        this.#activeDrains.set(sessionId, handle);
        // Swallow unhandled rejections (drain aborts with no awaiter); the
        // error already surfaced via firstLoopPromise or was logged inside.
        drainPromise.catch(() => {});
        firstLoop.promise.catch(() => {});
        return { firstLoopPromise: firstLoop.promise, drainPromise };
    }

    // The drain itself: claim, run, then park or conclude, until the queue is empty under the lock. A
    // cancellation or a failure settles the loop in flight before the drain exits, the first loop's
    // settlement is delivered exactly once, and the exit always schedules the session's wakes.
    async #drain(scope: DrainScope): Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }> {
        const { workspaceId, sessionId, systemPrompt, controller, handle, first } = scope;
        let loopsDrained = 0;
        let lastResult: DrainLoopResult | null = null;
        let currentLoopId: number | null = null; // the loop being drained — for abort→499 settlement
        try {
            while (true) {
                controller.signal.throwIfAborted();
                const loopRow = await this.#claimLoop(sessionId, handle);
                if (loopRow === undefined) break;
                currentLoopId = loopRow.id;
                const result = await this.#runClaimedLoop(scope, loopRow);
                if (result.result.status === 202) {
                    await this.#parkLoop(scope, loopRow.id);
                    currentLoopId = null;
                    continue;
                }
                const { loopResult, announced } = await this.#concludeLoop(scope, loopRow.id, result);
                loopsDrained++;
                lastResult = loopResult;
                if (!first.settled) {
                    first.settled = true;
                    first.resolve(loopResult);
                }
                // A message this loop ended before publishing (a wake conclusion or a
                // runLoop-while-active arrival) is promoted to a fresh queued loop so it's
                // never silently dropped ({§message-arrival}).
                await this.reconcileOrphanedMessages(sessionId, loopRow.id);
                if (announced) await this.#abandonUnanswered(workspaceId, sessionId, loopRow.id, result.result.status);
                currentLoopId = null;
            }
        } catch (err) {
            if (controller.signal.aborted) await this.#settleCancelledDrain(scope, currentLoopId);
            else await this.#settleFailedDrain(scope, currentLoopId, err);
            throw err;
        } finally {
            if (!first.settled) {
                first.settled = true;
                first.reject(new Error("drain exited without producing a result"));
            }
            if (this.#activeDrains.get(sessionId) === handle) this.#activeDrains.delete(sessionId);
            await this.scheduleWakes(workspaceId, sessionId, systemPrompt);
        }
        return { loopsDrained, lastResult };
    }

    // {§session-causal-admission} The next queued loop. An empty queue is re-claimed UNDER the per-session
    // drain lock (R4 / I1), serialized against ensureDrain so a concurrent inject can't start a 2nd drain
    // in the gap; the registry slot is relinquished only if it is empty there too, and a loop that raced in
    // is returned and run — the drain stays registered, so there's no transient delete for ensureDrain to
    // catch.
    async #claimLoop(sessionId: number, handle: DrainHandle): Promise<ClaimedLoop | undefined> {
        const claim = () => this.#db.drain_claim_next_loop.get<ClaimedLoop>({ session_id: sessionId });
        const claimed = await claim();
        if (claimed !== undefined) return claimed;
        return this.#withDrainLock(sessionId, async () => {
            const reclaimed = await claim();
            if (reclaimed === undefined && this.#activeDrains.get(sessionId) === handle) {
                this.#activeDrains.delete(sessionId);
            }
            return reclaimed;
        });
    }

    // One claimed loop under observation: its timer cleared, 102 announced, every settled row broadcast.
    async #runClaimedLoop(scope: DrainScope, loopRow: ClaimedLoop): Promise<{ result: SchemeResult; hitMaxTurns: boolean }> {
        const { workspaceId, sessionId, systemPrompt, controller } = scope;
        this.#clearLoopTimer(loopRow.id);
        await this.#emitLoopStatus(workspaceId, sessionId, loopRow.id, 102);
        const onSettled = async (logEntryId: number): Promise<void> => {
            await this.#emitLogEntry(workspaceId, logEntryId).catch((error: unknown) => {
                console.error("log/entry broadcast failed:", error instanceof Error ? error.message : String(error));
            });
        };
        return observed(
            "loop.run",
            { workspaceId, sessionId, "loop.id": loopRow.id },
            async (span) => {
                const loopResult = await this.#runLoop({
                    workspaceId,
                    sessionId,
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
    }

    // A parked loop (202) is suspended, not terminated: it stays resumable, with no loop/terminated and no
    // orphan reconcile. A stream conclusion through handleWakeSession re-queues it; the durable wait deadline
    // also wakes it to inspect ({§session-wait-timing}). {§session-causal-admission}
    async #parkLoop(scope: DrainScope, loopId: number): Promise<void> {
        const { workspaceId, sessionId, systemPrompt } = scope;
        await this.#withDrainLock(sessionId, () => this.#emitLoopStatus(workspaceId, sessionId, loopId, 202));
        await this.scheduleWakes(workspaceId, sessionId, systemPrompt);
        // Serialize the park boundary against message injection.
        // Whichever side arrives first owns a wake edge: injection wakes
        // an already-parked loop, while this check wakes a message written
        // just before runLoop finished parking.
        const messageWaiting = await this.#withDrainLock(sessionId, async () => {
            const unpublished = await this.#db.drain_unpublished_messages_for_loop.get<{ id: number }>({ loop_id: loopId });
            if (unpublished === undefined) return false;
            return this.#wakeLoop(workspaceId, sessionId, loopId);
        });
        if (messageWaiting) return;
        // {§session-wait-timing}: events observed by another loop cannot consume this loop's completion
        // wake. Whether or not one wakes it here, the wait now belongs to its completion obligations and
        // inherited observation, not this drain.
        await this.#withDrainLock(sessionId, () => this.#wakeLoop(workspaceId, sessionId, loopId, { eventOnly: true }));
    }

    // A loop's terminal: its streams reaped, usage, attributions and turns gathered, loop/terminated published, and
    // the result the drain reports. A loop a cancellation retired is reaped and announced by that cancellation instead.
    async #concludeLoop(
        scope: DrainScope,
        loopId: number,
        result: { result: SchemeResult; hitMaxTurns: boolean },
    ): Promise<{ loopResult: DrainLoopResult; announced: boolean }> {
        const { workspaceId, sessionId } = scope;
        const cancelled = await this.#lifecycle.cancelled(loopId);
        // {§notifications} {§exec-lifetime} The streams the loop's terminal reaps conclude before it is announced.
        if (!cancelled) await this.#reapLoop(loopId);
        const [usage, attributions, turnIds] = await Promise.all([
            this.#loopUsage(loopId),
            this.#loopAttributions(loopId),
            this.#lifecycle.turnIds(loopId),
        ]);
        const loopResult = {
            loopId: loopId,
            turnIds,
            result: result.result,
            hitMaxTurns: result.hitMaxTurns,
            usage,
            attributions,
        };
        if (!cancelled) await this.#publishTermination(workspaceId, { sessionId, ...loopResult });
        return { loopResult, announced: !cancelled };
    }

    // {§methods} loop.cancel / shutdown aborted the live drain. A cancellation is the loop's
    // TERMINAL state (499), delivered via loop/terminated (runLoop no longer blocks to return it), and the
    // exact 499 is persisted before it is broadcast ({§session-loop-lifecycle}).
    async #settleCancelledDrain(scope: DrainScope, currentLoopId: number | null): Promise<void> {
        const { workspaceId, sessionId, controller, first } = scope;
        const message = ErrorDetail.preview(controller.signal.reason ?? "user_cancelled")
            || "no reason was supplied";
        const cancelledResult = () => Results.failure(
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
        );
        let usage: LoopUsage = {
            accounting: aggregateProviderAccounting([]),
            curationWeight: null,
            curationBudget: null,
            contextTokens: null,
            contextCapacity: null,
            meta: {},
        };
        let attributions: string[] = [];
        if (currentLoopId !== null) {
            const cancelled = await this.#lifecycle.finish(currentLoopId, cancelledResult(), { terminatedBy: "cancel" });
            [usage, attributions] = await Promise.all([
                this.#loopUsage(currentLoopId),
                this.#loopAttributions(currentLoopId),
            ]);
            if (cancelled !== null) {
                await this.#reapLoop(currentLoopId);
                await this.#publishTermination(workspaceId, {
                    sessionId,
                    loopId: currentLoopId,
                    result: cancelled,
                    hitMaxTurns: false,
                    turnIds: await this.#lifecycle.turnIds(currentLoopId),
                    usage,
                    attributions,
                });
                await this.#abandonUnanswered(workspaceId, sessionId, currentLoopId, cancelled.status);
            }
        }
        if (!first.settled) {
            first.settled = true;
            first.resolve({
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

    // {§session-loop-lifecycle} A non-abort drain failure becomes an exact durable 500 and terminal
    // notification; daemon diagnostics retain the complete caught error.
    async #settleFailedDrain(scope: DrainScope, currentLoopId: number | null, err: unknown): Promise<void> {
        const { workspaceId, sessionId, first } = scope;
        console.error(`drain error (workspace ${workspaceId}, session ${sessionId}, loop ${currentLoopId ?? "?"}):`, err);
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
            const finished = await this.#lifecycle.finish(currentLoopId, failure);
            // A loop a cancellation retired is that cancellation's to announce.
            if (finished !== null || !await this.#lifecycle.cancelled(currentLoopId)) {
                const settled = finished ?? await this.#lifecycle.result(currentLoopId);
                if (settled === null) {
                    throw new Error(`drain could not settle loop ${currentLoopId}`, { cause: err });
                }
                await this.#reapLoop(currentLoopId);
                await this.#announce(workspaceId, sessionId, currentLoopId, settled);
            }
        }
        if (!first.settled) {
            first.settled = true;
            first.reject(err);
        }
    }

    // Per-session drain-transition lock (R4 / {§session-causal-admission}). ensureDrain's
    // start and a drain's teardown relinquish both run under it, serialized, so the two
    // can't interleave and register two drains for one session. The critical section is the
    // registry decision only (never a loop's work) — a sub-ms hop at drain boundaries.
    // A promise-chain mutex: each caller awaits the prior holder; the tail self-prunes
    // when idle so the Map stays bounded to sessions mid-transition.
    #withDrainLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
        return DrainSupervisor.#withLock(this.#drainLocks, sessionId, fn);
    }

    // {§session-causal-admission}: workspace control precedes session queue control;
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

    // The drain guarantee, serialized per session via #withDrainLock so it can't race a
    // sibling drain's teardown relinquish into a double-drain (R4). A live drain
    // (registered, NOT aborting) will claim the just-enqueued loop in its own iteration
    // or its lock-held exit re-claim → return null. A registered-but-ABORTING drain is
    // in teardown and won't claim, so we don't defer to it — start fresh, or the loop
    // strands on a cancel/resume race (I6 no-lost-loop). Otherwise start one.
    async ensureDrain(opts: {
        workspaceId: number; sessionId: number;
        systemPrompt: string;
    }): Promise<DrainStartResult | null> {
        let deferred = false;
        const started = await this.#withDrainLock(opts.sessionId, async () => {
            if (!this.#acceptingWork) return null;
            const existing = this.#activeDrains.get(opts.sessionId);
            if (existing !== undefined && !existing.controller.signal.aborted) return null;
            if (await this.#db.drain_ready_loop.get({ session_id: opts.sessionId }) === undefined) {
                deferred = true;
                return null;
            }
            if (!this.#acceptingWork) return null;
            return this.#startDrain(opts);
        });
        if (deferred) await this.scheduleWakes(opts.workspaceId, opts.sessionId, opts.systemPrompt);
        return started;
    }

    // {§session-causal-admission}: promotion shares admission and queue control
    // with enqueue, cancellation, and drain teardown.
    async reconcileOrphanedMessages(sessionId: number, endedLoopId: number): Promise<void> {
        const row = await this.#db.drain_get_session_workspace.get<{ workspace_id: number }>({ session_id: sessionId });
        if (row === undefined) throw new Error(`message promotion session ${sessionId} does not exist`);
        return this.#withAdmissionLock(row.workspace_id, () =>
            this.#withDrainLock(sessionId, () => this.#reconcileMessages(sessionId, endedLoopId)));
    }

    async #reconcileMessages(sessionId: number, endedLoopId: number): Promise<void> {
        const recovery = await this.#db.drain_enqueue_orphan_recovery_loop.get<{
            id: number;
            message_count: number;
        }>({
            session_id: sessionId,
            orphan_source_loop_id: endedLoopId });
        if (recovery === undefined) return;
        const moved = await this.#db.drain_rehome_orphaned_messages.run({
            source_loop_id: endedLoopId,
            target_loop_id: recovery.id });
        if (moved.changes !== recovery.message_count) {
            throw new Error(`reconcileOrphanedMessages: expected to re-home ${recovery.message_count} messages, moved ${moved.changes}`);
        }
    }

    #sessionSignal(sessionId: number): AbortController {
        const existing = this.#sessionAborts.get(sessionId);
        if (existing !== undefined && !existing.signal.aborted) return existing;
        const fresh = new AbortController();
        this.#sessionAborts.set(sessionId, fresh);
        return fresh;
    }

    async #cancelTree(sessionId: number, reason: string, includeRoot: boolean): Promise<void> {
        const owner = await this.#db.drain_get_session_workspace.get<{ workspace_id: number }>({ session_id: sessionId });
        if (owner === undefined) throw new Error(`cancellation session ${sessionId} does not exist`);
        const { cancelled, subscriptions, drains } = await this.#withAdmissionLock(owner.workspace_id, async () => {
            const tree = await this.#lifecycle.cancelTree(sessionId, reason, includeRoot);
            const open = await Promise.all(tree.sessionIds.map(async (id) =>
                [id, await ChannelWrite.findOpenSubscriptionsForSession(this.#db, id)] as const));
            const draining = new Map<number, Promise<unknown>>();
            for (const targetSessionId of tree.sessionIds) {
                for (const [loopId, timer] of this.#loopTimers) {
                    if (timer.sessionId === targetSessionId) this.#clearLoopTimer(loopId);
                }
                const scope = this.#sessionAborts.get(targetSessionId);
                if (scope !== undefined && !scope.signal.aborted) scope.abort(reason);
                const drain = this.#activeDrains.get(targetSessionId);
                if (drain !== undefined) draining.set(targetSessionId, drain.promise);
            }
            return { cancelled: tree, subscriptions: new Map(open), drains: draining };
        });
        await Promise.all([...subscriptions.values()].flat().map(({ id }) => this.#cancelSubscription(id)));
        for (const { loopId, sessionId: targetSessionId, result } of cancelled.loops) {
            const row = await this.#db.drain_get_session_workspace.get<{ workspace_id: number }>({
                session_id: targetSessionId,
            });
            if (row === undefined) continue;
            const announce = (): Promise<void> => this.#announce(row.workspace_id, targetSessionId, loopId, result);
            // {§notifications} What a retired loop held settles as its session's drain unwinds the turn
            // and its streams close; the terminal follows both. The caller is not held: it may be that turn.
            const drain = drains.get(targetSessionId);
            const held = [
                ...drain === undefined ? [] : [drain],
                ...(subscriptions.get(targetSessionId) ?? []).map(({ id }) => this.#streamConcluded(id)),
            ];
            if (held.length === 0) await announce();
            else void this.#trackSettlement(Promise.allSettled(held).then(announce), `announce(${loopId})`);
        }
    }

    // A terminal loop's loop/terminated, then what it left unanswered answered for it.
    async #announce(workspaceId: number, sessionId: number, loopId: number, result: SchemeResult): Promise<void> {
        const [usage, attributions, turnIds] = await Promise.all([
            this.#loopUsage(loopId),
            this.#loopAttributions(loopId),
            this.#lifecycle.turnIds(loopId),
        ]);
        await this.#publishTermination(workspaceId, { sessionId, loopId, result, hitMaxTurns: false, turnIds, usage, attributions });
        await this.#abandonUnanswered(workspaceId, sessionId, loopId, result.status);
    }

    // {§loop-completion} — after a loop's end is durable and published, whatever it left unanswered is
    // answered for it. A failure here is logged, never a second failure of the loop that already ended.
    async #abandonUnanswered(workspaceId: number, sessionId: number, loopId: number, status: number): Promise<void> {
        try {
            await this.#completeAbandonedMessages(workspaceId, sessionId, loopId, status);
        } catch (cause) {
            console.error(`message abandonment for loop ${loopId} (status ${status}) failed:`, cause);
        }
    }

    cancelSessionTree(sessionId: number, reason: string): Promise<void> {
        return this.#trackSettlement(this.#cancelTree(sessionId, reason, true), `cancelTree(${sessionId})`);
    }

    cancelDescendants(sessionId: number, reason: string): Promise<void> {
        return this.#trackSettlement(this.#cancelTree(sessionId, reason, false), `cancelDescendants(${sessionId})`);
    }

    cancel(sessionId: number, reason: string = "user_cancelled"): boolean {
        const hadDrain = this.#activeDrains.has(sessionId);
        const hadWork = hadDrain || this.#hasActiveStreams(sessionId);
        void this.cancelSessionTree(sessionId, reason);
        return hadWork;
    }

    // {§module-shutdown-order}: the producer emits synchronously, while the
    // supervisor owns the asynchronous scheduler work and its shutdown truth.
    notifyWakeSession(payload: WakeSessionPayload): void {
        const { subscriptionId } = payload;
        const announced = Promise.withResolvers<void>();
        const announcement = { sessionId: payload.sessionId, delivered: announced.promise };
        this.#streamAnnouncements.set(subscriptionId, announcement);
        const handled = this.#handleWakeSession(payload, announced.resolve).finally(() => {
            announced.resolve();
            if (this.#streamAnnouncements.get(subscriptionId) === announcement) this.#streamAnnouncements.delete(subscriptionId);
        });
        void this.#trackSettlement(handled, "wake-on-completion");
    }

    // {§notifications} A subscription's conclusion as its observers receive it: its close delivered,
    // then its `stream/concluded` published.
    async #streamConcluded(subscriptionId: number): Promise<void> {
        await this.#subscriptionConcluded(subscriptionId);
        await this.#streamAnnouncements.get(subscriptionId)?.delivered;
    }

    // {§notifications} {§exec-lifetime} What the loop's terminal reaps, concluded and announced.
    async #reapLoop(loopId: number): Promise<void> {
        const reaped = await this.#reapLoopStreams(loopId);
        await Promise.all(reaped.map((subscriptionId) => this.#streamConcluded(subscriptionId)));
    }

    async operationSettled(workspaceId: number, logEntryId: number): Promise<void> {
        const recipients = await this.#db.message_reply_recipients.all<{ session_id: number }>({ log_entry_id: logEntryId });
        if (recipients.length === 0) return;
        const systemPrompt = await this.#readSystemPrompt(); // {§packet-inject}
        for (const { session_id: sessionId } of recipients) {
            // {§session-causal-admission}: the sender must finish its own
            // program while the recipient coalesces replies and conclusions.
            void this.#trackSettlement(this.settleCompletionWake(workspaceId, sessionId, systemPrompt), "wake-on-reply");
        }
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

    async #handleWakeSession(payload: WakeSessionPayload, announced: () => void): Promise<void> {
        const { workspaceId, ...conclusion } = payload;
        const conclude = (wakeAction: string): void => {
            this.#emit(workspaceId, "stream/concluded", { ...conclusion, wakeAction });
            announced();
        };
        // {§session-causal-admission}: scope cancellation, not the
        // command's result code, prevents a wake. Cancelling one command still
        // produces an observation owed to its live session.
        const scope = this.#sessionAborts.get(payload.sessionId);
        if (scope?.signal.aborted === true) {
            conclude(payload.result.status === 499 ? "skipped-aborted" : "skipped-cancelled");
            return;
        }

        const systemPrompt = await this.#readSystemPrompt(); // {§packet-inject}

        // {§notifications}: publish the terminal stream fact
        // before settlement. Rechecked wait identities, not this event, decide
        // whether any loop actually resumes.
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ session_id: payload.sessionId });
        if (slept !== undefined) {
            // {§session-causal-admission} — publish this conclusion now,
            // then let the session-local gate coalesce only the provider
            // dispatch. Concurrent stream/child callbacks join that one gate.
            const settlement = this.settleCompletionWake(
                workspaceId,
                payload.sessionId,
                systemPrompt,
            );
            conclude("wake-pending");
            await settlement;
            return;
        }

        // No slept loop. A live loop surfaces the concluded stream ambiently via the
        // environment-observation injector ({§exec-stream}) on its next turn; the client is told.
        if (this.#activeDrains.has(payload.sessionId)) {
            conclude("no-op-active-loop");
            return;
        }

        // No slept loop, no active drain — nothing to resume (e.g. a completed session whose
        // streams were swept). Surface the conclusion without opening a loop.
        conclude("no-loop");
    }

    #clearLoopTimer(loopId: number): void {
        const current = this.#loopTimers.get(loopId);
        if (current === undefined) return;
        clearTimeout(current.timer);
        this.#loopTimers.delete(loopId);
    }

    async scheduleWakes(workspaceId: number, sessionId: number, systemPrompt: string): Promise<void> {
        await this.#withDrainLock(sessionId, async () => {
            if (!this.#acceptingWork) return;
            const waits = await this.#lifecycle.parked(sessionId);
            if (!this.#acceptingWork) return;
            for (const [loopId, timer] of this.#loopTimers) {
                if (timer.sessionId === sessionId && !waits.some(({ id }) => id === loopId)) this.#clearLoopTimer(loopId);
            }
            for (const wait of waits) {
                if (wait.wait_poll_at === null) continue;
                this.#armTimer(workspaceId, sessionId, systemPrompt, wait.id, wait.wait_revision, wait.wait_poll_at);
            }
        });
    }

    #armTimer(workspaceId: number, sessionId: number, systemPrompt: string, loopId: number, revision: number, dueAt: number): void {
        if (!this.#acceptingWork) return;
        const prior = this.#loopTimers.get(loopId);
        if (prior?.revision === revision && prior.dueAt === dueAt) return;
        this.#clearLoopTimer(loopId);
        const timer = setTimeout(() => {
            if (this.#loopTimers.get(loopId)?.timer !== timer) return;
            this.#loopTimers.delete(loopId);
            void this.#trackSettlement(this.#wakeTimedLoop(workspaceId, sessionId, systemPrompt, loopId, revision), "wake-on-completion");
        }, Math.max(1, Math.min(dueAt - Date.now(), 2_147_483_647)));
        timer.unref();
        this.#loopTimers.set(loopId, { sessionId, revision, dueAt, timer });
    }

    async #wakeTimedLoop(workspaceId: number, sessionId: number, systemPrompt: string, loopId: number, revision: number): Promise<void> {
        if (!this.#acceptingWork) return;
        if (await this.#withDrainLock(sessionId, () => this.#wakeLoop(workspaceId, sessionId, loopId, { revision, dueAt: Date.now() }))) {
            await this.ensureDrain({ workspaceId, sessionId, systemPrompt });
        } else {
            // A capped timer or backwards clock may fire before the durable due time.
            await this.scheduleWakes(workspaceId, sessionId, systemPrompt);
        }
    }

    // {§operation-results} — the clock belongs to the durable park, not the client receipt.
    async #emitLoopStatus(workspaceId: number, sessionId: number, loopId: number, status: 100 | 102 | 202): Promise<void> {
        const wait = status === 202 ? (await this.#lifecycle.parked(sessionId)).find(({ id }) => id === loopId) : null;
        if (wait === undefined) return;
        const waitUntil = wait?.wait_poll_at ?? null;
        const { loopSeq, claimedAt, packetCount } = await this.#lifecycle.observation(loopId);
        this.#emit(workspaceId, "notice/event", {
            sessionId, loopId, notice: { source: "engine:lifecycle", kind: "loop_status", level: "info", status, loopSeq, waitUntil, packetCount, claimedAt },
        });
    }

    async #wakeLoop(workspaceId: number, sessionId: number, loopId: number, condition: Parameters<LoopLifecycle["wake"]>[1] = {}): Promise<boolean> {
        // {§session-causal-admission}: test admission at the mutation,
        // after asynchronous prompt, completion, or deadline selection.
        if (!this.#acceptingWork || this.#sessionAborts.get(sessionId)?.signal.aborted) return false;
        const woke = await this.#lifecycle.wake(loopId, condition);
        if (woke) {
            this.#clearLoopTimer(loopId);
            await this.#emitLoopStatus(workspaceId, sessionId, loopId, 100);
        }
        return woke;
    }

    async #wakeParkedSession(workspaceId: number, sessionId: number, systemPrompt: string): Promise<void> {
        if (!this.#acceptingWork) return;
        const woke = await this.#withDrainLock(sessionId, async () => {
            const waits = await this.#lifecycle.parked(sessionId);
            let changed = false;
            for (const wait of waits) {
                if (await this.#wakeLoop(workspaceId, sessionId, wait.id, { revision: wait.wait_revision, eventOnly: true })) {
                    changed = true;
                }
            }
            return changed;
        });
        if (!woke) return;
        const started = await this.ensureDrain({
            workspaceId, sessionId, systemPrompt,
        });
        started?.drainPromise?.catch((err: unknown) => {
            if (this.#acceptingWork) {
                console.error("wake-parked resume drain failed:", err instanceof Error ? err.message : String(err));
            }
        });
    }

    async #sessionHasLiveObligation(sessionId: number): Promise<boolean> {
        // {§loop-completion} — the same row the completion gate reads.
        const held = await this.#db.session_live_obligations.get<{ streams: 0 | 1; sessions: 0 | 1 }>({ session_id: sessionId });
        return held !== undefined && (held.streams === 1 || held.sessions === 1);
    }

    settleCompletionWake(
        workspaceId: number,
        sessionId: number,
        systemPrompt: string,
    ): Promise<void> {
        const existing = this.#completionWakeGates.get(sessionId);
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
        this.#completionWakeGates.set(sessionId, gate);
        void this.#runCompletionWake(
            workspaceId,
            sessionId,
            systemPrompt,
            gate,
        ).then(completed.resolve, completed.reject).finally(() => {
            if (this.#completionWakeGates.get(sessionId) === gate) {
                this.#completionWakeGates.delete(sessionId);
            }
        });
        return gate.promise;
    }

    async #runCompletionWake(
        workspaceId: number,
        sessionId: number,
        systemPrompt: string,
        gate: CompletionWakeGate,
    ): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ session_id: sessionId });
        if (slept === undefined) {
            this.#releaseCompletionWake(sessionId, gate);
            return this.#wakeParkedSession(workspaceId, sessionId, systemPrompt);
        }

        const timeoutMs = readOptimisticSettlementMs();
        if (timeoutMs === 0 || !(await this.#sessionHasLiveObligation(sessionId))) {
            this.#releaseCompletionWake(sessionId, gate);
            return this.#wakeParkedSession(workspaceId, sessionId, systemPrompt);
        }

        return observed(
            "session.wake.settlement",
            { "window.ms": timeoutMs },
            async (span) => {
                const startedAt = performance.now();
                const signal = this.#sessionAborts.get(sessionId)?.signal;
                const deadline = delay(timeoutMs, "deadline" as const, { signal, ref: false })
                    .catch((cause: unknown) => {
                        if (signal?.aborted === true) return "cancelled" as const;
                        throw cause;
                    });
                let release: "quiescent" | "deadline" | "cancelled" = "quiescent";
                while (await this.#sessionHasLiveObligation(sessionId)) {
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
                this.#releaseCompletionWake(sessionId, gate);
                if (release === "cancelled") return;
                return this.#wakeParkedSession(workspaceId, sessionId, systemPrompt);
            },
        );
    }

    #releaseCompletionWake(sessionId: number, gate: CompletionWakeGate): void {
        if (this.#completionWakeGates.get(sessionId) === gate) {
            this.#completionWakeGates.delete(sessionId);
        }
    }

    // {§notifications} — the terminal carries the stamp a snapshot reads.
    async #publishTermination(workspaceId: number, event: DrainLoopResult & { sessionId: number }): Promise<void> {
        const { loopSeq, terminatedAt } = await this.#lifecycle.observation(event.loopId);
        // A durable close releases the live handle before its announcement is delivered.
        await Promise.all([...this.#streamAnnouncements.values()]
            .filter(({ sessionId }) => sessionId === event.sessionId)
            .map(({ delivered }) => delivered));
        this.#discardLoopNotices(event.loopId);
        this.#emit(workspaceId, "loop/terminated", { ...event, loopSeq, terminatedAt });
        void this.#trackSettlement(this.#notifyParentCompletion(workspaceId, event.sessionId), "wake-on-completion");
    }

    // {§session-causal-admission}: completion belongs to a task, not drain teardown.
    async #notifyParentCompletion(workspaceId: number, sessionId: number): Promise<void> {
        const parent = await this.#db.session_parent_id.get<{ parent_session_id: number | null }>({ session_id: sessionId });
        if (parent?.parent_session_id == null) return;
        await this.settleCompletionWake(workspaceId, parent.parent_session_id, await this.#readSystemPrompt());
    }
}
