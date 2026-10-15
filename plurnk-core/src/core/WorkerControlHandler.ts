// WORK and FORK dispatch: the worker creation and control statements, split out of Dispatcher.
import type { ForkStatement, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkerName, { WorkerNameError, WorkerNameConflictError } from "./WorkerName.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import Fork from "./fork.ts";
import WorkerCap from "./worker-cap.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { MetadataOptions } from "@plurnk/plurnk-schemes";
import EnvFunctionality from "../server/EnvFunctionality.ts";
import { OperationFailureError } from "./results.ts";

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
        // {§env-option} — the child's starting environment rides the heading. WORK and FORK own their
        // slot: a key they do not take is their own refusal, a bad name the family's, both by name and
        // before anything is created.
        const read = MetadataOptions.parse(statement.metadata, "scheme:worker", { operation: statement.op });
        if ("failure" in read) return read.failure;
        const foreign = Object.keys(read.options);
        if (foreign.length > 0) {
            return this.#failure("metadata-unsupported", 400, `${statement.op} takes only the env option; '${foreign[0]}' is not one.`, {}, { operation: statement.op, field: foreign[0], retryable: false });
        }
        let environment: Readonly<Record<string, string>>;
        try {
            environment = EnvFunctionality.environment(read.env);
        } catch (cause) {
            if (!(cause instanceof OperationFailureError)) throw cause;
            return cause.result;
        }

        // {§worker-scheme-spawn} — WORK to a name a worker holds is the voice door ({§worker-scheme-irc}):
        // the body is that worker's message and nothing is created.
        if (statement.op === "WORK" && name !== undefined) {
            const held = await this.#db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
            if (held !== undefined) return this.#message(ctx, name, held.id, prompt, environment);
        }

        // {§machine-processes-worker-origin} A model delegates: only a model worker starts a child.
        const parent = await this.#db.worker_get.get<{ workspace_id: number; name: string; origin: string }>({ id: ctx.workerId });
        if (parent?.workspace_id !== ctx.workspaceId) throw new Error("worker control: parent is absent from this workspace");
        if (parent.origin !== "model") {
            return this.#failure("model-worker-required", 409,
                `${statement.op} starts a child of the worker that runs it, and '${parent.name}' is not a model worker.`, {}, {
                    operation: statement.op,
                    worker: parent.name,
                    recovery: "WORK to the address of a worker that exists delivers its prompt as a message.",
                    retryable: false,
                });
        }

        let workerId: number;
        try {
            workerId = await this.#createWorker(statement, ctx, name);
        } catch (error) {
            if (!(error instanceof WorkerNameConflictError)) throw error;
            if (statement.op === "WORK") {
                // The name was claimed between the lookup and the claim: it is held now, so the body is its message.
                const held = await this.#db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: error.workerName });
                if (held !== undefined) return this.#message(ctx, error.workerName, held.id, prompt, environment);
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
        await ctx.injectWorker({
            workspaceId: ctx.workspaceId,
            workerId,
            sourceLoopId: ctx.loopId,
            prompt,
            spawn: true,
            ...(Object.keys(environment).length === 0 ? {} : { environment }),
        });
        return { status: 200, body: worker.name, attrs: { worker: WorkerControlAddress.render(worker.name) } };
    }

    // {§worker-scheme-irc} — the message takes the receiver as it is: its environment is its own, so the
    // env slot, a spawn's, is refused by name before anything is delivered.
    async #message(
        ctx: PlurnkSchemeContext,
        name: string,
        workerId: number,
        prompt: string,
        environment: Readonly<Record<string, string>>,
    ): Promise<DispatchResult> {
        if (Object.keys(environment).length > 0) {
            return this.#failure("metadata-unsupported", 400, `WORK to the existing worker '${name}' carries env; a message takes none.`, {}, {
                operation: "WORK", worker: name, field: "env", retryable: false,
            });
        }
        if (ctx.injectWorker === undefined) throw new Error("worker control: injectWorker capability absent");
        await ctx.injectWorker({
            workspaceId: ctx.workspaceId,
            workerId,
            sourceLoopId: ctx.loopId,
            prompt,
        });
        return { status: 200, body: name, attrs: { worker: WorkerControlAddress.render(name), delivered: "message" } };
    }

    async #createWorker(
        statement: WorkStatement | ForkStatement,
        ctx: PlurnkSchemeContext,
        name: string | undefined,
    ): Promise<number> {
        if (statement.op === "FORK") return Fork.fork(this.#db, ctx.workerId, name);
        const options = { workspaceId: ctx.workspaceId, parentWorkerId: ctx.workerId };
        const row = name === undefined
            ? await WorkerName.claimAuto(this.#db, options)
            : await WorkerName.claimNamed(this.#db, name, options);
        return row.id;
    }
}
