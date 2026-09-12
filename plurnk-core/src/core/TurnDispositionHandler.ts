import { TurnDisposition, type DispositionStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import { type CancelDescendantsNotify } from "./ChannelWrite.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import TerminalResult from "./TerminalResult.ts";
import Results from "./results.ts";
import ErrorDetail from "./ErrorDetail.ts";
import { promptLoopPrefix } from "./plurnk-uri.ts";
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

export default class TurnDispositionHandler {
    // {§engine-rails} review contract: only a refused completion (turntrieval steer) is a
    // strike. Every other TASK 409 — an empty inventory, an already-terminal loop — is a
    // soft receipt the model answers on the next turn.
    static refusedCompletion(result: DispatchResult): boolean {
        return result.status === 409 && (result.problem as { stage?: unknown } | undefined)?.stage === "completion";
    }

    readonly #db: Db;
    readonly #cancelDescendants: CancelDescendantsNotify | undefined;
    readonly #lifecycle: LoopLifecycle;
    readonly #nextPacketBoundaries: (workerId: number, turnId: number) => Promise<PacketBoundaries>;
    readonly #unobservedFailureCount: (turnId: number) => Promise<number>;
    readonly #pendingSet: (workerId: number, turnId: number) => Promise<CompletionEvidence>;
    readonly #hasLiveWork: (workerId: number) => Promise<boolean>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    readonly #statusResult: (status: number, code: string, detail: string, fields?: Readonly<Record<string, unknown>>) => DispatchResult;
    readonly #unobservedFailures: (failCount: number) => DispatchResult;

    constructor({ db, cancelDescendants, lifecycle, nextPacketBoundaries, unobservedFailureCount, pendingSet, hasLiveWork, failure, statusResult, unobservedFailures }: {
        db: Db;
        cancelDescendants: CancelDescendantsNotify | undefined;
        lifecycle: LoopLifecycle;
        nextPacketBoundaries: (workerId: number, turnId: number) => Promise<PacketBoundaries>;
        unobservedFailureCount: (turnId: number) => Promise<number>;
        pendingSet: (workerId: number, turnId: number) => Promise<CompletionEvidence>;
        hasLiveWork: (workerId: number) => Promise<boolean>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
        statusResult: (status: number, code: string, detail: string, fields?: Readonly<Record<string, unknown>>) => DispatchResult;
        unobservedFailures: (failCount: number) => DispatchResult;
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
        this.#unobservedFailures = unobservedFailures;
    }

    async handle(statement: DispositionStatement, ctx: {
        workspaceId: number;
        workerId: number;
        loopId: number;
        turnId: number;
        sequence: number;
        origin: WriterTier;
        allowUnobservedRetrievalCompletion?: boolean;
    }): Promise<DispatchResult> {
        const { workerId, loopId, turnId } = ctx;
        const intent = TurnDisposition.intent(statement.body);
        const status = TurnDisposition.status(statement);
        const timingDetail = intent !== "wait" && statement.lineMarker !== null
            ? "Wait timing was not applied because no waiting intent was selected." : null;
        const withTimingDetail = (result: DispatchResult): DispatchResult => timingDetail === null
            ? result : { ...result, detail: [result.detail, timingDetail].filter(Boolean).join(" ") };
        if (intent === "missing") {
            return withTimingDetail(this.#failure("task-inventory-missing", 409,
                "No tasks were supplied. Submit a nonempty TASK inventory."));
        }
        if (intent === "continue" || intent === "pending") {
            return withTimingDetail({ status: 102, ...(intent === "pending"
                ? { detail: "Pending tasks remain. Review their dependencies." } : {}) });
        }

        // {§worker-wait-timing}: explicit timing is an obligation in its own
        // right; otherwise {§wait-obligation-matrix} decides an untimed join.
        if (intent === "wait") {
            const marks = statement.lineMarker?.marks;
            const timeout = marks?.[0] ?? -1;
            const poll = marks?.[1];
            if ((marks?.length ?? 0) > 2 || timeout < -1 || (poll !== undefined && poll < 0)
                || [timeout, poll].some((value) => value !== undefined
                    && (!Number.isSafeInteger(value) || value * 60_000 + Date.now() > 8.64e15))) {
                return this.#failure("wait-timing-invalid", 400,
                    "TASK wait timing accepts <timeout[,poll]> in whole minutes: timeout is -1 or nonnegative; poll is nonnegative.");
            }
            const seconds = timeout < 0 ? -1 : timeout * 60;
            const timing = {
                ...(timeout < 0 ? {} : { timeoutMs: timeout * 60_000 }),
                ...(poll === undefined ? {} : { pollMs: poll * 60_000 }),
            };
            if (timeout >= 0 || (poll ?? 0) > 0 || await this.#hasLiveWork(workerId)) {
                if (!await this.#lifecycle.park(loopId, timing)) {
                    return this.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when TASK attempted to wait.");
                }
                return { status: 202, attrs: { waiting: seconds, ...(poll === undefined ? {} : { polling: poll * 60 }) } };
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
            return { status: 102, detail: "Nothing is in flight and no timed or polled wait is set. Continuing." };
        }

        // [200] — terminate, gated by the pending set (post-batch). The row records the refused
        // attempt faithfully (status_rx=409, never erased); the loop stays a continue; the strike
        // couples in runTurn. [499] abandons and cancels the descendant scope.
        if (status === 200) {
            // Model completion is a claim about the Worker's observed work and
            // therefore crosses the pending-result rails. A `_plurnk`
            // maintenance program closes only its own administrative loop; it
            // must not claim, consume, or be blocked by model work elsewhere in
            // the same Worker.
            if (ctx.origin === "model") {
                // {§completion-defers-to-prompts} — a prompt that arrived during this turn is
                // published by the next packet; completing over it would answer a conversation
                // the model has not seen. Not the model's fault, so a deferral, never a strike.
                const undelivered = await this.#undeliveredPromptCount(workerId, loopId);
                if (undelivered > 0) {
                    return withTimingDetail({
                        status: 102,
                        detail: `Completion deferred: ${undelivered} new prompt${undelivered === 1 ? "" : "s"} arrived during this turn. `
                            + `${undelivered === 1 ? "It is" : "They are"} in this packet; a response and a TASK now complete.`,
                    });
                }
                // {§send-premature-terminate} — same-turn failures are unobserved
                // pending results and therefore refuse completion.
                const failCount = await this.#unobservedFailureCount(turnId);
                if (failCount > 0) return withTimingDetail(this.#unobservedFailures(failCount));
                const { pending, receipts } = await this.#pendingSet(workerId, turnId);
                const receiptsOnly = pending.length > 0 && pending.every((kind) => kind === "receipts");
                if (pending.length > 0 && !(receiptsOnly && ctx.allowUnobservedRetrievalCompletion)) {
                    // {§send-premature-terminate} — the receipt is read one packet later,
                    // beside the results it names, so it speaks from that moment: what
                    // deferred completion is now in the packet, and the same TASK is the
                    // correct next request (retryable), never an action to "observe".
                    if (receiptsOnly) {
                        return withTimingDetail(this.#failure(
                            "retrieval-results-unobserved",
                            409,
                            TurnDispositionHandler.deferredReceiptsDetail(receipts),
                            {},
                            {
                                pending: [...pending],
                                stage: "completion",
                                retryable: true,
                            },
                        ));
                    }
                    return withTimingDetail(this.#failure(
                        "work-remains",
                        409,
                        TurnDispositionHandler.deferredWorkDetail(pending),
                        {},
                        {
                            pending: [...pending],
                            stage: "completion",
                            retryable: true,
                        },
                    ));
                }
            }
            const finished = await this.#lifecycle.finish(
                loopId,
                TerminalResult.success(null),
            );
            return withTimingDetail(this.#statusResult(
                finished !== null ? 200 : await this.#lifecycle.status(loopId),
                "loop-already-terminal",
                "The loop was already terminal when TASK attempted to conclude it.",
            ));
        }
        if (status === 499) {
            const reason = ErrorDetail.preview(statement.body.filter(({ status: state }) => state === "failed").map(({ content }) => content).join("\n"));
            const failure = withTimingDetail(this.#failure(
                "scope-abandoned",
                499,
                "All tasks in the final inventory failed.",
                {},
                {
                    ...(reason.length === 0 ? {} : { reason }),
                    retryable: false,
                },
            ));
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

    // {§completion-defers-to-prompts} Prompt frames this loop contains but has not published
    // (the same rows the next turn boundary publishes, {§prompt-loop-containment}).
    async #undeliveredPromptCount(workerId: number, loopId: number): Promise<number> {
        const loopSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId }))?.sequence ?? loopId;
        const prefix = promptLoopPrefix(loopSeq);
        const rows = await this.#db.drain_undelivered_prompts_for_loop.all<{ content: string }>({
            worker_id: workerId, pattern: `${prefix}%`, prefix_len: prefix.length, loop_id: loopId,
        });
        return rows.filter((row) => typeof row.content === "string" && row.content.length > 0).length;
    }

    // {§send-premature-terminate} Receipts-only deferral, worded at read time.
    static deferredReceiptsDetail(receipts: readonly string[]): string {
        const plural = receipts.length > 1;
        return `Completion deferred until ${ErrorDetail.preview(receipts.join(", "))} reached a packet. ${plural ? "They are" : "It is"} in this packet; a TASK now completes.`;
    }

    // {§send-premature-terminate} Live obligations name the wait; observed-now results name the packet.
    static deferredWorkDetail(pending: readonly string[]): string {
        const live: string[] = [];
        if (pending.includes("workers")) live.push("child workers are still running");
        if (pending.includes("streams")) live.push("an execution is still running");
        const landed: string[] = [];
        if (pending.includes("worker-results")) landed.push("a child worker's result");
        if (pending.includes("failed-stream-results")) landed.push("a failed execution result");
        if (pending.includes("receipts")) landed.push("operation receipts");
        const sentences: string[] = [];
        if (live.length > 0) {
            sentences.push(`Completion deferred: ${live.join(" and ")}. A TASK with a pending task waits for ${live.length > 1 || pending.includes("workers") ? "them" : "it"}${pending.includes("streams") ? ", or KILL ends the execution" : ""}.`);
            if (landed.length > 0) sentences.push(`${landed.join(" and ")} ${landed.length > 1 ? "are" : "is"} in this packet.`);
        } else {
            sentences.push(`Completion deferred until ${landed.join(" and ")} reached a packet. ${landed.length > 1 ? "They are" : "It is"} in this packet; a TASK now completes.`);
        }
        return sentences.join(" ");
    }

}
