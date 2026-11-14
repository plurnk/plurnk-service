// {§session-loop-lifecycle} {§session-wait-timing} {§session-causal-admission}
// Dynamic OTP-style supervisor over per-session SessionProcess actors and per-workspace
// WorkspaceAdmission serializers. Owns lifecycle start/stop/idle, settlement fault aggregation,
// and causal event routing across sessions without daemon-wide O(N) session scans.

import type { WakeSessionPayload } from "../core/ChannelWrite.ts";
import type { Db } from "../core/Db.ts";
import type LoopLifecycle from "../core/LoopLifecycle.ts";
import SessionProcess, {
    type DrainEngine,
    type DrainInjectionArgs,
    type DrainInjectionResult,
    type DrainLoopResult,
    type DrainStartResult,
    type EmitEvent,
    type ParkedNotification,
    type RunLoop,
    type SessionProcessState,
    type TurnCeilingSelection,
} from "./SessionProcess.ts";
import WorkspaceAdmission from "./WorkspaceAdmission.ts";

export type {
    DrainEngine,
    DrainInjectionArgs,
    DrainInjectionResult,
    DrainLoopResult,
    DrainStartResult,
    ParkedNotification,
    SessionProcessState,
    TurnCeilingSelection,
};

export type DrainSupervisorObserver = Readonly<{
    onParked?: (event: ParkedNotification) => void | Promise<void>;
    onCompletionWake?: (event: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly phase: "before" | "entered" | "settled";
    }) => void | Promise<void>;
    onCancelTree?: (event: {
        readonly sessionId: number;
        readonly reason: string;
        readonly includeRoot: boolean;
        readonly phase: "before" | "started";
        readonly settlement?: Promise<void>;
    }) => void | Promise<void>;
}>;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
    typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

export default class DrainSupervisor {
    readonly #db: Db;
    readonly #engine: DrainEngine;
    readonly #lifecycle: LoopLifecycle;
    readonly #runLoop: RunLoop;
    readonly #hasActiveStreams: (sessionId: number) => boolean;
    readonly #readSystemPrompt: () => Promise<string>;
    readonly #emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
    readonly #emit: EmitEvent;

    readonly #sessions = new Map<number, SessionProcess>();
    readonly #admission: WorkspaceAdmission;
    readonly #settlementTasks = new Set<Promise<void>>();
    readonly #settlementFailures: unknown[] = [];
    readonly #observers = new Set<DrainSupervisorObserver>();
    #acceptingWork = false;
    #stopping = false;

