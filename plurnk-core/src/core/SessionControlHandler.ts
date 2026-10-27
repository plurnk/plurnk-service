// WORK and FORK dispatch: the session creation and control statements, split out of Dispatcher.
import type { ForkStatement, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import SessionName, { SessionNameError, SessionNameConflictError } from "./SessionName.ts";
import SessionControlAddress from "./SessionControlAddress.ts";
import Fork from "./fork.ts";
import SessionOwners from "./SessionOwners.ts";
import SessionCap from "./session-cap.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { MessageOpener } from "./ChannelWrite.ts";
import type { DispatchResult } from "./Dispatcher.ts";

export default class SessionControlHandler {
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
    // Their distinct fresh/branched histories are specified by {§session-scheme} and {§session-scheme}.
    async handleSessionControl(statement: WorkStatement | ForkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const address = statement.target === null ? null : SessionControlAddress.resolve(statement.target, statement.op);
        if (address !== null && !address.ok) return address.result;
        const name = address?.authority;
        try {
            if (name !== undefined) SessionName.assert(name); // {§session-scheme}
        } catch (error) {
            if (!(error instanceof SessionNameError)) throw error;
            return this.#failure(
                `session-${error.code}`,
                400,
                error.message,
                {},
                {
                    operation: statement.op,
                    session: error.sessionName,
                    recovery: error.recovery,
                    retryable: false,
                },
            );
        }
        if (ctx.injectSession === undefined) throw new Error("session control: injectSession capability absent");
        const denied = await SessionCap.deny(this.#db, ctx.workspaceId);
        if (denied !== null) return denied;
        const prompt = statement.body;
        // {§session-scheme} — the schema admits an empty body because a resource may
        // carry the prompt; by the time the statement reaches here the resource is composed in, so
        // an empty prompt is a real absence.
        if (prompt.trim() === "") {
            return this.#failure("spawn-prompt-empty", 422, `${statement.op} has no prompt text.`, {}, {
                operation: statement.op,
                recovery: `Write the prompt on the lines beneath the ${statement.op} fence line.`,
                retryable: false,
            });
        }

        // {§session-scheme} — WORK to a name a session holds is the voice door ({§session-scheme}):
        // the body is that session's message and nothing is created.
        if (statement.op === "WORK" && name !== undefined) {
            const held = await this.#db.session_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
            if (held !== undefined) return this.#message(ctx, name, held.id, prompt);
        }

        let sessionId: number;
        try {
            const created = await this.#createSession(statement, ctx, name);
            if ("status" in created) return created;
            sessionId = created.id;
        } catch (error) {
            if (!(error instanceof SessionNameConflictError)) throw error;
            if (statement.op === "WORK") {
                // The name was claimed between the lookup and the claim: it is held now, so the body is its message.
                const held = await this.#db.session_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: error.sessionName });
                if (held !== undefined) return this.#message(ctx, error.sessionName, held.id, prompt);
            }
            // {§session-scheme}: a branch needs a name no session holds; the live session is addressed, not re-spawned.
            return this.#failure(
                "session-name-conflict",
                409,
                error.message,
                {},
                {
                    operation: statement.op,
                    session: error.sessionName,
                    recovery: `WORK or SEND (session://${error.sessionName}) delivers a message to the live session; FORK with a name no session holds.`,
                    retryable: false,
                },
            );
        }
        const session = await this.#db.session_get.get<{ name: string }>({ id: sessionId });
        if (session === undefined) throw new Error("session control: created session was not found");
        const opener = SessionControlHandler.opener(ctx);
        const { message } = await ctx.injectSession({
            workspaceId: ctx.workspaceId,
            sessionId,
            sourceLoopId: ctx.loopId,
            prompt,
            // {§session-model-selection} A model's child inherits its loop's model; a session a person starts runs its own.
            ...(ctx.client === undefined ? { spawn: true } as const : {}),
            ...(opener === undefined ? {} : { opener }),
        });
        return { status: 200, body: session.name, attrs: { session: SessionControlAddress.render(session.name), ...(opener === undefined ? {} : { message }) } };
    }

    // {§loop-completion} A session's own operation opens the obligation its message carries; a person's act opens none
    // of a session's, since the voice is the person's ({§actor-boundary-client-operations}).
    static opener(ctx: PlurnkSchemeContext): MessageOpener | undefined {
        return ctx.client === undefined && ctx.sequence !== undefined ? { turnId: ctx.turnId, sequence: ctx.sequence } : undefined;
    }

    // {§session-scheme} — the message takes the receiver as it is.
    async #message(
        ctx: PlurnkSchemeContext,
        name: string,
        sessionId: number,
        prompt: string,
    ): Promise<DispatchResult> {
        if (ctx.injectSession === undefined) throw new Error("session control: injectSession capability absent");
        const opener = SessionControlHandler.opener(ctx);
        const { message } = await ctx.injectSession({
            workspaceId: ctx.workspaceId,
            sessionId,
            sourceLoopId: ctx.loopId,
            prompt,
            ...(opener === undefined ? {} : { opener }),
        });
        return { status: 200, body: name, attrs: { session: SessionControlAddress.render(name), delivered: "message", ...(opener === undefined ? {} : { message }) } };
    }

    // {§machine-processes} Every session WORK or FORK creates is a model's. A model's is its child; a
    // person's operation acts for them ({§actor-boundary-client-operations}): their WORK starts a root session they
    // own, and their FORK branches the session they act for.
    async #createSession(
        statement: WorkStatement | ForkStatement,
        ctx: PlurnkSchemeContext,
        name: string | undefined,
    ): Promise<{ readonly id: number } | DispatchResult> {
        const claim = (options: { workspaceId: number; parentSessionId?: number; owner?: string }) => name === undefined
            ? SessionName.claimAuto(this.#db, options)
            : SessionName.claimNamed(this.#db, name, options);
        if (ctx.client === undefined) {
            if (statement.op === "FORK") return { id: await Fork.fork(this.#db, ctx.sessionId, name) };
            const parent = await this.#db.session_get.get<{ workspace_id: number }>({ id: ctx.sessionId });
            if (parent?.workspace_id !== ctx.workspaceId) throw new Error("session control: parent is absent from this workspace");
            return claim({ workspaceId: ctx.workspaceId, parentSessionId: ctx.sessionId });
        }
        if (statement.op === "FORK") {
            const acted = ctx.client.contextSessionId;
            if (acted === null) {
                return this.#failure("fork-unaddressed", 404, "This client operation acts for no session, so FORK has no log to branch.", {}, {
                    operation: "FORK", retryable: false,
                });
            }
            return { id: await Fork.fork(this.#db, acted, name) };
        }
        const person = await this.#db.envelope_client_operation_person.get<{ person: string }>({ loop_id: ctx.loopId });
        if (person === undefined) throw new Error("session control: a client operation's loop names no person");
        await SessionOwners.admit(this.#db, ctx.workspaceId, person.person);
        return claim({ workspaceId: ctx.workspaceId, owner: person.person });
    }
}
