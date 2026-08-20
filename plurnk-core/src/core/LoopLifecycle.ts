import type { Db } from "./Db.ts";
import Results, { type SchemeResult } from "./results.ts";
import ErrorDetail from "./ErrorDetail.ts";

export interface CancelledLoop {
    loopId: number;
    workerId: number;
    result: SchemeResult;
}

export interface CancelledTree {
    workerIds: number[];
    loops: CancelledLoop[];
}

export default class LoopLifecycle {
    #db: Db;

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

    async park(loopId: number): Promise<boolean> {
        return (await this.#db.lifecycle_park_loop.get<{ id: number }>({
            loop_id: loopId,
        })) !== undefined;
    }

    async wake(loopId: number): Promise<boolean> {
        return (await this.#db.lifecycle_wake_loop.get<{ id: number }>({
            loop_id: loopId,
        })) !== undefined;
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
        const row = await this.#db.lifecycle_finish_loop.get<{ terminal_result: string }>({
            loop_id: loopId,
            status: LoopLifecycle.projectStatus(exact.status),
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
        const loops = await this.#db.lifecycle_cancel_worker_tree.all<{
            loop_id: number;
            worker_id: number;
            terminal_result: string;
        }>({ ...params, result: JSON.stringify(cancellation) });
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
