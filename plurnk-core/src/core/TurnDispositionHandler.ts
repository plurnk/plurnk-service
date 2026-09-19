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
    pending: Array<"streams" | "workers" | "events" | "event-results" | "receipts" | "failed-stream-results" | "worker-results">;
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
        return await this.#hasLiveWork(ctx.loopId)
            ? { status: 202, attrs: { waiting: -1 } }
            : { status: 102, detail: "Nothing is in flight. Continuing." };
    }

    async settle(ctx: TurnContext, wait: boolean): Promise<number> {
        const { workerId, loopId, turnId, origin } = ctx;
        const status = await this.#lifecycle.status(loopId);
        if (![100, 102, 202].includes(status)) return status;
        // Administrative programs do not conclude the worker's model loop (including turn0).
        if (origin !== "model") return 200;
        const arrivals = await this.#db.drain_unpublished_messages_for_loop.all({ loop_id: loopId });
        if (arrivals.length > 0) return 102;
        const unanswered = await this.#db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId });
        if (unanswered === undefined) throw new Error("The loop has no message count.");
        const { pending } = await this.#pendingSet(workerId, turnId, loopId);
        const live = pending.some((kind) => kind === "streams" || kind === "workers" || kind === "events");
        if (live && (wait || unanswered.count === 0)) {
            // The obligation itself is the waker: a concluding stream, child or event requeues this loop.
            return await this.#lifecycle.park(loopId, { wakenBy: "obligations" }) ? 202 : this.#lifecycle.status(loopId);
        }
        if (wait || unanswered.count > 0 || pending.length > 0 || await this.#unobservedFailureCount(turnId) > 0) return 102;
        // {§completion-defers-to-messages}: recheck unanswered arrivals atomically with conclusion.
        const finished = await this.#lifecycle.finish(loopId, TerminalResult.success(null), { requireAnswered: true });
        return finished === null ? this.#lifecycle.status(loopId) : 200;
    }
}
