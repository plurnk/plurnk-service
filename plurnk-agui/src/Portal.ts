// The in-process module's orchestration engine (plurnk-agui#2). Composes the seam +
// the render router + the HITL core into the run flow: subscribe ONCE to the event
// source, fan each event to the bound thread for its session, drive/cancel loops via
// the seam, and route a resume tool-result to resolveProposal. Transport-agnostic —
// the HTTP/SSE listener (the outward edge) and session establishment (session-lifecycle
// hook, pending) wrap this; the engine is testable against a mock seam today.

import EventRouter from "./EventRouter.ts";
import ProposalHitl from "./ProposalHitl.ts";
import type { DaemonSeam } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";
import type { ToolResultMessage } from "./AguiPlus.ts";

interface Thread { runId: number; router: EventRouter; emit: (events: AguiEvent[]) => void; threadId: string; inputRunId: string; openStreams: Set<number>; deferredFinish: AguiEvent[] | null }

// The engine needs only the run-flow slice of the seam (session-lifecycle and reads
// belong to the Module edge above it) — declare exactly that.
type PortalSeam = Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "runLoop" | "cancelDrain">;

export default class Portal {
    #seam: PortalSeam;
    // Broadcast semantics (the WS wire fanned to every connection): a session fans to
    // ALL its open runs — concurrent action runs must not clobber each other's gates.
    #threads = new Map<number, Set<Thread>>();
    #hitl: ProposalHitl;
    #off: (() => void) | null = null;

    constructor(seam: PortalSeam) {
        this.#seam = seam;
        // HITL fans its tool-calls through the same session→thread route as the router.
        this.#hitl = new ProposalHitl(seam, (sessionId, events) => this.#fan(sessionId, events));
    }

    // One subscription for the whole module: render each event to its session's thread.
    start(): void {
        this.#hitl.start();
        this.#off = this.#seam.subscribeToEvents((sessionId, method, params) => {
            if (sessionId === null) return; // global (session/created) handled out-of-band
            const entryId = (params as { entryId?: unknown }).entryId;
            for (const thread of this.#threads.get(sessionId) ?? []) {
                if (method === "stream/event" && typeof entryId === "number") thread.openStreams.add(entryId);
                if (method === "stream/concluded" && typeof entryId === "number") thread.openStreams.delete(entryId);
                const out = thread.router.route(method, params);
                if (out.length > 0) thread.emit(out);
                if (method === "stream/concluded" && thread.openStreams.size === 0 && thread.deferredFinish !== null) {
                    const deferred = thread.deferredFinish;
                    thread.deferredFinish = null;
                    thread.emit([...deferred, { type: "RUN_FINISHED", threadId: thread.threadId, runId: thread.inputRunId }]);
                }
            }
        });
    }

    stop(): void {
        this.#hitl.stop();
        this.#off?.();
        this.#off = null;
    }

    #fan(sessionId: number, events: AguiEvent[]): void {
        if (events.length === 0) return;
        for (const t of this.#threads.get(sessionId) ?? []) t.emit(events);
    }

    // Bind a client's SSE to a session/run. The emit consumer ends its stream when it
    // sees RUN_FINISHED / RUN_ERROR (the router's terminal projection) — the engine
    // just fans; the edge owns the socket lifecycle. `runId` is the DRIVE run (the
    // client envelope's); `modelRunId` binds the render (null → the router lazily
    // adopts the first model-origin row's run — a fresh session's model run is born
    // at the drain).
    openThread(args: { sessionId: number; runId: number; threadId: string; emit: (events: AguiEvent[]) => void; modelRunId?: number | null; inputRunId?: string }): unknown {
        const router = new EventRouter({ threadId: args.threadId, runId: String(args.runId), modelRunId: args.modelRunId ?? null, sessionId: args.sessionId });
        const t: Thread = { runId: args.runId, router, emit: args.emit, threadId: args.threadId, inputRunId: args.inputRunId ?? String(args.runId), openStreams: new Set(), deferredFinish: null };
        let set = this.#threads.get(args.sessionId);
        if (set === undefined) { set = new Set(); this.#threads.set(args.sessionId, set); }
        set.add(t);
        return t;
    }

    closeRun(sessionId: number, t: unknown): void { this.#threads.get(sessionId)?.delete(t as Thread); }

    // Emit extra events + RUN_FINISHED through the session's CURRENT thread binding —
    // an action that paused on a proposal completes AFTER the resume run rebound the
    // stream, so its result must ride whichever response is live now, never the
    // closure of the request that spawned it.
    finishRun(sessionId: number, events: AguiEvent[]): void {
        for (const t of this.#threads.get(sessionId) ?? []) {
            if (t.openStreams.size > 0) { t.deferredFinish = events; continue; } // defer past live streams (event-driven, no timer)
            t.emit([...events, { type: "RUN_FINISHED", threadId: t.threadId, runId: t.inputRunId }]);
        }
    }



    // Drive a prompt through the loop (fire-and-forget — the outcome streams via the
    // subscription as loop/terminated). Re-surface any pending stopped-world first.
    async run(args: { sessionId: number; runId: number; prompt: string; maxTurns?: number; flags?: { yolo?: boolean } }): Promise<{ loopId: number }> {
        const pending = await this.#hitl.resurface(args.sessionId);
        this.#fan(args.sessionId, pending);
        const ack = await this.#seam.runLoop(args);
        return { loopId: ack.loopId };
    }

    cancel(runId: number): boolean { return this.#seam.cancelDrain(runId); }

    // A resume run's tool-result → resolveProposal (true if it resolved a proposal).
    resolve(message: ToolResultMessage): boolean { return this.#hitl.resolve(message); }
}
