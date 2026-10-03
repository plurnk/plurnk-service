import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import TerminalResult from "./TerminalResult.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import type { DispositionStatement } from "@plurnk/plurnk-contracts";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";

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
        const retired = { PLURNK_SERVICE_EXEC_POLL_SEC: true, PLURNK_SERVICE_EXEC_POLL_TURNS: true };
        for (const key of Object.keys(retired)) {
            if (process.env[key]) {
                throw new ConfigurationError(key, `${key} is retired: use PLURNK_SERVICE_WAIT_SEC for the maximum park duration.`);
            }
        }
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
            const seconds = statement.lineMarker?.marks[0] ?? TurnDispositionHandler.configuredWaitSeconds();
            return { status: seconds === 0 ? 102 : 202, attrs: { waiting: seconds } };
        }
        return { status: 102, detail: "Nothing is in flight. Continuing." };
    }

    async completion(ctx: TurnContext, eligible: boolean): Promise<DispatchResult> {
        if (!eligible) return { status: 102, detail: "Completion deferred. Conclude with KILL alone." };
        return this.#assess(ctx, false, true);
    }

    async settle(ctx: TurnContext, waits: readonly DispositionStatement[], finalResponse: boolean): Promise<number> {
        const status = await this.#lifecycle.status(ctx.loopId);
        if (![100, 102, 202].includes(status)) return status;
        const decision = await this.#assess(ctx, waits.length > 0, finalResponse);
        if (decision.status === 202) {
            const configured = TurnDispositionHandler.configuredWaitSeconds();
            const seconds = waits.length === 0 ? configured
                : Math.min(...waits.map((statement) => statement.lineMarker?.marks[0] ?? configured));
            if (seconds === 0) return 102;
            const pollAt = Math.ceil(Date.now() + seconds * 1000);
            return await this.#lifecycle.park(ctx.loopId, { wakenBy: "obligations", pollAt }) ? 202 : this.#lifecycle.status(ctx.loopId);
        }
        if (decision.status !== 200 || ctx.origin !== "model") return decision.status;
        // {§completion-defers-to-messages}: recheck arrivals atomically with conclusion.
        const finished = await this.#lifecycle.finish(ctx.loopId, TerminalResult.success(null), { requireObserved: true });
        return finished === null ? this.#lifecycle.status(ctx.loopId) : 200;
    }

    async #assess(ctx: TurnContext, wait: boolean, finalResponse: boolean): Promise<DispatchResult> {
        const { workerId, loopId, turnId, origin } = ctx;
        const status = await this.#lifecycle.status(loopId);
        if (![100, 102, 202].includes(status)) return { status: 102, detail: "This loop is already concluded." };
        // Administrative programs do not conclude the worker's model loop (including turn0).
        if (origin !== "model") return { status: 200 };
        const arrivals = await this.#db.drain_unpublished_messages_for_loop.all({ loop_id: loopId });
        if (arrivals.length > 0) return { status: 102, detail: "New messages await review." };
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
        return { status: 200 };
    }
}
