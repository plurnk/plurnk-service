// The in-process module's orchestration engine (plurnk-agui#2). Composes the seam +
// the render router + the HITL core into the worker flow: subscribe ONCE to the event
// source, fan each event to the bound thread for its workspace, drive/cancel loops via
// the seam, and route a resume tool-result to resolveProposal. Transport-agnostic —
// the HTTP/SSE listener (the outward edge) and workspace establishment (workspace-lifecycle
// hook, pending) wrap this; the engine is testable against a mock seam today.

import EventRouter from "./EventRouter.ts";
import ProposalHitl from "./ProposalHitl.ts";
import type { DaemonSeam } from "./DaemonSeam.ts";
import type { AguiEvent } from "./types.ts";
import type { ToolResultMessage } from "./AguiPlus.ts";

interface Thread { workerId: number; router: EventRouter; emit: (events: AguiEvent[]) => void; threadId: string; inputRunId: string; openStreams: Set<number>; deferredFinish: AguiEvent[] | null }

// The engine needs only the run-flow slice of the seam (workspace-lifecycle and reads
// belong to the Module edge above it) — declare exactly that.
type PortalSeam = Pick<DaemonSeam, "subscribeToEvents" | "pendingProposals" | "resolveProposal" | "runLoop" | "cancelDrain">;

export default class Portal {
    #seam: PortalSeam;
    // Broadcast semantics (the WS wire fanned to every connection): a workspace fans to
    // ALL its open runs — concurrent action runs must not clobber each other's gates.
    #threads = new Map<number, Set<Thread>>();
    #hitl: ProposalHitl;
    #off: (() => void) | null = null;

    constructor(seam: PortalSeam) {
        this.#seam = seam;
        // HITL fans its tool-calls through the same workspace→thread route as the router.
        this.#hitl = new ProposalHitl(seam, (workspaceId, events) => this.#fan(workspaceId, events));
    }

    // One subscription for the whole module: render each event to its workspace's thread.
    start(): void {
        this.#hitl.start();
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === null) return; // global (workspace/created) handled out-of-band
            const entryId = (params as { entryId?: unknown }).entryId;
            for (const thread of this.#threads.get(workspaceId) ?? []) {
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

    #fan(workspaceId: number, events: AguiEvent[]): void {
        if (events.length === 0) return;
        for (const t of this.#threads.get(workspaceId) ?? []) t.emit(events);
    }

    // Bind a client's SSE to a workspace/run. The emit consumer ends its stream when it
    // sees RUN_FINISHED / RUN_ERROR (the router's terminal projection) — the engine
    // just fans; the edge owns the socket lifecycle. `workerId` is the DRIVE run (the
    // client envelope's); `modelWorkerId` binds the render (null → the router lazily
    // adopts the first model-origin row's run — a fresh workspace's model worker is born
    // at the drain).
    openThread(args: { workspaceId: number; workerId: number; threadId: string; emit: (events: AguiEvent[]) => void; modelWorkerId?: number | null; inputRunId?: string }): unknown {
        const router = new EventRouter({ threadId: args.threadId, runId: args.inputRunId ?? String(args.workerId), modelWorkerId: args.modelWorkerId ?? null, workspaceId: args.workspaceId });
        const t: Thread = { workerId: args.workerId, router, emit: args.emit, threadId: args.threadId, inputRunId: args.inputRunId ?? String(args.workerId), openStreams: new Set(), deferredFinish: null };
        let set = this.#threads.get(args.workspaceId);
        if (set === undefined) { set = new Set(); this.#threads.set(args.workspaceId, set); }
        set.add(t);
        return t;
    }

    closeRun(workspaceId: number, t: unknown): void { this.#threads.get(workspaceId)?.delete(t as Thread); }

    // Emit extra events + RUN_FINISHED through the workspace's CURRENT thread binding —
    // an action that paused on a proposal completes AFTER the resume run rebound the
    // stream, so its result must ride whichever response is live now, never the
    // closure of the request that spawned it.
    finishRun(workspaceId: number, events: AguiEvent[]): void {
        for (const t of this.#threads.get(workspaceId) ?? []) {
            if (t.openStreams.size > 0) { t.deferredFinish = events; continue; } // defer past live streams (event-driven, no timer)
            t.emit([...events, { type: "RUN_FINISHED", threadId: t.threadId, runId: t.inputRunId }]);
        }
    }



    // Drive a prompt through the loop (fire-and-forget — the outcome streams via the
    // subscription as loop/terminated). Re-surface any pending stopped-world first.
    async run(args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: { auto?: boolean } }): Promise<{ loopId: number }> {
        const pending = await this.#hitl.resurface(args.workspaceId);
        this.#fan(args.workspaceId, pending);
        const ack = await this.#seam.runLoop(args);
        return { loopId: ack.loopId };
    }

    cancel(workerId: number): boolean { return this.#seam.cancelDrain(workerId); }

    // A resume worker's tool-result → resolveProposal (true if it resolved a proposal).
    resolve(message: ToolResultMessage): boolean { return this.#hitl.resolve(message); }
}
