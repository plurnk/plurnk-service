import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import TerminalResult from "./TerminalResult.ts";
import Results from "./results.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import type { DispositionStatement } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";

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
    static configuredWaitSeconds(): number {
        return Knob.integer("PLURNK_SERVICE_WAIT_SEC", 1);
    }

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

    async handle(ctx: TurnContext, statement: DispositionStatement): Promise<DispatchResult> {
        // {§wait-obligation-matrix}: record intent now; settle the complete program before parking.
        if (await this.#hasLiveWork(ctx.loopId)) {
            const seconds = statement.seconds ?? TurnDispositionHandler.configuredWaitSeconds();
            return { status: seconds === 0 ? 102 : 202, attrs: { waiting: seconds } };
        }
        return { status: 102, detail: "Nothing is in flight. Continuing." };
    }

    async settle(ctx: TurnContext, waits: readonly DispositionStatement[], completionAllowed: boolean): Promise<DispatchResult> {
        const status = await this.#lifecycle.status(ctx.loopId);
        if (![100, 102, 202].includes(status)) return { status };
        const decision = await this.#assess(ctx, waits.length > 0, completionAllowed);
        if (decision.status === 202) {
            const configured = TurnDispositionHandler.configuredWaitSeconds();
            const seconds = waits.length === 0 ? configured
                : Math.min(...waits.map((statement) => statement.seconds ?? configured));
            if (seconds === 0) return { status: 102 };
            const pollAt = Math.ceil(Date.now() + seconds * 1000);
            return { status: await this.#lifecycle.park(ctx.loopId, { wakenBy: "obligations", pollAt }) ? 202 : await this.#lifecycle.status(ctx.loopId) };
        }
        if (decision.status !== 200 || ctx.origin !== "model") return decision;
        const outcome = await this.#db.message_completion_outcome.get<{ status: 200 | 499 }>({ loop_id: ctx.loopId });
        const result = outcome!.status === 200 ? TerminalResult.success(null)
            : Results.failure("engine:messages", "cancelled", 499, "All messages were cancelled.", {}, { retryable: false });
        // {§completion-defers-to-messages}: recheck arrivals atomically with conclusion.
        const finished = await this.#lifecycle.finish(ctx.loopId, result, { requireObserved: true });
        return { status: finished === null ? await this.#lifecycle.status(ctx.loopId) : result.status };
    }

    async #assess(ctx: TurnContext, wait: boolean, completionAllowed: boolean): Promise<DispatchResult> {
        const { workerId, loopId, turnId, origin } = ctx;
        const status = await this.#lifecycle.status(loopId);
        if (![100, 102, 202].includes(status)) return { status: 102, detail: "This loop is already concluded." };
        // Administrative programs do not conclude the worker's model loop (including turn0).
        if (origin !== "model") return { status: 200 };
        const arrivals = await this.#db.drain_unpublished_messages_for_loop.all({ loop_id: loopId });
        if (arrivals.length > 0) return { status: 102 };
        const recovery = await this.#unobservedFailureCount(turnId) > 0;
        if ((recovery || !completionAllowed) && !wait) return { status: 102 };
        const { pending } = await this.#pendingSet(workerId, turnId, loopId);
        const live = pending.some((kind) => kind === "streams" || kind === "workers");
        if (live && wait) {
            // The obligation itself is the waker: a concluding stream or child requeues this loop.
            return { status: 202 };
        }
        if (recovery || !completionAllowed) return { status: 102 };
        const unresolved = await this.#db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId });
        if (unresolved!.count > 0) return { status: 102 };
        if (pending.some((kind) => kind !== "streams" && kind !== "workers")) return {
            status: 102, detail: "All Open Messages resolved. Review new results; emit no OPs if finished.",
        };
        if (live) return { status: 202 };
        return { status: 200 };
    }
}
