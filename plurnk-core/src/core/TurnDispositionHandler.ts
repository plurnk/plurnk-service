import { TurnDisposition, type DispositionStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import { type CancelDescendantsNotify } from "./ChannelWrite.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import TerminalResult from "./TerminalResult.ts";
import Results from "./results.ts";
import ErrorDetail from "./ErrorDetail.ts";
import type { DispatchResult } from "./Dispatcher.ts";

const observedResultsGuidance = "If your final response has already been sent and these results require no further work or response revision, submit only TASK.";

export interface PacketBoundaries {
    operations: Array<{ op: string; tx: string | null }>;
    streamTerminations: Array<{ closeStatus: number }>;
    childTerminations: boolean;
}

export interface CompletionEvidence {
    pending: Array<"streams" | "workers" | "receipts" | "failed-stream-results" | "worker-results">;
    receipts: string[];
}

export default class TurnDispositionHandler {
    readonly #db: Db;
    readonly #cancelDescendants: CancelDescendantsNotify | undefined;
    readonly #lifecycle: LoopLifecycle;
    readonly #nextPacketBoundaries: (workerId: number, turnId: number) => Promise<PacketBoundaries>;
    readonly #unobservedFailureCount: (turnId: number) => Promise<number>;
    readonly #pendingSet: (workerId: number, turnId: number) => Promise<CompletionEvidence>;
    readonly #hasLiveWork: (workerId: number) => Promise<boolean>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    readonly #statusResult: (status: number, code: string, detail: string, fields?: Readonly<Record<string, unknown>>) => DispatchResult;

    constructor({ db, cancelDescendants, lifecycle, nextPacketBoundaries, unobservedFailureCount, pendingSet, hasLiveWork, failure, statusResult }: {
        db: Db;
        cancelDescendants: CancelDescendantsNotify | undefined;
        lifecycle: LoopLifecycle;
        nextPacketBoundaries: (workerId: number, turnId: number) => Promise<PacketBoundaries>;
        unobservedFailureCount: (turnId: number) => Promise<number>;
        pendingSet: (workerId: number, turnId: number) => Promise<CompletionEvidence>;
        hasLiveWork: (workerId: number) => Promise<boolean>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
        statusResult: (status: number, code: string, detail: string, fields?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#db = db;
        this.#cancelDescendants = cancelDescendants;
        this.#lifecycle = lifecycle;
        this.#nextPacketBoundaries = nextPacketBoundaries;
        this.#unobservedFailureCount = unobservedFailureCount;
        this.#pendingSet = pendingSet;
        this.#hasLiveWork = hasLiveWork;
        this.#failure = failure;
        this.#statusResult = statusResult;
    }

    async handle(statement: DispositionStatement, ctx: {
        workspaceId: number;
        workerId: number;
        loopId: number;
        turnId: number;
        sequence: number;
        origin: WriterTier;
    }): Promise<DispatchResult> {
        const { workerId, loopId, turnId } = ctx;
        const intent = TurnDisposition.intent(statement.body);
        const status = TurnDisposition.status(statement);
        // {§send-wait-scope} — TASK takes no scope: a wait joins live work, and a wake later with
        // nothing in flight is a schedule rule.
        if (statement.lineMarker !== null) {
            return this.#failure("scope-unsupported", 400,
                "TASK takes no scope. A waiting inventory joins live work; to wake later with nothing in flight, add a rule with the schedule family.");
        }
        if (intent === "missing") {
            return this.#failure("task-inventory-missing", 409,
                "No tasks were supplied. Submit a nonempty TASK inventory.");
        }
        if (intent === "continue" || intent === "todo") return { status: 102 };

        // {§wait-obligation-matrix} decides a join: live work parks the loop, nothing in flight continues.
        if (intent === "wait") {
            if (await this.#hasLiveWork(workerId)) {
                if (!await this.#lifecycle.park(loopId)) {
                    return this.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when TASK attempted to wait.");
                }
                return { status: 202, attrs: { waiting: -1 } };
            }
            // Retrievals, fast stream conclusions, and child conclusions are
            // all complete-but-unobserved. Their wake edge may already have
            // fired, so do not park; continue directly to the packet that
            // materializes them.
            const boundaries = await this.#nextPacketBoundaries(workerId, turnId);
            if (boundaries.operations.length > 0 || boundaries.streamTerminations.length > 0 || boundaries.childTerminations) {
                return { status: 102 };
            }
            const failCount = await this.#unobservedFailureCount(turnId);
            if (failCount > 0) return { status: 102 };
            return { status: 102, detail: "Nothing is in flight. Continuing." };
        }

        // Both terminals cross the observation barrier ({§completion-defers-to-results}): a
        // model's claim over prompts the loop has not published, failures this turn has not
        // seen, or settled results the next packet carries is deferred one packet and never
        // struck. A completion over live work is the join a scope's exit implies: the loop parks
        // until the work settles ({§completion-joins-live-work}); an abandonment cancels it. A
        // `_plurnk` maintenance program closes only its own administrative loop; it must not
        // claim, consume, or be blocked by model work elsewhere in the same Worker.
        if ((status === 200 || status === 499) && ctx.origin === "model") {
            const deferred = await this.#barrier(ctx, status === 200 ? "Completion" : "Abandonment");
            if (deferred !== null) return deferred;
        }
        // [200] — terminate. A refused attempt is recorded faithfully (status_rx=409, never
        // erased); the loop stays a continue; the strike couples in runTurn. [499] abandons and
        // cancels the descendant scope.
        if (status === 200) {
            const finished = await this.#lifecycle.finish(
                loopId,
                TerminalResult.success(null),
            );
            return this.#statusResult(
                finished !== null ? 200 : await this.#lifecycle.status(loopId),
                "loop-already-terminal",
                "The loop was already terminal when TASK attempted to conclude it.",
            );
        }
        if (status === 499) {
            const reason = ErrorDetail.preview(statement.body.filter(({ status: state }) => state === "failed").map(({ content }) => content).join("\n"));
            const failure = this.#failure(
                "scope-abandoned",
                499,
                "All tasks in the final inventory failed.",
                {},
                {
                    ...(reason.length === 0 ? {} : { reason }),
                    retryable: false,
                },
            );
            const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                loop_id: loopId,
                turn_id: turnId,
            });
            if (seqs === undefined) {
                throw new Error(`TASK: no coordinate for loop=${loopId} turn=${turnId}`);
            }
            Results.attachInstance(
                failure,
                `log:///${seqs.loop_seq}/${seqs.turn_seq}/${ctx.sequence}/TASK`,
            );
            const finished = await this.#lifecycle.finish(loopId, failure);
            if (finished === null) return this.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when TASK attempted to abandon it.");
            await this.#cancelDescendants?.(workerId, reason || "all tasks in the parent inventory failed");
            return failure;
        }
        return { status };
    }

    // {§completion-defers-to-messages} Messages that arrived after the loop began and are not yet
    // published (the next turn boundary publishes them, {§message-loop-containment}).
    async #unpublishedMessageCount(loopId: number): Promise<number> {
        const rows = await this.#db.drain_unpublished_arrivals_for_loop.all<{ id: number }>({ loop_id: loopId });
        return rows.length;
    }

    // {§completion-defers-to-results} — the observation barrier, in the order the graph demands:
    // a prompt the loop has not published; then, for a completion, live work, which parks the
    // loop as a join; then this turn's unseen failures; then the
    // settled results the next packet carries. Every deferral is 102 with the read-time receipt
    // and its pending facts in `attrs`; null means the claim may conclude now.
    async #barrier(
        { workerId, loopId, turnId }: { workerId: number; loopId: number; turnId: number },
        verb: "Completion" | "Abandonment",
    ): Promise<DispatchResult | null> {
        const concludes = verb === "Completion" ? "complete" : "conclude";
        // {§completion-defers-to-messages} — a message that arrived during this turn is published
        // by the next packet; concluding over it would answer a conversation the model has not
        // seen. Not the model's fault, so a deferral, never a strike.
        const undelivered = await this.#unpublishedMessageCount(loopId);
        if (undelivered > 0) {
            return {
                status: 102,
                detail: `${verb} deferred: ${undelivered} new message${undelivered === 1 ? "" : "s"} arrived during this turn. `
                    + `${undelivered === 1 ? "It is" : "They are"} in this packet; a response and a TASK now ${concludes}.`,
            };
        }
        const { pending, receipts } = await this.#pendingSet(workerId, turnId);
        const live = pending.filter((kind) => kind === "streams" || kind === "workers");
        if (verb === "Completion" && live.length > 0) {
            // {§completion-joins-live-work} — a completion over live work is the join a scope's
            // exit implies: the loop parks until the work settles, the wake carries what concluded,
            // and the next TASK decides with it in the packet. Never a strike.
            if (!await this.#lifecycle.park(loopId)) {
                return this.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when TASK attempted to conclude it.");
            }
            return { status: 202, detail: TurnDispositionHandler.joinDetail(live), attrs: { waiting: -1, pending: [...pending] } };
        }
        // A failed operation is also an unobserved result: it does not enter the model's Log
        // until the next packet.
        const failCount = await this.#unobservedFailureCount(turnId);
        if (failCount > 0) {
            return {
                status: 102,
                detail: `${verb} deferred: ${failCount} operation${failCount === 1 ? "" : "s"} failed in the same turn. `
                    + `The failure${failCount === 1 ? " is" : "s are"} in this packet. ${observedResultsGuidance}`,
                attrs: { failures: failCount },
            };
        }
        const settled = pending.filter((kind) => kind !== "streams" && kind !== "workers");
        if (settled.length === 0) return null;
        // The receipt is read one packet later, beside the results it names, so it speaks from
        // that moment. The model decides whether the results change its work or response.
        const detail = settled.every((kind) => kind === "receipts")
            ? TurnDispositionHandler.deferredReceiptsDetail(receipts, verb)
            : TurnDispositionHandler.deferredWorkDetail(settled, verb);
        return { status: 102, detail, attrs: { pending: settled } };
    }

    // {§completion-defers-to-results} Receipts-only deferral, worded at read time.
    static deferredReceiptsDetail(receipts: readonly string[], verb: "Completion" | "Abandonment" = "Completion"): string {
        const plural = receipts.length > 1;
        return `${verb} deferred until ${ErrorDetail.preview(receipts.join(", "))} reached a packet. ${plural ? "They are" : "It is"} in this packet. ${observedResultsGuidance}`;
    }

    // {§completion-joins-live-work} The join receipt, read when the wake lands.
    static joinDetail(live: readonly string[]): string {
        const parts: string[] = [];
        if (live.includes("workers")) parts.push("child workers were still running");
        if (live.includes("streams")) parts.push("an execution was still running");
        return `Completion joined: ${parts.join(" and ")}. The loop waited, and what concluded is in this packet. ${observedResultsGuidance}`;
    }

    // {§completion-defers-to-results} Observed-now results name the packet.
    static deferredWorkDetail(pending: readonly string[], verb: "Completion" | "Abandonment" = "Completion"): string {
        const landed: string[] = [];
        if (pending.includes("worker-results")) landed.push("a child worker's result");
        if (pending.includes("failed-stream-results")) landed.push("a failed execution result");
        if (pending.includes("receipts")) landed.push("operation receipts");
        return `${verb} deferred until ${landed.join(" and ")} reached a packet. ${landed.length > 1 ? "They are" : "It is"} in this packet. ${observedResultsGuidance}`;
    }

}