    constructor({
        db,
        engine,
        lifecycle,
        runLoop,
        hasActiveStreams,
        readSystemPrompt,
        emitLogEntry,
        emit,
    }: {
        db: Db;
        engine: DrainEngine;
        lifecycle: LoopLifecycle;
        runLoop: RunLoop;
        hasActiveStreams: (sessionId: number) => boolean;
        readSystemPrompt: () => Promise<string>;
        emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
        emit: EmitEvent;
    }) {
        this.#db = db;
        this.#engine = engine;
        this.#lifecycle = lifecycle;
        this.#runLoop = runLoop;
        this.#hasActiveStreams = hasActiveStreams;
        this.#readSystemPrompt = readSystemPrompt;
        this.#emitLogEntry = emitLogEntry;
        this.#emit = emit;
        this.#admission = new WorkspaceAdmission({
            db,
            lifecycle,
            isAcceptingWork: () => this.#acceptingWork,
            getSession: (sessionId) => this.#getOrSpawnSession(sessionId),
            peekSession: (sessionId) => this.#peekSession(sessionId),
        });
    }

    get activeSessionCount(): number {
        return this.#sessions.size;
    }

    get activeTimerCount(): number {
        let total = 0;
        for (const proc of this.#sessions.values()) total += proc.activeTimerCount;
        return total;
    }

    get activeWorkspaceLockCount(): number {
        return this.#admission.activeWorkspaceLockCount;
    }

    sessionState(sessionId: number): SessionProcessState {
        return this.#peekSession(sessionId)?.state ?? "stopped";
    }

    observe(observer: DrainSupervisorObserver): () => void {
        this.#observers.add(observer);
        return () => {
            this.#observers.delete(observer);
        };
    }

    suspendSession(sessionId: number): () => Promise<void> {
        return this.#getOrSpawnSession(sessionId).suspend();
    }

    start(): void {
        this.#stopping = false;
        this.#acceptingWork = true;
    }

    beginStop(reason: string): void {
        this.#stopping = true;
        this.#acceptingWork = false;
        for (const proc of [...this.#sessions.values()]) {
            proc.beginStop(reason);
        }
    }

    async idle(): Promise<void> {
        for (;;) {
            const pending = [
                ...[...this.#sessions.values()].flatMap((proc) => proc.activePromises()),
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
        const delivery = await this.#admission.admitMessage(args);
        const started = await this.ensureDrain({
            workspaceId: args.workspaceId,
            sessionId: args.sessionId,
            systemPrompt: args.systemPrompt,
        });
        return { ...delivery, ...started };
    }

    async ensureDrain(opts: {
        workspaceId: number;
        sessionId: number;
        systemPrompt: string;
    }): Promise<DrainStartResult | null> {
        if (!this.#acceptingWork) return null;
        return this.#getOrSpawnSession(opts.sessionId).ensureRunning({
            workspaceId: opts.workspaceId,
            systemPrompt: opts.systemPrompt,
        });
    }

    async scheduleWakes(workspaceId: number, sessionId: number, systemPrompt: string): Promise<void> {
        if (!this.#acceptingWork) return;
        await this.#getOrSpawnSession(sessionId).scheduleWakes(workspaceId, systemPrompt);
    }

    cancelSessionTree(sessionId: number, reason: string): Promise<void> {
        const settlement = this.#trackSettlement(
            this.#cancelTree(sessionId, reason, true),
            `cancelTree(${sessionId})`,
        );
        this.#notifyCancelTreeStarted(sessionId, reason, true, settlement);
        return settlement;
    }

    cancelDescendants(sessionId: number, reason: string): Promise<void> {
        const settlement = this.#trackSettlement(
            this.#cancelTree(sessionId, reason, false),
            `cancelDescendants(${sessionId})`,
        );
        this.#notifyCancelTreeStarted(sessionId, reason, false, settlement);
        return settlement;
    }

    cancel(sessionId: number, reason: string = "user_cancelled"): boolean {
        const hadDrain = this.#peekSession(sessionId)?.isDraining === true;
        const hadWork = hadDrain || this.#hasActiveStreams(sessionId);
        void this.cancelSessionTree(sessionId, reason);
        return hadWork;
    }

    notifyWakeSession(payload: WakeSessionPayload): void {
        const handled = this.#getOrSpawnSession(payload.sessionId).notifyStreamConcluded(payload);
        void this.#trackSettlement(handled, "wake-on-completion");
    }

    async operationSettled(workspaceId: number, logEntryId: number): Promise<void> {
        const recipients = await this.#db.message_reply_recipients.all<{ session_id: number }>({
            log_entry_id: logEntryId,
        });
        if (recipients.length === 0) return;
        const systemPrompt = await this.#readSystemPrompt(); // {§packet-inject}
        for (const { session_id: sessionId } of recipients) {
            void this.#trackSettlement(
                this.settleCompletionWake(workspaceId, sessionId, systemPrompt),
                "wake-on-reply",
            );
        }
    }

    settleCompletionWake(
        workspaceId: number,
        sessionId: number,
        systemPrompt: string,
    ): Promise<void> {
        if (this.#observers.size === 0) {
            return this.#getOrSpawnSession(sessionId).settleCompletionWake(workspaceId, systemPrompt);
        }
        return this.#observedCompletionWake(workspaceId, sessionId, systemPrompt);
    }

    async #observedCompletionWake(
        workspaceId: number,
        sessionId: number,
        systemPrompt: string,
    ): Promise<void> {
        for (const observer of this.#observers) {
            const maybePromise = observer.onCompletionWake?.({ workspaceId, sessionId, phase: "before" });
            if (isPromiseLike(maybePromise)) await maybePromise;
        }
        const pending = this.#getOrSpawnSession(sessionId).settleCompletionWake(workspaceId, systemPrompt);
        for (const observer of this.#observers) {
            const maybePromise = observer.onCompletionWake?.({ workspaceId, sessionId, phase: "entered" });
            if (isPromiseLike(maybePromise)) await maybePromise;
        }
        try {
            await pending;
        } finally {
            for (const observer of this.#observers) {
                const maybePromise = observer.onCompletionWake?.({ workspaceId, sessionId, phase: "settled" });
                if (isPromiseLike(maybePromise)) await maybePromise;
            }
        }
    }

    async #cancelTree(sessionId: number, reason: string, includeRoot: boolean): Promise<void> {
        for (const observer of this.#observers) {
            const maybePromise = observer.onCancelTree?.({ sessionId, reason, includeRoot, phase: "before" });
            if (isPromiseLike(maybePromise)) await maybePromise;
        }
        const owner = await this.#db.drain_get_session_workspace.get<{ workspace_id: number }>({
            session_id: sessionId,
        });
        if (owner === undefined) throw new Error(`cancellation session ${sessionId} does not exist`);
        const { loops, subscriptions, drains } = await this.#admission.prepareCancelTree(
            owner.workspace_id,
            sessionId,
            reason,
            includeRoot,
        );
        await Promise.all([...subscriptions.values()].flat().map(({ id }) => this.#engine.cancelSubscription(id)));

        const subscriptionBarriers = new Map<number, ReadonlyArray<Promise<void>>>();
        for (const [targetSessionId, openSubs] of subscriptions) {
            if (openSubs.length === 0) continue;
            const proc = this.#getOrSpawnSession(targetSessionId);
            subscriptionBarriers.set(
                targetSessionId,
                openSubs.map(({ id }) => proc.awaitStreamConcluded(id)),
            );
        }

        for (const { loopId, sessionId: targetSessionId, result } of loops) {
            const row = await this.#db.drain_get_session_workspace.get<{ workspace_id: number }>({
                session_id: targetSessionId,
            });
            if (row === undefined) continue;
            const announce = async (): Promise<void> => {
                await this.#getOrSpawnSession(targetSessionId).announceLoopTermination(
                    row.workspace_id,
                    loopId,
                    result,
                    false,
                );
            };
            const drain = drains.get(targetSessionId);
            const held = [
                ...(drain === undefined ? [] : [drain]),
                ...(subscriptionBarriers.get(targetSessionId) ?? []),
            ];
            if (held.length === 0) await announce();
            else void this.#trackSettlement(Promise.allSettled(held).then(announce), `announce(${loopId})`);
        }
    }

    #notifyCancelTreeStarted(
        sessionId: number,
        reason: string,
        includeRoot: boolean,
        settlement: Promise<void>,
    ): void {
        for (const observer of this.#observers) {
            void observer.onCancelTree?.({
                sessionId,
                reason,
                includeRoot,
                phase: "started",
                settlement,
            });
        }
    }

    async #notifyParked(event: ParkedNotification): Promise<void> {
        for (const observer of this.#observers) {
            const maybePromise = observer.onParked?.(event);
            if (isPromiseLike(maybePromise)) await maybePromise;
        }
    }

    #peekSession(sessionId: number): SessionProcess | undefined {
        const existing = this.#sessions.get(sessionId);
        return existing !== undefined && !existing.isStopped ? existing : undefined;
    }

    #getOrSpawnSession(sessionId: number): SessionProcess {
        const existing = this.#peekSession(sessionId);
        if (existing !== undefined) return existing;
        const created = new SessionProcess({
            sessionId,
            db: this.#db,
            engine: this.#engine,
            lifecycle: this.#lifecycle,
            runLoop: this.#runLoop,
            hasActiveStreams: this.#hasActiveStreams,
            readSystemPrompt: this.#readSystemPrompt,
            emitLogEntry: this.#emitLogEntry,
            emit: this.#emit,
            isAcceptingWork: () => this.#acceptingWork,
            isStopping: () => this.#stopping,
            trackSettlement: (task, label) => this.#trackSettlement(task, label),
            requestDrain: (opts) => this.ensureDrain(opts),
            requestCompletionWake: (workspaceId, targetSessionId, systemPrompt) =>
                this.settleCompletionWake(workspaceId, targetSessionId, systemPrompt),
            onParked: (event) => this.#notifyParked(event),
            onQuiescent: (proc) => {
                if (this.#sessions.get(sessionId) === proc) {
                    this.#sessions.delete(sessionId);
                }
            },
        });
        this.#sessions.set(sessionId, created);
        return created;
    }

    #trackSettlement(task: Promise<void>, label: string): Promise<void> {
        this.#settlementTasks.add(task);
        void task.then(
            () => {
                this.#settlementTasks.delete(task);
            },
            (error: unknown) => {
                this.#settlementTasks.delete(task);
                this.#settlementFailures.push(error);
                console.error(`${label} failed:`, error);
            },
        );
        return task;
    }
}
