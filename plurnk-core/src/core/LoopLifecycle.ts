import type { Db } from "./Db.ts";
import Results, { type SchemeResult } from "./results.ts";
import ErrorDetail from "./ErrorDetail.ts";

interface CancelledLoop {
    loopId: number;
    workerId: number;
    result: SchemeResult;
}

export interface CancelledTree {
    workerIds: number[];
    loops: CancelledLoop[];
}

export interface ParkedLoop {
    id: number;
    wait_revision: number;
    wait_deadline_at: number | null;
    wait_poll_interval: number | null;
    wait_poll_at: number | null;
}

export default class LoopLifecycle {
    #db: Db;
    #executions = new Map<number, { workerId: number; stop: () => number }>();

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
            worker_id: number; execution_budget_ms: number; execution_elapsed_ms: number;
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
            workerId: budget.worker_id,
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

    async park(loopId: number, timing: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
        const now = Date.now();
        for (const value of [timing.timeoutMs, timing.pollMs]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || now + value > 8.64e15)) {
                throw new TypeError("wait durations must be nonnegative safe integer milliseconds within the supported date range");
            }
        }
        return (await this.#db.lifecycle_park_loop.get<{ id: number }>({
            loop_id: loopId,
            elapsed_ms: this.#stopExecution(loopId),
            deadline_at: timing.timeoutMs === undefined ? null : now + timing.timeoutMs,
            poll_interval: timing.pollMs ?? null,
            poll_at: timing.pollMs === undefined || timing.pollMs === 0 ? null : now + timing.pollMs,
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

    parked(workerId: number): Promise<ParkedLoop[]> {
        return this.#db.lifecycle_parked_loops.all<ParkedLoop>({ worker_id: workerId });
    }

    async inheritPoll(loopId: number, revision: number, pollAt: number): Promise<void> {
        await this.#db.lifecycle_set_inherited_poll.run({ loop_id: loopId, revision, poll_at: pollAt });
    }

    async finish(
        loopId: number,
        result: SchemeResult,
        options: { terminatedBy?: "cancel" | null } = {},
    ): Promise<SchemeResult | null> {
        const exact = structuredClone(Results.assert(result));
        if (exact.problem !== undefined && exact.problem.instance === undefined) {
            Results.attachInstance(exact, `loop:///${loopId}`);
        }
        const status = LoopLifecycle.projectStatus(exact.status);
        const row = await this.#db.lifecycle_finish_loop.get<{ terminal_result: string }>({
            loop_id: loopId,
            elapsed_ms: this.#stopExecution(loopId),
            status,
            result: JSON.stringify(exact),
            terminated_by: options.terminatedBy ?? null,
        });
        if (row === undefined) return null;
        return Results.assert(JSON.parse(row.terminal_result) as SchemeResult);
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
            : Results.assert(JSON.parse(row.terminal_result) as SchemeResult);
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

    async cancelTree(workerId: number, reason: string, includeRoot: boolean): Promise<CancelledTree> {
        const boundedReason = ErrorDetail.preview(reason) || "no reason was supplied";
        const params = {
            worker_id: workerId,
            include_root: includeRoot ? 1 : 0,
        };
        const workers = await this.#db.lifecycle_worker_tree.all<{ worker_id: number }>({
            worker_id: params.worker_id,
            include_root: params.include_root,
        });
        const cancellation = Results.failure(
            "lifecycle:cancel",
            "scope-cancelled",
            499,
            `The worker scope was cancelled: ${boundedReason}.`,
            {},
            {
                reason: boundedReason,
                stage: "loop",
                retryable: false,
            },
        );
        const workerIds = new Set(workers.map(({ worker_id }) => worker_id));
        const executions = [...this.#executions].flatMap(([loopId, execution]) =>
            workerIds.has(execution.workerId)
                ? [{ loop_id: loopId, elapsed_ms: this.#stopExecution(loopId) }]
                : []);
        const loops = await this.#db.lifecycle_cancel_worker_tree.all<{
            loop_id: number;
            worker_id: number;
            terminal_result: string;
        }>({ ...params, result: JSON.stringify(cancellation), executions: JSON.stringify(executions) });
        return {
            workerIds: workers.map(({ worker_id }) => worker_id),
            loops: loops.map(({ loop_id, worker_id, terminal_result }) => ({
                loopId: loop_id,
                workerId: worker_id,
                result: Results.assert(JSON.parse(terminal_result) as SchemeResult),
            })),
        };
    }
}
