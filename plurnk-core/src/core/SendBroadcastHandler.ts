// SEND broadcast dispatch: the terminal send that parks, joins, or wakes the loop, split out of Dispatcher.
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import { type CancelDescendantsNotify } from "./ChannelWrite.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import TerminalResult from "./TerminalResult.ts";
import Results from "./results.ts";
import ErrorDetail from "./ErrorDetail.ts";
import type { DispatchResult } from "./Dispatcher.ts";

export default class SendBroadcastHandler {
    readonly #db: Db;
    readonly #cancelDescendants: CancelDescendantsNotify | undefined;
    readonly #parkDeadlines: Map<number, number>;
    readonly #joinTargets: Set<number>;
    readonly #lifecycle: LoopLifecycle;
    readonly #nextPacketBoundaries: (workerId: number, turnId: number) => Promise<{ retrievals: boolean; folds: boolean; streamTerminations: Array<{ handle: string; closeStatus: number }>; childTerminations: boolean; }>;
    readonly #unobservedFailureCount: (turnId: number) => Promise<number>;
    readonly #pendingSet: (workerId: number, turnId: number) => Promise<Array<"streams" | "workers" | "receipts" | "failed-stream-results" | "worker-results">>;
    readonly #hasLiveWork: (workerId: number) => Promise<boolean>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    readonly #statusResult: (status: number, code: string, detail: string, fields?: Readonly<Record<string, unknown>>) => DispatchResult;
    readonly #unobservedFailures: (failCount: number) => DispatchResult;

    constructor({ db, cancelDescendants, parkDeadlines, joinTargets, lifecycle, nextPacketBoundaries, unobservedFailureCount, pendingSet, hasLiveWork, failure, statusResult, unobservedFailures }: {
        db: Db;
        cancelDescendants: CancelDescendantsNotify | undefined;
        parkDeadlines: Map<number, number>;
        joinTargets: Set<number>;
        lifecycle: LoopLifecycle;
        nextPacketBoundaries: (workerId: number, turnId: number) => Promise<{ retrievals: boolean; folds: boolean; streamTerminations: Array<{ handle: string; closeStatus: number }>; childTerminations: boolean; }>;
        unobservedFailureCount: (turnId: number) => Promise<number>;
        pendingSet: (workerId: number, turnId: number) => Promise<Array<"streams" | "workers" | "receipts" | "failed-stream-results" | "worker-results">>;
        hasLiveWork: (workerId: number) => Promise<boolean>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
        statusResult: (status: number, code: string, detail: string, fields?: Readonly<Record<string, unknown>>) => DispatchResult;
        unobservedFailures: (failCount: number) => DispatchResult;
    }) {
        this.#db = db;
        this.#cancelDescendants = cancelDescendants;
        this.#parkDeadlines = parkDeadlines;
        this.#joinTargets = joinTargets;
        this.#lifecycle = lifecycle;
        this.#nextPacketBoundaries = nextPacketBoundaries;
        this.#unobservedFailureCount = unobservedFailureCount;
        this.#pendingSet = pendingSet;
        this.#hasLiveWork = hasLiveWork;
        this.#failure = failure;
        this.#statusResult = statusResult;
        this.#unobservedFailures = unobservedFailures;
    }

    async handleSendBroadcast(statement: PlurnkStatement, ctx: {
        workspaceId: number;
        workerId: number;
        loopId: number;
        turnId: number;
        sequence: number;
        origin: WriterTier;
    }): Promise<DispatchResult> {
        if (statement.op !== "SEND") throw new Error("unreachable");
        const { workerId, loopId, turnId } = ctx;
        const status = statement.signal;
        if (status === null) {
            return this.#failure(
                "send-status-required",
                400,
                "SEND requires a numeric status.",
                {},
                { retryable: false },
            );
        }
        const raw = statement.body === null ? "" : statement.body.raw;

