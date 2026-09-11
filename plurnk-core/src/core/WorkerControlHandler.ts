// WORK and FORK dispatch: the worker creation and control statements, split out of Dispatcher.
import type { ForkStatement, LoopPolicy, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkerName, { WorkerNameError, WorkerNameConflictError, type WorkerOrigin } from "./WorkerName.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import Fork from "./fork.ts";
import WorkerCap from "./worker-cap.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import LoopPolicyReader from "./LoopPolicyReader.ts";
import type { DispatchResult } from "./Dispatcher.ts";

export default class WorkerControlHandler {
    readonly #db: Db;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    constructor({ db, failure }: {
        db: Db;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#db = db;
        this.#failure = failure;
    }

    // WORK and FORK optionally name the child and carry its seed task in the body.
    // Their distinct fresh/branched histories are specified by {§worker-scheme-spawn} and {§worker-scheme-fork}.
    async handleWorkerControl(statement: WorkStatement | ForkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
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
        // {§worker-spawn-prompt-resource} — the schema admits an empty body because a resource may
        // carry the prompt; by the time the statement reaches here the resource is composed in, so
        // an empty prompt is a real absence.
        if (prompt.trim() === "") {
            return this.#failure("spawn-prompt-empty", 422, `${statement.op} has no prompt text.`, {}, { operation: statement.op, retryable: false });
        }

        const delegationPolicy: LoopPolicy = await LoopPolicyReader.read(this.#db, ctx.loopId);

        let workerId: number;
        try {
            workerId = await this.#createWorker(statement, ctx, name);
        } catch (error) {
            if (!(error instanceof WorkerNameConflictError)) throw error;
            return this.#failure(
                "worker-name-conflict",
                409,
                error.message,
                {},
                { worker: error.workerName, retryable: false },
            );
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

    async #createWorker(
        statement: WorkStatement | ForkStatement,
        ctx: PlurnkSchemeContext,
        name: string | undefined,
    ): Promise<number> {
        if (statement.op === "FORK") return Fork.fork(this.#db, ctx.workerId, name);
        const parent = await this.#db.fork_get_worker.get<{ workspace_id: number; origin: WorkerOrigin }>({ id: ctx.workerId });
        if (parent?.workspace_id !== ctx.workspaceId) throw new Error("worker control: parent is absent from this workspace");
        const options = { workspaceId: ctx.workspaceId, parentWorkerId: ctx.workerId, origin: parent.origin };
        const row = name === undefined
            ? await WorkerName.claimAuto(this.#db, options)
            : await WorkerName.claimNamed(this.#db, name, options);
        return row.id;
    }
}
