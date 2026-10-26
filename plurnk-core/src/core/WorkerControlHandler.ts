// WORK and FORK dispatch: the worker creation and control statements, split out of Dispatcher.
import type { ForkStatement, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkerName, { WorkerNameError, WorkerNameConflictError } from "./WorkerName.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import Fork from "./fork.ts";
import WorkerOwners from "./WorkerOwners.ts";
import WorkerCap from "./worker-cap.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { MessageOpener } from "./ChannelWrite.ts";
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
            return this.#failure("spawn-prompt-empty", 422, `${statement.op} has no prompt text.`, {}, {
                operation: statement.op,
                recovery: `Write the prompt on the lines beneath the ${statement.op} fence line.`,
                retryable: false,
            });
        }

        // {§worker-scheme-spawn} — WORK to a name a worker holds is the voice door ({§worker-scheme-irc}):
        // the body is that worker's message and nothing is created.
        if (statement.op === "WORK" && name !== undefined) {
            const held = await this.#db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
            if (held !== undefined) return this.#message(ctx, name, held.id, prompt);
        }

        let workerId: number;
        try {
            const created = await this.#createWorker(statement, ctx, name);
            if ("status" in created) return created;
            workerId = created.id;
        } catch (error) {
            if (!(error instanceof WorkerNameConflictError)) throw error;
            if (statement.op === "WORK") {
                // The name was claimed between the lookup and the claim: it is held now, so the body is its message.
                const held = await this.#db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: error.workerName });
                if (held !== undefined) return this.#message(ctx, error.workerName, held.id, prompt);
            }
            // {§worker-scheme-spawn}: a branch needs a name no worker holds; the live worker is addressed, not re-spawned.
            return this.#failure(
                "worker-name-conflict",
                409,
                error.message,
                {},
                {
                    operation: statement.op,
                    worker: error.workerName,
                    recovery: `WORK or SEND (worker://${error.workerName}) delivers a message to the live worker; FORK with a name no worker holds.`,
                    retryable: false,
                },
            );
        }
        const worker = await this.#db.worker_get.get<{ name: string }>({ id: workerId });
        if (worker === undefined) throw new Error("worker control: created worker was not found");
        const opener = WorkerControlHandler.opener(ctx);
        const { message } = await ctx.injectWorker({
            workspaceId: ctx.workspaceId,
            workerId,
            sourceLoopId: ctx.loopId,
            prompt,
            // {§worker-model-selection} A model's child inherits its loop's model; a worker a person starts runs its own.
            ...(ctx.client === undefined ? { spawn: true } as const : {}),
            ...(opener === undefined ? {} : { opener }),
        });
        return { status: 200, body: worker.name, attrs: { worker: WorkerControlAddress.render(worker.name), ...(opener === undefined ? {} : { message }) } };
    }

    // {§worker-obligations} A worker's own operation opens the obligation its message carries; a person's act opens none
    // of a worker's, since the voice is the person's ({§actor-boundary-client-operations}).
    static opener(ctx: PlurnkSchemeContext): MessageOpener | undefined {
        return ctx.client === undefined && ctx.sequence !== undefined ? { turnId: ctx.turnId, sequence: ctx.sequence } : undefined;
    }

    // {§worker-scheme-irc} — the message takes the receiver as it is.
    async #message(
        ctx: PlurnkSchemeContext,
        name: string,
        workerId: number,
        prompt: string,
    ): Promise<DispatchResult> {
        if (ctx.injectWorker === undefined) throw new Error("worker control: injectWorker capability absent");
        const opener = WorkerControlHandler.opener(ctx);
        const { message } = await ctx.injectWorker({
            workspaceId: ctx.workspaceId,
            workerId,
            sourceLoopId: ctx.loopId,
            prompt,
            ...(opener === undefined ? {} : { opener }),
        });
        return { status: 200, body: name, attrs: { worker: WorkerControlAddress.render(name), delivered: "message", ...(opener === undefined ? {} : { message }) } };
    }

    // {§machine-processes-worker-origin} Every worker WORK or FORK creates is a model's. A model's is its child; a
    // person's operation acts for them ({§actor-boundary-client-operations}): their WORK starts a root worker they
    // own, and their FORK branches the worker they act for.
    async #createWorker(
        statement: WorkStatement | ForkStatement,
        ctx: PlurnkSchemeContext,
        name: string | undefined,
    ): Promise<{ readonly id: number } | DispatchResult> {
        const claim = (options: { workspaceId: number; parentWorkerId?: number; owner?: string }) => name === undefined
            ? WorkerName.claimAuto(this.#db, options)
            : WorkerName.claimNamed(this.#db, name, options);
        if (ctx.client === undefined) {
            if (statement.op === "FORK") return { id: await Fork.fork(this.#db, ctx.workerId, name) };
            const parent = await this.#db.worker_get.get<{ workspace_id: number }>({ id: ctx.workerId });
            if (parent?.workspace_id !== ctx.workspaceId) throw new Error("worker control: parent is absent from this workspace");
            return claim({ workspaceId: ctx.workspaceId, parentWorkerId: ctx.workerId });
        }
        if (statement.op === "FORK") {
            const acted = ctx.client.contextWorkerId;
            if (acted === null) {
                return this.#failure("fork-unaddressed", 404, "This client operation acts for no worker, so FORK has no log to branch.", {}, {
                    operation: "FORK", retryable: false,
                });
            }
            return { id: await Fork.fork(this.#db, acted, name) };
        }
        const person = await this.#db.envelope_client_operation_person.get<{ person: string }>({ loop_id: ctx.loopId });
        if (person === undefined) throw new Error("worker control: a client operation's loop names no person");
        await WorkerOwners.admit(this.#db, ctx.workspaceId, person.person);
        return claim({ workspaceId: ctx.workspaceId, owner: person.person });
    }
}