        // The park rides SEND signal 202 only ({§park-202-only}). A scoped signal 102 is neither
        // a wait nor a meaningful continuation, so reject it instead of preserving the
        // retired dual spelling.
        if (status === 102 && statement.lineMarker !== null) {
            return this.#failure(
                "send-scope-invalid",
                400,
                "`## SEND0 [102]` does not accept a scope.",
                {},
                {
                    requestedStatus: 102,
                    scope: statement.lineMarker,
                    recovery: "Use `## SEND0 [202] <scope>` to wait, or remove the scope to continue.",
                    retryable: false,
                },
            );
        }

        // A bare continue after an armed running-worker READ becomes an
        // indefinite park. {§join-blocking-collect}
        const joinArmed = this.#joinTargets.delete(loopId);
        if (status === 102 && statement.lineMarker === null && joinArmed) {
            if (!await this.#lifecycle.park(loopId)) {
                return this.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to park it.");
            }
            this.#parkDeadlines.set(loopId, -1); // indefinite: the bounded child's terminal is the wake edge
            return { status: 102, attrs: { parked: -1, join: true } };
        }

        // {§wait-obligation-matrix} — SEND signal 202 is the obligation-checked join. A live
        // obligation (a spawned child or open stream, J) BLOCKS the loop until it concludes and
        // reawakens it ({§worker-lifecycle-child-wake}); a wait on nothing (∅) is already satisfied and
        // resolves like 200, so <-1>+∅ self-resolves rather than hang the agent; a pending own
        // retrieval (R) just lands next turn, so the wait continues.
        if (status === 202) {
            const marks = statement.lineMarker?.marks[0];
            // `<T>` is MINUTES, held in seconds; bare 202 / absent T = indefinite, bounded by the join.
            const seconds = typeof marks === "number" ? (marks > 0 ? marks * 60 : marks) : -1;
            if (await this.#hasLiveWork(workerId)) {
                if (!await this.#lifecycle.park(loopId)) {
                    return this.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to wait.");
                }
                this.#parkDeadlines.set(loopId, seconds);
                return { status: 202, attrs: { waiting: seconds } };
            }
            // Retrievals, fast stream conclusions, and child conclusions are
            // all complete-but-unobserved. Their wake edge may already have
            // fired, so do not park; continue directly to the packet that
            // materializes them.
            const boundaries = await this.#nextPacketBoundaries(workerId, turnId);
            if (boundaries.retrievals || boundaries.folds || boundaries.streamTerminations.length > 0 || boundaries.childTerminations) {
                return { status: 102 };
            }
            const failCount = await this.#unobservedFailureCount(turnId);
            if (failCount > 0) return this.#unobservedFailures(failCount);
            // The joined set is already drained. Awaiting an empty task group completes
            // immediately; it never parks and needs no corrective model turn.
            const finished = await this.#lifecycle.finish(
                loopId,
                TerminalResult.success(raw),
            );
            return {
                status: finished !== null ? 200 : await this.#lifecycle.status(loopId),
                attrs: { joined: true, pending: 0 },
            };
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
                // {§send-premature-terminate} — same-turn failures are unobserved
                // pending results and therefore refuse completion.
                const failCount = await this.#unobservedFailureCount(turnId);
                if (failCount > 0) return this.#unobservedFailures(failCount);
                const pending = await this.#pendingSet(workerId, turnId);
                if (pending.length > 0) {
                    // A receipts-only refusal needs no KILL/park remedy menu: the results simply
                    // arrive in the next packet. Streams and children retain their remedy steer.
                    const receiptsOnly = pending.every((kind) => kind === "receipts");
                    if (receiptsOnly) {
                        return this.#failure(
                            "retrieval-results-unobserved",
                            409,
                            "Completion preceded this turn's operation results; they enter the next packet.",
                            {},
                            {
                                pending: [...pending],
                                stage: "completion",
                                retryable: false,
                            },
                        );
                    }
                    return this.#failure(
                        "work-remains",
                        409,
                        "Completion encountered pending work or results.",
                        {},
                        {
                            pending: [...pending],
                            stage: "completion",
                            retryable: false,
                        },
                    );
                }
            }
            const finished = await this.#lifecycle.finish(
                loopId,
                TerminalResult.success(raw),
            );
            return this.#statusResult(
                finished !== null ? 200 : await this.#lifecycle.status(loopId),
                "loop-already-terminal",
                "The loop was already terminal when SEND attempted to conclude it.",
            );
        }
        if (status === 499) {
            const reason = raw === "" ? null : ErrorDetail.preview(raw);
            const failure = this.#failure(
                "scope-abandoned",
                499,
                "The worker ended its scope with SEND[499].",
                {},
                {
                    ...(reason === null ? {} : { reason }),
                    retryable: false,
                },
            );
            const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                loop_id: loopId,
                turn_id: turnId,
            });
            if (seqs === undefined) {
                throw new Error(`SEND signal 499: no coordinate for loop=${loopId} turn=${turnId}`);
            }
            Results.attachInstance(
                failure,
                `log:///${seqs.loop_seq}/${seqs.turn_seq}/${ctx.sequence}/SEND`,
            );
            const finished = await this.#lifecycle.finish(loopId, failure);
            if (finished === null) return this.#statusResult(await this.#lifecycle.status(loopId), "loop-already-terminal", "The loop was already terminal when SEND attempted to abandon it.");
            await this.#cancelDescendants?.(workerId, reason ?? "parent worker ended its scope with SEND[499]");
            return failure;
        }
        // Every other signal — 102 bare, 202 (retired as a terminal; now ordinary mid-comms), 1xx —
        // is a plain broadcast row: no loop transition.
        return this.#statusResult(
            status,
            "send-broadcast-failed",
            raw === "" ? `SEND broadcast reported status ${status}.` : raw,
        );
    }

}
