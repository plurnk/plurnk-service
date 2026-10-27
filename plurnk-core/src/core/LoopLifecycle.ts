import type { Db } from "./Db.ts";
import Results, { type SchemeResult } from "./results.ts";
import ErrorDetail from "./ErrorDetail.ts";
import SessionOwners from "./SessionOwners.ts";

interface CancelledLoop {
    loopId: number;
    sessionId: number;
    result: SchemeResult;
}

export interface CancelledTree {
    sessionIds: number[];
    loops: CancelledLoop[];
}

export interface ParkedLoop {
    id: number;
    wait_revision: number;
    wait_poll_at: number | null;
}

export default class LoopLifecycle {
    #db: Db;
    #executions = new Map<number, { sessionId: number; stop: () => number }>();

    constructor(db: Db) {
        this.#db = db;
    }

    // `loops.status` is the compact scheduler state inherited by the schema;
    // terminal_result is the lossless product result. Preserve the established
    // terminal classes relationally while retaining an exact uncommon status
    // (for example a provider 502) in terminal_result.
    static projectStatus(status: number): number {
        if (status === 202) {
            throw new TypeError("loop terminal result cannot be 202; 202 is the parked lifecycle state");
        }
        if ([200, 413, 429, 499, 500, 504, 508].includes(status)) return status;
        if (status >= 200 && status <= 399) return 200;
        if (status >= 400 && status <= 599) return 500;
        throw new TypeError(`loop terminal result must have status 200 through 599; got ${status}`);
    }

