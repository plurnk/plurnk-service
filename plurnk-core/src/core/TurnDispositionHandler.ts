import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import TerminalResult from "./TerminalResult.ts";
import type { DispatchResult } from "./Dispatcher.ts";

export interface PacketBoundaries {
    operations: Array<{ op: string; tx: string | null }>;
    streamTerminations: Array<{ closeStatus: number }>;
    childTerminations: boolean;
}

export interface CompletionEvidence {
    pending: Array<"streams" | "workers" | "receipts" | "failed-stream-results" | "worker-results">;
    receipts: string[];
}

type TurnContext = { workerId: number; loopId: number; turnId: number; origin: WriterTier };

export default class TurnDispositionHandler {
    readonly #db: Db;
    readonly #lifecycle: LoopLifecycle;
    readonly #unobservedFailureCount: (turnId: number) => Promise<number>;
    readonly #pendingSet: (workerId: number, turnId: number, loopId: number) => Promise<CompletionEvidence>;
    readonly #hasLiveWork: (loopId: number) => Promise<boolean>;

    constructor({ db, lifecycle, unobservedFailureCount, pendingSet, hasLiveWork }: {
        db: Db;
        lifecycle: LoopLifecycle;
        unobservedFailureCount: (turnId: number) => Promise<number>;
        pendingSet: (workerId: number, turnId: number, loopId: number) => Promise<CompletionEvidence>;
        hasLiveWork: (loopId: number) => Promise<boolean>;
    }) {
        this.#db = db;
        this.#lifecycle = lifecycle;
        this.#unobservedFailureCount = unobservedFailureCount;
        this.#pendingSet = pendingSet;
        this.#hasLiveWork = hasLiveWork;
    }

    async handle(ctx: TurnContext): Promise<DispatchResult> {
        // {§wait-obligation-matrix}: record intent now; settle the complete program before parking.
        if (await this.#hasLiveWork(ctx.loopId)) return { status: 202, attrs: { waiting: -1 } };
        // A second idle WAIT is the model waiting on a wake nothing can send. "Nothing is in
        // flight" reads as weather; on the repeat the row says what WAIT is for and what to reach
        // for instead, because the refusal is the only surface it is certain to read
        // (operator, 2026-09-22).
        const prior = await this.#db.engine_prior_idle_waits.get<{ count: number }>({ loop_id: ctx.loopId });
        return (prior?.count ?? 0) > 0
            ? { status: 102, detail: "WAIT doesn't wait unless there's a child worker or stream to wait on. Use schedule for specific timing decisions." }
            : { status: 102, detail: "Nothing is in flight. Continuing." };
    }

    async completion(ctx: TurnContext, eligible: boolean, hasAnswer: boolean): Promise<DispatchResult> {
        if (!eligible) return { status: 102, detail: "Completion deferred. Conclude with KILL alone." };
        return this.#assess(ctx, false, true, hasAnswer);
    }

    async settle(ctx: TurnContext, wait: boolean, finalResponse: boolean): Promise<number> {
        const status = await this.#lifecycle.status(ctx.loopId);
        if (![100, 102, 202].includes(status)) return status;
        const decision = await this.#assess(ctx, wait, finalResponse, false);
        if (decision.status === 202) {
            return await this.#lifecycle.park(ctx.loopId, { wakenBy: "obligations" }) ? 202 : this.#lifecycle.status(ctx.loopId);
        }
        if (decision.status !== 200 || ctx.origin !== "model") return decision.status;
        // {§completion-defers-to-messages}: recheck arrivals atomically with conclusion.
        const finished = await this.#lifecycle.finish(ctx.loopId, TerminalResult.success(null), { requireAnswered: true });
        return finished === null ? this.#lifecycle.status(ctx.loopId) : 200;
    }

    async #assess(ctx: TurnContext, wait: boolean, finalResponse: boolean, hasAnswer: boolean): Promise<DispatchResult> {
        const { workerId, loopId, turnId, origin } = ctx;
        const status = await this.#lifecycle.status(loopId);
        if (![100, 102, 202].includes(status)) return { status: 102, detail: "This loop is already concluded." };
        // Administrative programs do not conclude the worker's model loop (including turn0).
        if (origin !== "model") return { status: 200 };
        const arrivals = await this.#db.drain_unpublished_messages_for_loop.all({ loop_id: loopId });
        if (arrivals.length > 0) return { status: 102, detail: "New messages await review." };
        const unanswered = await this.#db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId });
        if (unanswered === undefined) throw new Error("The loop has no message count.");
        const recovery = await this.#unobservedFailureCount(turnId) > 0;
        if (recovery && !wait) return { status: 102, detail: "Review this turn's errors before concluding." };
        if (!wait && !finalResponse) return { status: 102 };
        const { pending } = await this.#pendingSet(workerId, turnId, loopId);
        const live = pending.some((kind) => kind === "streams" || kind === "workers");
        if (live && (wait || finalResponse)) {
            // The obligation itself is the waker: a concluding stream or child requeues this loop.
            return { status: 202, detail: "Completion awaits child workers or streams." };
        }
        if (wait) return { status: 102, detail: "Nothing is in flight. Continuing." };
        if (pending.length > 0 || recovery) return { status: 102, detail: "Results await review before completion." };
        if (unanswered.count > 0 && !hasAnswer) return { status: 102, detail: "Open Messages remain unanswered." };
        return { status: 200 };
    }
}
