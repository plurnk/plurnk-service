// WORK and FORK dispatch: the session creation and control statements, split out of Dispatcher.
import { EFFORTS, Validator, type ApplicationPersonaProjection, type Effort, type ForkStatement, type WorkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import SessionName, { SessionNameError, SessionNameConflictError } from "./SessionName.ts";
import SessionControlAddress from "./SessionControlAddress.ts";
import Fork from "./fork.ts";
import SessionOwners from "./SessionOwners.ts";
import SessionCap from "./session-cap.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { MessageOpener, SpawnGenerationOverride } from "./ChannelWrite.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { OperationFailureError } from "./results.ts";

export default class SessionControlHandler {
    readonly #db: Db;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    readonly #resolvePersona: ((workspaceId: number, personaName: string) => Promise<ApplicationPersonaProjection | null>) | undefined;
    readonly #preflightSpawn: ((args: {
        readonly workspaceId: number;
        readonly sourceLoopId: number;
        readonly spawn: boolean;
        readonly override: SpawnGenerationOverride;
    }) => Promise<void>) | undefined;

    constructor({ db, failure, resolvePersona, preflightSpawn }: {
        db: Db;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
        resolvePersona?: (workspaceId: number, personaName: string) => Promise<ApplicationPersonaProjection | null>;
        preflightSpawn?: (args: {
            readonly workspaceId: number;
            readonly sourceLoopId: number;
            readonly spawn: boolean;
            readonly override: SpawnGenerationOverride;
        }) => Promise<void>;
    }) {
        this.#db = db;
        this.#failure = failure;
        this.#resolvePersona = resolvePersona;
        this.#preflightSpawn = preflightSpawn;
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
                recovery: `Provide a non-empty prompt in \`mcp({ server: "plurnk", tool: "${statement.op.toLowerCase()}", arguments: { text: "..." } })\`.`,
                retryable: false,
            });
        }

        const hasSpawnOptions = statement.persona !== undefined || statement.model !== undefined || statement.effort !== undefined;

        // {§session-scheme} — work to a name a session holds is the voice door ({§session-scheme}):
        // the body is that session's message and nothing is created.
        if (statement.op === "work" && name !== undefined) {
            const held = await this.#db.session_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
            if (held !== undefined) {
                if (hasSpawnOptions) return this.#existingSessionOptionsFailure(name);
                return this.#message(ctx, name, held.id, prompt);
            }
        }

        let matchedPersona: ApplicationPersonaProjection | null = null;
        if (statement.persona !== undefined) {
            matchedPersona = (await this.#resolvePersona?.(ctx.workspaceId, statement.persona)) ?? null;
            if (matchedPersona === null) {
                return this.#failure(
                    "persona-not-found",
                    404,
                    `Persona '${statement.persona}' does not exist or is disabled in this workspace.`,
                    {},
                    {
                        operation: statement.op,
                        persona: statement.persona,
                        recovery: 'Find available personas with `mcp({ server: "plurnk", tool: "find", arguments: { path: "persona://*/PERSONA.md" } })` or omit `persona`.',
                        retryable: false,
                    },
                );
            }
        }

        let explicitEffort: Effort | undefined;
        if (statement.effort !== undefined) {
            try {
                explicitEffort = Validator.assertEffort(statement.effort);
            } catch (cause) {
                return this.#failure(
                    "effort-invalid",
                    400,
                    cause instanceof Error ? cause.message : "The effort is invalid.",
                    {},
                    {
                        operation: statement.op,
                        field: "effort",
                        effort: statement.effort,
                        recovery: `Select a valid effort: ${EFFORTS.join(", ")}.`,
                        retryable: false,
                    },
                );
            }
        }

        const effectiveModel = statement.model ?? matchedPersona?.model;
        const spawnOverride: SpawnGenerationOverride | undefined =
            effectiveModel !== undefined || explicitEffort !== undefined || matchedPersona?.effort !== undefined
                ? {
                      ...(effectiveModel === undefined ? {} : { model: effectiveModel }),
                      ...(explicitEffort === undefined ? {} : { explicitEffort }),
                      ...(matchedPersona?.effort === undefined ? {} : { personaEffort: matchedPersona.effort }),
                  }
                : undefined;

        if (spawnOverride !== undefined && this.#preflightSpawn !== undefined) {
            try {
                await this.#preflightSpawn({
                    workspaceId: ctx.workspaceId,
                    sourceLoopId: ctx.loopId,
                    spawn: ctx.client === undefined,
                    override: spawnOverride,
                });
            } catch (cause) {
                if (cause instanceof OperationFailureError) return cause.result;
                throw cause;
            }
        }

        let sessionId: number;
        try {
            const created = await this.#createSession(statement, ctx, name, matchedPersona?.name);
            if ("status" in created) return created;
            sessionId = created.id;
        } catch (error) {
            if (!(error instanceof SessionNameConflictError)) throw error;
            if (statement.op === "work") {
                // The name was claimed between the lookup and the claim: it is held now, so the body is its message.
                const held = await this.#db.session_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: error.sessionName });
                if (held !== undefined) {
                    if (hasSpawnOptions) return this.#existingSessionOptionsFailure(error.sessionName);
                    return this.#message(ctx, error.sessionName, held.id, prompt);
                }
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
                    recovery: `mcp({ server: "plurnk", tool: "work", arguments: { target: "session://${error.sessionName}", text: "..." } }) or mcp({ server: "plurnk", tool: "send", arguments: { target: "session://${error.sessionName}", text: "..." } }) delivers a message to the live session; fork with a name no session holds.`,
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
            created: true,
            // {§session-model-selection} A model's child inherits its loop's model; a session a person starts runs its own.
            ...(ctx.client === undefined ? { spawn: true } as const : {}),
            ...(spawnOverride === undefined ? {} : { spawnOverride }),
            ...(opener === undefined ? {} : { opener }),
        });
        return { status: 200, body: session.name, attrs: { session: SessionControlAddress.render(session.name), ...(opener === undefined ? {} : { message }) } };
    }

    #existingSessionOptionsFailure(name: string): DispatchResult {
        return this.#failure(
            "spawn-options-existing-session",
            409,
            `Session '${name}' already exists; persona, model, and effort apply only when creating a new session.`,
            {},
            {
                operation: "work",
                session: name,
                recovery: `mcp({ server: "plurnk", tool: "work", arguments: { target: "session://${name}", text: "..." } }) delivers a message to the existing session, or choose a new session:// name.`,
                retryable: false,
            },
        );
    }

    // {§loop-completion} A session's own operation opens the obligation its message carries; a person's act opens none
    // of a session's, since the voice is the person's ({§connection-lifecycle}).
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

    // {§machine-processes} Every session work or fork creates is a model's. A model's is its child; a
    // person's operation acts for them ({§connection-lifecycle}): their work starts a root session they
    // own, and their fork branches the session they act for.
    async #createSession(
        statement: WorkStatement | ForkStatement,
        ctx: PlurnkSchemeContext,
        name: string | undefined,
        persona: string | undefined,
    ): Promise<{ readonly id: number } | DispatchResult> {
        const claim = (options: { workspaceId: number; parentSessionId?: number; owner?: string; persona?: string }) => name === undefined
            ? SessionName.claimAuto(this.#db, options)
            : SessionName.claimNamed(this.#db, name, options);
        if (ctx.client === undefined) {
            if (statement.op === "fork") return { id: await Fork.fork(this.#db, ctx.sessionId, name, persona) };
            const parent = await this.#db.session_get.get<{ workspace_id: number }>({ id: ctx.sessionId });
            if (parent?.workspace_id !== ctx.workspaceId) throw new Error("session control: parent is absent from this workspace");
            return claim({ workspaceId: ctx.workspaceId, parentSessionId: ctx.sessionId, ...(persona === undefined ? {} : { persona }) });
        }
        if (statement.op === "fork") {
            const acted = ctx.client.contextSessionId;
            if (acted === null) {
                return this.#failure("fork-unaddressed", 404, "This client operation acts for no session, so fork has no log to branch.", {}, {
                    operation: "fork", retryable: false,
                });
            }
            return { id: await Fork.fork(this.#db, acted, name, persona) };
        }
        const person = await this.#db.envelope_client_operation_person.get<{ person: string }>({ loop_id: ctx.loopId });
        if (person === undefined) throw new Error("session control: a client operation's loop names no person");
        await SessionOwners.admit(this.#db, ctx.workspaceId, person.person);
        return claim({ workspaceId: ctx.workspaceId, owner: person.person, ...(persona === undefined ? {} : { persona }) });
    }
}
