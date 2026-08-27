// {§agui-daemon-client} The in-process module's orchestration engine composes the seam +
// the render router + the HITL core into the worker flow: subscribe ONCE to the event
// source, route each event to the Run that owns its worker/loop, drive/cancel loops via
// the seam, and route standard resume entries to resolveProposal. Transport-agnostic —
// the HTTP/SSE listener (the outward edge) and workspace establishment (workspace-lifecycle
// hook, pending) wrap this; the engine is testable against a mock seam today.

import EventRouter from "./EventRouter.ts";
import type { TranslatorContinuation } from "./Translator.ts";
import ProposalHitl, { type HitlBatch } from "./ProposalHitl.ts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import { EventType, type AguiEvent } from "./types.ts";
import type { Interrupt, ResumeEntry } from "@ag-ui/core";

interface Thread {
    workerId: number;
    loopId: number | null;
    notificationScope: NotificationScope;
    router: EventRouter;
    emit: (events: AguiEvent[]) => void;
    threadId: string;
    inputRunId: string;
    openStreams: Set<number>;
    deferredFinish: AguiEvent[] | null;
    pendingTerminations: unknown[];
}

export type NotificationScope = "conversation" | "operation" | "result";

// The engine needs only the AG-UI Run-flow slice of the seam (workspace lifecycle and reads
// belong to the Module edge above it) — declare exactly that.
type PortalSeam = Pick<
    ApplicationPort,
    | "subscribeToEvents"
    | "pendingProposals"
    | "resolveProposal"
    | "pendingClientInteractions"
    | "resolveClientInteraction"
    | "runLoop"
    | "cancelDrain"
>;

