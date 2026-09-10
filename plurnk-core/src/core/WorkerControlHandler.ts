// WORK and FORK dispatch: the worker creation and control statements, split out of Dispatcher.
import type { ForkStatement, LoopPolicy, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkerName, { WorkerNameError } from "./WorkerName.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import Fork from "./fork.ts";
import WorkerCap from "./worker-cap.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import LoopPolicyReader from "./LoopPolicyReader.ts";
import type { DispatchResult } from "./Dispatcher.ts";

export default class WorkerControlHandler {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    constructor({ db, schemes, failure }: {
        db: Db;
        schemes: SchemeRegistry;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#failure = failure;
    }

    // WORK and FORK optionally name the child and carry its seed task in the body.
    // Their distinct fresh/branched histories are specified by {§worker-scheme-spawn} and {§worker-scheme-fork}.
    async handleWorkerControl(statement: WorkStatement | ForkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const origin = ctx.writer;
        if (origin === "plugin") throw new Error("Worker control received a plugin writer despite the worker scheme's write policy.");
        const address = statement.target === null ? null : WorkerControlAddress.resolve(statement.target, statement.op);
        if (address !== null && !address.ok) return address.result;
        const name = address?.authority;
        try {
            if (name !== undefined) WorkerName.assert(name); // {§worker-name-minting}
        } catch (error) {
            if (!(error instanceof WorkerNameError)) throw error;
            return this.#failure(
                `worker-${error.code}`,
                400,
                error.message,
                {},
                {
                    operation: statement.op,
                    worker: error.workerName,
                    recovery: error.recovery,
                    retryable: false,
                },
            );
        }
        if (ctx.injectWorker === undefined) throw new Error("worker control: injectWorker capability absent");
        const denied = await WorkerCap.deny(this.#db, ctx.workspaceId);
        if (denied !== null) return denied;
        const prompt = statement.body;

        const delegationPolicy: LoopPolicy = await LoopPolicyReader.read(this.#db, ctx.loopId);

        // A name is frozen per worker but reclaimable across time ({§machine-processes-worker-origin}): a LIVE
        // sister holding it is a 409 (legible, never a raw UNIQUE 500); a free/terminated name reclaims.
        const live = name === undefined ? undefined : await this.#db.worker_live_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
        if (live !== undefined) {
            return this.#failure(
                "worker-already-running",
                409,
                `Worker '${name}' is already running.`,
                {},
                { worker: name, retryable: false },
            );
        }
        let workerId: number;
        if (statement.op === "FORK") {
            workerId = await Fork.fork(
                this.#db,
                ctx.workerId,
                name,
                (scheme) => this.#schemes.entryInheritanceForStoredScheme(scheme, ctx.workspaceId),
            );
        } else {
            const row = name === undefined
                ? await WorkerName.claimAuto(this.#db, {
                    workspaceId: ctx.workspaceId,
                    parentWorkerId: ctx.workerId,
                    origin,
                })
                : await this.#db.fork_insert_worker.get<{ id: number }>({
                    workspace_id: ctx.workspaceId, name, parent_worker_id: ctx.workerId, origin,
                    fork_snapshot: 0,
                });
            if (row === undefined) throw new Error("worker spawn: worker insert returned no row");
            workerId = row.id;
        }
        const worker = await this.#db.fork_get_worker.get<{ name: string }>({ id: workerId });
        if (worker === undefined) throw new Error("worker control: created worker was not found");
        await ctx.injectWorker({
            workspaceId: ctx.workspaceId,
            workerId,
            sourceLoopId: ctx.loopId,
            prompt,
            freshLoopPolicy: delegationPolicy,
            spawn: true,
        });
        return { status: 200, body: worker.name, attrs: { worker: WorkerControlAddress.render(worker.name) } };
    }


}
