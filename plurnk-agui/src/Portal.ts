// The in-process module's orchestration engine (plurnk-agui#2). Composes the seam +
// the render router + the HITL core into the worker flow: subscribe ONCE to the event
// source, fan each event to the bound thread for its workspace, drive/cancel loops via
// the seam, and route standard resume entries to resolveProposal. Transport-agnostic —
// the HTTP/SSE listener (the outward edge) and workspace establishment (workspace-lifecycle
// hook, pending) wrap this; the engine is testable against a mock seam today.

import EventRouter from "./EventRouter.ts";
import ProposalHitl from "./ProposalHitl.ts";
import type { DaemonSeam } from "./DaemonSeam.ts";
import { EventType, type AguiEvent } from "./types.ts";
import type { ResumeEntry } from "@ag-ui/core";

interface Thread {
    workerId: number;
    loopId: number | null;
    router: EventRouter;
    emit: (events: AguiEvent[]) => void;
    threadId: string;
    inputRunId: string;
    openStreams: Set<number>;
    deferredFinish: AguiEvent[] | null;
    pendingTerminations: unknown[];
}

// The engine needs only the AG-UI Run-flow slice of the seam (workspace lifecycle and reads
// belong to the Module edge above it) — declare exactly that.
type PortalSeam = Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "runLoop" | "cancelDrain">;

export default class Portal {
    #seam: PortalSeam;
    // Broadcast semantics (the WS wire fanned to every connection): a workspace fans to
    // all its open AG-UI Runs — concurrent action Runs must not clobber each other's gates.
    #threads = new Map<number, Set<Thread>>();
    #hitl: ProposalHitl;
    #off: (() => void) | null = null;

    constructor(seam: PortalSeam) {
        this.#seam = seam;
        this.#hitl = new ProposalHitl(seam, (workspaceId, workerId, events) => this.#emitToWorker(workspaceId, workerId, events));
    }

    // One subscription for the whole module: render each event to its workspace's thread.
    start(): void {
        this.#hitl.start();
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === null) return; // global (workspace/created) handled out-of-band
            const entryId = (params as { entryId?: unknown }).entryId;
            for (const thread of this.#threads.get(workspaceId) ?? []) {
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

    stop(): void {
        this.#hitl.stop();
        this.#off?.();
        this.#off = null;
    }

    #emitToWorker(workspaceId: number, workerId: number, events: AguiEvent[]): void {
        if (events.length === 0) return;
        for (const t of this.#threads.get(workspaceId) ?? []) {
            if (t.workerId === workerId) t.emit(events);
        }
    }

    // Bind a client's SSE to a workspace and AG-UI Run. The emit consumer ends its stream when it
    // sees RUN_FINISHED / RUN_ERROR (the router's terminal projection) — the engine
    // just fans; the edge owns the socket lifecycle. `workerId` is the driving worker (the
    // client envelope's); `modelWorkerId` binds the render (null → the router lazily
    // adopts the first model-origin row's worker — a fresh workspace's model worker is born
    // at the drain).
    openThread(args: { workspaceId: number; workerId: number; threadId: string; emit: (events: AguiEvent[]) => void; modelWorkerId?: number | null; inputRunId?: string }): unknown {
        const router = new EventRouter({ threadId: args.threadId, runId: args.inputRunId ?? String(args.workerId), modelWorkerId: args.modelWorkerId ?? null, workspaceId: args.workspaceId });
        const t: Thread = {
            workerId: args.workerId,
            loopId: null,
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

    // Emit extra events + RUN_FINISHED through the workspace's CURRENT thread binding —
    // an action that paused on a proposal completes after the resume AG-UI Run rebound the
    // stream, so its result must ride whichever response is live now, never the
    // closure of the request that spawned it.
    finishRun(workspaceId: number, events: AguiEvent[]): void {
        for (const t of this.#threads.get(workspaceId) ?? []) {
            this.finishThread(t, events);
        }
    }



    // Drive a prompt through the loop (fire-and-forget — the outcome streams via the
    // subscription as loop/terminated). Re-surface any pending stopped-world first.
    async run(thread: unknown, args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: { auto?: boolean } }): Promise<{ loopId: number } | null> {
        const pending = await this.#hitl.resurface(args.workspaceId, args.workerId);
        if (pending.length > 0) {
            (thread as Thread).emit(pending);
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
        const resolution = await this.#hitl.resolve(workspaceId, entries);
        const bound = thread as Thread;
        bound.workerId = resolution.workerId;
        bound.loopId = resolution.loopId;
    }
}