export default class Portal {
    #seam: PortalSeam;
    // A workspace may have several simultaneous AG-UI Runs. The worker/loop carried by
    // each notification selects its owner; a Run is not a second broadcast subscription.
    #threads = new Map<number, Set<Thread>>();
    #hitl: ProposalHitl;
    #activeInterrupts = new Map<string, Interrupt>();
    #continuations = new Map<string, {
        workspaceId: number;
        workerId: number;
        loopId: number;
        threadId: string;
        notificationScope: NotificationScope;
        state: TranslatorContinuation;
    }>();
    #off: (() => void) | null = null;

    constructor(seam: PortalSeam) {
        this.#seam = seam;
        this.#hitl = new ProposalHitl(
            seam,
            (workspaceId, workerId, loopId, batch) => this.#emitHitl(workspaceId, workerId, loopId, batch),
        );
    }

    // One subscription for the whole module: render each event only to its owning Run.
    start(): void {
        this.#hitl.start();
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === null) return; // global (workspace/created) handled out-of-band
            const entryId = (params as { entryId?: unknown }).entryId;
            for (const thread of this.#threads.get(workspaceId) ?? []) {
                if (!Portal.#ownsNotification(thread, method, params)) continue;
                if (method === "loop/terminated") {
                    const loopId = (params as { loopId?: unknown }).loopId;
                    if (typeof loopId !== "number") continue;
                    if (thread.loopId === null) {
                        thread.pendingTerminations.push(params);
                        continue;
                    }
                    if (thread.loopId !== loopId) continue;
                }
                if (method === "stream/event" && typeof entryId === "number") thread.openStreams.add(entryId);
                if (method === "stream/concluded" && typeof entryId === "number") thread.openStreams.delete(entryId);
                const out = thread.router.route(method, params);
                if (out.length > 0) thread.emit(out);
                if (method === "stream/concluded" && thread.openStreams.size === 0 && thread.deferredFinish !== null) {
                    const deferred = thread.deferredFinish;
                    thread.deferredFinish = null;
                    this.#finishThread(thread, deferred);
                }
            }
        });
    }

    static #ownsNotification(thread: Thread, method: string, params: unknown): boolean {
        if (thread.notificationScope === "result") return false;
        const payload = params as {
            workerId?: unknown;
            loopId?: unknown;
            parentWorkerId?: unknown;
            entry?: { worker_id?: unknown; loop_id?: unknown };
        };
        const owns = (workerId: unknown, loopId?: unknown): boolean =>
            typeof workerId === "number"
            && workerId === thread.workerId
            && (thread.loopId === null || typeof loopId !== "number" || loopId === thread.loopId);
        switch (method) {
            case "log/entry": return owns(payload.entry?.worker_id, payload.entry?.loop_id);
            case "loop/terminated":
            case "loop/packet":
            case "reasoning/event": return owns(payload.workerId, payload.loopId);
            case "notice/event": return payload.workerId === null
                ? thread.notificationScope === "conversation"
                : owns(payload.workerId, payload.loopId);
            case "stream/event":
            case "stream/concluded": return owns(payload.workerId);
            case "workspace/branch-batch": return thread.notificationScope === "conversation"
                && (typeof payload.parentWorkerId !== "number" || payload.parentWorkerId === thread.workerId);
            default: return false;
        }
    }

    stop(): void {
        this.#hitl.stop();
        this.#off?.();
        this.#off = null;
        this.#continuations.clear();
    }

    #emitInterrupt(
        workspaceId: number,
        workerId: number,
        loopId: number,
        batch: HitlBatch,
    ): void {
        if (batch.events.length === 0) return;
        const workerThreads = [...(this.#threads.get(workspaceId) ?? [])]
            .filter((thread) => thread.notificationScope !== "result" && thread.workerId === workerId);
        const loopThreads = workerThreads.filter((thread) => thread.loopId === loopId);
        for (const thread of loopThreads.length > 0 ? loopThreads : workerThreads) {
            const state = thread.router.continuation();
            for (const interrupt of batch.interrupts) {
                const key = interrupt.toolCallId ?? interrupt.id;
                this.#continuations.set(key, {
                    workspaceId,
                    workerId,
                    loopId,
                    threadId: thread.threadId,
                    notificationScope: thread.notificationScope,
                    state,
                });
            }
            thread.emit(batch.events);
        }
    }

    #withHitl(batch: HitlBatch, emit: (events: AguiEvent[]) => void): void {
        for (const interrupt of batch.interrupts) {
            this.#activeInterrupts.set(interrupt.toolCallId ?? interrupt.id, interrupt);
        }
        try {
            emit(batch.events);
        } finally {
            for (const interrupt of batch.interrupts) {
                this.#activeInterrupts.delete(interrupt.toolCallId ?? interrupt.id);
            }
        }
    }

    #emitHitl(workspaceId: number, workerId: number, loopId: number, batch: HitlBatch): void {
        this.#withHitl(
            batch,
            () => this.#emitInterrupt(workspaceId, workerId, loopId, batch),
        );
    }

    interruptForToolCall(toolCallId: string): Interrupt | null {
        return this.#activeInterrupts.get(toolCallId) ?? null;
    }

    // Bind a client's SSE to a workspace and AG-UI Run. The emit consumer ends its stream when it
    // sees RUN_FINISHED / RUN_ERROR (the router's terminal projection) — the engine
    // owns notification routing; the edge owns the socket lifecycle. `workerId` is the lifecycle actor
    // (client worker for client ops, conversation worker otherwise); `modelWorkerId`
    // binds the render (null → the router lazily
    // adopts the first model-origin row's worker — a fresh workspace's model worker is born
    // at the drain).
    openThread(args: { workspaceId: number; workerId: number; threadId: string; notificationScope: NotificationScope; emit: (events: AguiEvent[]) => void; modelWorkerId?: number | null; inputRunId?: string; resume?: ResumeEntry[] }): unknown {
        const candidates = args.resume
            ?.map(({ interruptId }) => this.#continuations.get(interruptId)) ?? [];
        const restored = candidates.find((candidate) => candidate !== undefined
            && candidate.workspaceId === args.workspaceId
            && candidate.threadId === args.threadId);
        const continuation = restored?.state;
        const router = new EventRouter({
            threadId: args.threadId,
            runId: args.inputRunId ?? String(args.workerId),
            modelWorkerId: args.modelWorkerId ?? null,
            workspaceId: args.workspaceId,
            ...(continuation === undefined ? {} : { continuation }),
        });
        const t: Thread = {
            workerId: args.workerId,
            loopId: null,
            notificationScope: restored?.notificationScope ?? args.notificationScope,
            router,
            emit: args.emit,
            threadId: args.threadId,
            inputRunId: args.inputRunId ?? String(args.workerId),
            openStreams: new Set(),
            deferredFinish: null,
            pendingTerminations: [],
        };
        let set = this.#threads.get(args.workspaceId);
        if (set === undefined) { set = new Set(); this.#threads.set(args.workspaceId, set); }
        set.add(t);
        return t;
    }

    closeRun(workspaceId: number, t: unknown): void { this.#threads.get(workspaceId)?.delete(t as Thread); }

    replay(thread: unknown, entries: Array<Record<string, unknown>>): AguiEvent[] {
        return (thread as Thread).router.replay(entries);
    }

    #finishThread(thread: Thread, events: AguiEvent[]): void {
        thread.emit([...events, { type: EventType.RUN_FINISHED, threadId: thread.threadId, runId: thread.inputRunId, outcome: { type: "success" } }]);
    }

    finishThread(thread: unknown, events: AguiEvent[]): void {
        const bound = thread as Thread;
        if (bound.openStreams.size > 0) {
            bound.deferredFinish = events;
            return;
        }
        this.#finishThread(bound, events);
    }

    // Emit extra events + RUN_FINISHED through the resumed Run that owns the
    // original action's worker and client thread —
    // an action that paused on a proposal completes after the resume AG-UI Run rebound the
    // stream, so its result must ride whichever response is live now, never the
    // closure of the request that spawned it.
    finishRun(workspaceId: number, workerId: number, threadId: string, events: AguiEvent[]): void {
        for (const t of this.#threads.get(workspaceId) ?? []) {
            if (t.notificationScope === "result" || t.workerId !== workerId || t.threadId !== threadId) continue;
            this.finishThread(t, events);
        }
    }



    // Drive a prompt through the loop (fire-and-forget — the outcome streams via the
    // subscription as loop/terminated). Re-surface any pending stopped-world first.
    async run(thread: unknown, args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: { auto?: boolean }; openPaths?: string[]; selector?: string; childSelector?: string | null }): Promise<{ loopId: number } | null> {
        const pending = await this.#hitl.resurface(args.workspaceId, args.workerId);
        if (pending.events.length > 0) {
            this.#withHitl(pending, (events) => (thread as Thread).emit(events));
            return null;
        }
        const ack = await this.#seam.runLoop(args);
        const bound = thread as Thread;
        bound.loopId = ack.loopId;
        const terminal = bound.pendingTerminations.find((params) => (params as { loopId?: unknown }).loopId === ack.loopId);
        bound.pendingTerminations = [];
        if (terminal !== undefined) {
            const out = bound.router.route("loop/terminated", terminal);
            if (out.length > 0) bound.emit(out);
        }
        return { loopId: ack.loopId };
    }

    cancel(workerId: number): boolean { return this.#seam.cancelDrain(workerId); }

    // A standard resume AG-UI Run binds to the persisted continuation before
    // releasing every addressed interrupt.
    async resolve(workspaceId: number, thread: unknown, entries: ResumeEntry[]): Promise<void> {
        const bound = thread as Thread;
        await this.#hitl.resolve(workspaceId, entries, (resolution) => {
            bound.workerId = resolution.workerId;
            bound.loopId = resolution.loopId;
            const terminal = bound.pendingTerminations.find(
                (params) => (params as { loopId?: unknown }).loopId === resolution.loopId,
            );
            bound.pendingTerminations = [];
            if (terminal !== undefined) {
                const out = bound.router.route("loop/terminated", terminal);
                if (out.length > 0) bound.emit(out);
            }
        });
        for (const { interruptId } of entries) this.#continuations.delete(interruptId);
    }
}
