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
import CapabilityPolicies from "./CapabilityPolicies.ts";
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

    // WORK and FORK name the new worker in the target authority and carry its seed task in the body.
    // Their distinct fresh/branched histories are specified by {§worker-scheme-spawn} and {§worker-scheme-fork}.
    async handleWorkerControl(statement: WorkStatement | ForkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const address = WorkerControlAddress.resolve(statement.target, statement.op);
        if (!address.ok) return address.result;
        const name = address.authority;
        try {
            WorkerName.assert(name); // {§worker-name-minting}
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

        // {§worker-delegation-inherits-policy} — authority flows down the
        // delegation edge. The child receives the delegator's complete loop
        // policy and an immutable snapshot of its effective capability bound.
        const policy = await LoopPolicyReader.read(this.#db, ctx.loopId);
        const capabilityBound = await CapabilityPolicies.delegationBound(
            this.#db,
            ctx.workspaceId,
            ctx.workerId,
            policy,
        );
        const delegationPolicy: LoopPolicy = {
            ...policy,
            capabilities: capabilityBound,
        };

        // A name is frozen per worker but reclaimable across time ({§machine-processes-worker-origin}): a LIVE
        // sister holding it is a 409 (legible, never a raw UNIQUE 500); a free/terminated name reclaims.
        const live = await this.#db.worker_live_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
        if (live !== undefined) {
            return this.#failure(
                "worker-already-running",
                409,
                `Worker '${name}' is already running.`,
                {},
                { worker: name, retryable: false },
            );
        }


        if (statement.op === "FORK") {
            // Branch the current worker's log into a named sister.
            const branchWorkerId = await Fork.fork(
                this.#db,
                ctx.workerId,
                name,
                capabilityBound,
                (scheme) => this.#schemes.entryInheritanceForStoredScheme(scheme, ctx.workerId),
            );
            await ctx.injectWorker({
                workspaceId: ctx.workspaceId,
                workerId: branchWorkerId,
                sourceWorkerId: ctx.workerId,
                prompt,
                freshLoopPolicy: delegationPolicy,
                parentLoopId: ctx.loopId,
            });
            return { status: 200, body: name };
        }
        // WORK — a fresh worker sister named <name>.
        const row = await this.#db.fork_insert_worker.get<{ id: number }>({
            workspace_id: ctx.workspaceId, name, parent_worker_id: ctx.workerId, origin: ctx.writer,
            fork_snapshot: 0,
            capability_bound: JSON.stringify(capabilityBound),
        });
        if (row === undefined) throw new Error("worker spawn: worker insert returned no row");
        await ctx.injectWorker({
            workspaceId: ctx.workspaceId,
            workerId: row.id,
            sourceWorkerId: ctx.workerId,
            prompt,
            freshLoopPolicy: delegationPolicy,
            parentLoopId: ctx.loopId,
        });
        return { status: 200, body: name };
    }


}
