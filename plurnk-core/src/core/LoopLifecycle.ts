import type { Db } from "./Db.ts";

export interface CancelledLoop {
    loopId: number;
    workerId: number;
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

    async park(loopId: number, message: string): Promise<boolean> {
        return (await this.#db.lifecycle_park_loop.get<{ id: number }>({
            loop_id: loopId,
            message,
        })) !== undefined;
    }

    async wake(loopId: number): Promise<boolean> {
        return (await this.#db.lifecycle_wake_loop.get<{ id: number }>({
            loop_id: loopId,
        })) !== undefined;
    }

    async finish(
        loopId: number,
        status: 200 | 413 | 429 | 499 | 500 | 504 | 508,
        message: string | null,
        terminatedBy: "cancel" | null = null,
    ): Promise<boolean> {
        return (await this.#db.lifecycle_finish_loop.get<{ id: number }>({
            loop_id: loopId,
            status,
            message,
            terminated_by: terminatedBy,
        })) !== undefined;
    }

    async status(loopId: number): Promise<number> {
        const row = await this.#db.lifecycle_loop_status.get<{ status: number }>({
            loop_id: loopId,
        });
        if (row === undefined) throw new Error(`loop ${loopId} does not exist`);
        return row.status;
    }

    async turnIds(loopId: number): Promise<number[]> {
        const rows = await this.#db.lifecycle_loop_turns.all<{ id: number }>({
            loop_id: loopId,
        });
        return rows.map(({ id }) => id);
    }

    async cancelTree(workerId: number, reason: string, includeRoot: boolean): Promise<CancelledTree> {
        const params = {
            worker_id: workerId,
            include_root: includeRoot ? 1 : 0,
            message: reason.slice(0, 500),
        };
        const workers = await this.#db.lifecycle_worker_tree.all<{ worker_id: number }>({
            worker_id: params.worker_id,
            include_root: params.include_root,
        });
        const loops = await this.#db.lifecycle_cancel_worker_tree.all<{
            loop_id: number;
            worker_id: number;
        }>(params);
        return {
            workerIds: workers.map(({ worker_id }) => worker_id),
            loops: loops.map(({ loop_id, worker_id }) => ({ loopId: loop_id, workerId: worker_id })),
        };
    }
}