    async startExecution(loopId: number, budgetMs: number, onTimeout: () => void): Promise<boolean> {
        if (this.#executions.has(loopId)) return true;
        if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
            throw new TypeError("loop execution allowance must be positive safe integer milliseconds");
        }
        const budget = await this.#db.lifecycle_execution_budget.get<{
            session_id: number; execution_budget_ms: number; execution_elapsed_ms: number;
        }>({ loop_id: loopId, budget_ms: budgetMs });
        if (budget === undefined) return false;
        const started = performance.now();
        const elapsed = (): number => budget.execution_elapsed_ms + performance.now() - started;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = (): void => {
            const remaining = budget.execution_budget_ms - elapsed();
            if (remaining <= 0) onTimeout();
            else timer = setTimeout(arm, Math.min(2_147_483_647, Math.ceil(remaining))).unref();
        };
        this.#executions.set(loopId, {
            sessionId: budget.session_id,
            stop: () => {
                clearTimeout(timer);
                return elapsed();
            },
        });
        arm();
        return true;
    }

    #stopExecution(loopId: number): number | null {
        const execution = this.#executions.get(loopId);
        if (execution === undefined) return null;
        this.#executions.delete(loopId);
        return execution.stop();
    }

    async endExecution(loopId: number): Promise<void> {
        const elapsed = this.#stopExecution(loopId);
        if (elapsed !== null) {
            await this.#db.lifecycle_checkpoint_execution.run({ loop_id: loopId, elapsed_ms: elapsed });
        }
    }

    // {§session-ownership} A provider park without another waker requires an interactive owner.
    async park(loopId: number, { wakenBy, pollAt }: { wakenBy: string | null; pollAt?: number }): Promise<boolean> {
        if (wakenBy === null && !await SessionOwners.interactive(this.#db, loopId)) {
            throw new Error(`loop ${loopId} cannot park without a waker or an interactive owner; conclude instead`);
        }
        return (await this.#db.lifecycle_park_loop.get<{ id: number }>({
            loop_id: loopId,
            elapsed_ms: this.#stopExecution(loopId),
            poll_at: pollAt ?? null,
        })) !== undefined;
    }

    async wake(loopId: number, condition: { revision?: number; dueAt?: number; eventOnly?: boolean } = {}): Promise<boolean> {
        return (await this.#db.lifecycle_wake_loop.get<{ id: number }>({
            loop_id: loopId,
            revision: condition.revision ?? null,
            due_at: condition.dueAt ?? null,
            event_only: condition.eventOnly === true ? 1 : 0,
        })) !== undefined;
    }

    parked(sessionId: number): Promise<ParkedLoop[]> {
        return this.#db.lifecycle_parked_loops.all<ParkedLoop>({ session_id: sessionId });
    }

    async finish(
        loopId: number,
        result: SchemeResult,
        options: { terminatedBy?: "cancel" | null; requireObserved?: boolean } = {},
    ): Promise<SchemeResult | null> {
        const exact = structuredClone(Results.assert(result));
        if (exact.problem !== undefined && exact.problem.instance === undefined) {
            Results.attachInstance(exact, await LoopLifecycle.address(this.#db, loopId));
        }
        const status = LoopLifecycle.projectStatus(exact.status);
        const row = await this.#db.lifecycle_finish_loop.get<{ terminal_result: string }>({
            loop_id: loopId,
            elapsed_ms: null,
            status,
            result: JSON.stringify(exact),
            terminated_by: options.terminatedBy ?? null,
            require_observed: options.requireObserved === true ? 1 : 0,
        });
        if (row === undefined) return null;
        await this.endExecution(loopId);
        return Results.fromRow(row.terminal_result);
    }

    static async address(db: Db, loopId: number): Promise<string> {
        const row = await db.loop_resource_identity.get<{ resource: string }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loop ${loopId} does not exist`);
        return row.resource;
    }

    async status(loopId: number): Promise<number> {
        const row = await this.#db.lifecycle_loop_status.get<{ status: number; terminal_result: string | null }>({
            loop_id: loopId,
        });
        if (row === undefined) throw new Error(`loop ${loopId} does not exist`);
        return row.status;
    }

    async result(loopId: number): Promise<SchemeResult | null> {
        const row = await this.#db.lifecycle_loop_status.get<{ status: number; terminal_result: string | null }>({
            loop_id: loopId,
        });
        if (row === undefined) throw new Error(`loop ${loopId} does not exist`);
        return row.terminal_result === null
            ? null
            : Results.fromRow(row.terminal_result);
    }

    // {§session-causal-admission} Whether the loop's terminal is a cancellation's.
    async cancelled(loopId: number): Promise<boolean> {
        const row = await this.#db.lifecycle_loop_status.get<{ terminated_by: string | null }>({
            loop_id: loopId,
        });
        if (row === undefined) throw new Error(`loop ${loopId} does not exist`);
        return row.terminated_by === "cancel";
    }

    // {§operation-results} {§notifications} — Unix milliseconds, as the status gauge carries them.
    async observation(loopId: number): Promise<{ loopSeq: number; claimedAt: number | null; terminatedAt: number | null; packetCount: number }> {
        const row = await this.#db.lifecycle_loop_observation.get<{ loopSeq: number; claimedAt: string | null; terminatedAt: string | null; packetCount: number }>({
            loop_id: loopId,
        });
        if (row === undefined) throw new Error(`loop ${loopId} does not exist`);
        return {
            loopSeq: row.loopSeq,
            claimedAt: row.claimedAt === null ? null : Date.parse(row.claimedAt),
            terminatedAt: row.terminatedAt === null ? null : Date.parse(row.terminatedAt),
            packetCount: row.packetCount,
        };
    }

    async turnIds(loopId: number): Promise<number[]> {
        const rows = await this.#db.lifecycle_loop_turns.all<{ id: number }>({
            loop_id: loopId,
        });
        return rows.map(({ id }) => id);
    }

    async modelTurnCount(loopId: number): Promise<number> {
        const row = await this.#db.lifecycle_loop_model_turn_count.get<{ count: number }>({
            loop_id: loopId,
        });
        if (row === undefined) throw new Error(`loop ${loopId} model-turn count is unavailable`);
        return row.count;
    }

    // {§operator-config-workspace-settings} — the ceiling and the model calls already spent against it, tree-wide.
    async treeBudget(loopId: number): Promise<{ rootLoopId: number; maxTurns: number; count: number }> {
        const row = await this.#db.lifecycle_tree_budget.get<{ root_loop_id: number | null; max_turns: number | null; count: number }>({
            loop_id: loopId,
        });
        if (row === undefined || row.root_loop_id === null || row.max_turns === null) {
            throw new Error(`loop ${loopId} has no root loop to own its turn ceiling`);
        }
        return { rootLoopId: row.root_loop_id, maxTurns: row.max_turns, count: row.count };
    }

    async cancelTree(sessionId: number, reason: string, includeRoot: boolean): Promise<CancelledTree> {
        const boundedReason = ErrorDetail.preview(reason) || "no reason was supplied";
        const params = {
            session_id: sessionId,
            include_root: includeRoot ? 1 : 0,
        };
        const sessions = await this.#db.lifecycle_session_tree.all<{ session_id: number; cancelled_through_sequence: number }>({
            session_id: params.session_id,
            include_root: params.include_root,
        });
        const cancellation = Results.failure(
            "lifecycle:cancel",
            "scope-cancelled",
            499,
            `The session scope was cancelled: ${boundedReason}.`,
            {},
            {
                reason: boundedReason,
                stage: "loop",
                retryable: false,
            },
        );
        const sessionIds = new Set(sessions.map(({ session_id }) => session_id));
        const session_ids = JSON.stringify([...sessionIds]);
        const executions = [...this.#executions].flatMap(([loopId, execution]) =>
            sessionIds.has(execution.sessionId)
                ? [{ loop_id: loopId, elapsed_ms: this.#stopExecution(loopId) }]
                : []);
        if (executions.length > 0) await this.#db.lifecycle_checkpoint_executions.run({ executions: JSON.stringify(executions) });
        // {§session-causal-admission} — one bound statement; the trigger retires the live loops inside it.
        await this.#db.lifecycle_cancel_sessions.run({ session_ids, result: JSON.stringify(cancellation) });
        const loops = await this.#db.lifecycle_cancelled_loops.all<{
            loop_id: number;
            session_id: number;
            terminal_result: string;
        }>({ session_cutoffs: JSON.stringify(sessions) });
        return {
            sessionIds: sessions.map(({ session_id }) => session_id),
            loops: loops.map(({ loop_id, session_id, terminal_result }) => ({
                loopId: loop_id,
                sessionId: session_id,
                result: Results.fromRow(terminal_result),
            })),
        };
    }
}
