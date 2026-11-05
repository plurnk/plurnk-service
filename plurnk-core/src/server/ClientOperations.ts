// A person's client operations: each one an administrative loop in the workspace's runtime session with its own
// cancellation scope, the statements it dispatches as client turns, its cancellation, and the rollback that runs as
// one such operation. Split out of Daemon, which keeps the delegating port entry points.
import { isRecord, Validator, type PlurnkStatement, type RollbackReport } from "@plurnk/plurnk-contracts";
import ChannelWrite from "../core/ChannelWrite.ts";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import RuntimeSession from "../core/RuntimeSession.ts";
import Turn from "../core/Turn.ts";
import type WorkspaceGate from "../core/WorkspaceGate.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import ClientInput from "./client-input.ts";
import { daemonFailure } from "./daemon-results.ts";
import Envelope from "./envelope.ts";
import Rollback from "./Rollback.ts";
import type WorkspaceResidency from "./WorkspaceResidency.ts";

// {§connection-lifecycle} A client operation cancelled mid-way settles its loop with what happened.
const clientOperationCancelled = (reason: unknown): SchemeResult => {
    const said = typeof reason === "string" ? reason : "cancelled";
    return Results.failure("daemon:client", "operation-cancelled", 499, `The client operation was cancelled: ${said}.`, {}, {
        reason: said, stage: "client-action", retryable: false,
    });
};

const clientActionFailure = (error: unknown): SchemeResult => {
    if (error instanceof OperationFailureError) return error.result;
    console.error("Client action failed outside its operation result contract:", error);
    const cause = ErrorDetail.preview(error);
    return Results.failure(
        "daemon:client",
        "action-threw",
        500,
        cause.length > 0
            ? `The client action failed outside its operation result contract: ${cause}`
            : "The client action failed outside its operation result contract.",
        {},
        {
            stage: "client-action",
            retryable: false },
    );
};

export default class ClientOperations {
    readonly #db: Db;
    readonly #engine: Engine;
    readonly #residency: WorkspaceResidency;
    readonly #workspaceGate: WorkspaceGate;
    readonly #assertModelSession: (workspaceId: number, sessionId: number) => Promise<void>;
    readonly #assertSessionOwned: (workspaceId: number, sessionId: number) => Promise<void>;
    readonly #emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
    // {§connection-lifecycle} Each running client operation's loop, its own cancellation scope and its settlement.
    readonly #loops = new Map<number, {
        readonly workspaceId: number; readonly scope: AbortController; readonly settled: Promise<void>;
    }>();
    // {§session-causal-admission} Every client operation's scope descends from this one, which shutdown aborts:
    // an operation still dispatching, and every execution an operation started, ends with the daemon.
    #scope = new AbortController();

    constructor({ db, engine, residency, workspaceGate, assertModelSession, assertSessionOwned, emitLogEntry }: {
        db: Db;
        engine: Engine;
        residency: WorkspaceResidency;
        workspaceGate: WorkspaceGate;
        assertModelSession: (workspaceId: number, sessionId: number) => Promise<void>;
        assertSessionOwned: (workspaceId: number, sessionId: number) => Promise<void>;
        emitLogEntry: (workspaceId: number, logEntryId: number) => Promise<void>;
    }) {
        this.#db = db;
        this.#engine = engine;
        this.#residency = residency;
        this.#workspaceGate = workspaceGate;
        this.#assertModelSession = assertModelSession;
        this.#assertSessionOwned = assertSessionOwned;
        this.#emitLogEntry = emitLogEntry;
    }

    // A boot opens a fresh scope for the operations that follow; shutdown aborts it ({§session-causal-admission}).
    start(): void {
        this.#scope = new AbortController();
    }

    beginStop(reason: string): void {
        this.#scope.abort(reason);
    }

    // Every operation in flight has settled its loop.
    async idle(): Promise<void> {
        await Promise.all([...this.#loops.values()].map(({ settled }) => settled));
    }

    // {§connection-lifecycle} A person's client operation: one administrative loop in the workspace's runtime
    // session, attributed to its actor, reading `log:///` in the session that person acts for
    // ({§connection-lifecycle}).
    async dispatchClientAction(args: {
        workspaceId: number;
        actor: string;
        contextSessionId?: number;
        statements: PlurnkStatement[];
        onLoop?: (loop: { sessionId: number; loopId: number }) => void;
    }): Promise<Array<{ status: number; [key: string]: unknown }>> {
        const workspaceId = ClientInput.assertId("operation.dispatch-batch", "workspaceId", args.workspaceId);
        const actor = ClientInput.assertActor("operation.dispatch-batch", args.actor);
        const contextSessionId = args.contextSessionId === undefined
            ? undefined
            : ClientInput.assertId("operation.dispatch-batch", "contextSessionId", args.contextSessionId);
        if (contextSessionId !== undefined) await this.#assertModelSession(workspaceId, contextSessionId);
        const { statements } = args;
        if (statements.length === 0) return [];
        return await this.#clientOperation({ workspaceId, actor, contextSessionId, onLoop: args.onLoop }, async (dispatch) => {
            const results: Array<{ status: number; [key: string]: unknown }> = [];
            for (const statement of statements) results.push(await dispatch(statement));
            return results;
        });
    }

    // {§connection-lifecycle} One client operation: the runtime session's administrative loop with its own
    // cancellation scope, settled when the operation ends. Nothing else in the runtime session shares the scope.
    async #clientOperation<T>(
        operation: {
            workspaceId: number;
            actor: string;
            contextSessionId: number | undefined;
            onLoop?: (loop: { sessionId: number; loopId: number }) => void;
        },
        body: (dispatch: (statement: PlurnkStatement) => Promise<{ status: number; [key: string]: unknown }>) => Promise<T>,
    ): Promise<T> {
        const { workspaceId, actor, contextSessionId } = operation;
        const sessionId = await RuntimeSession.ensure(this.#db, workspaceId);
        const releaseCapabilities = await this.#residency.acquire(workspaceId);
        try {
            const loopId = await Envelope.ensureClientLoop(this.#db, sessionId, actor);
            const scope = new AbortController();
            const signal = AbortSignal.any([scope.signal, this.#scope.signal]);
            const settled = Promise.withResolvers<void>();
            this.#loops.set(loopId, { workspaceId, scope, settled: settled.promise });
            const unbind = this.#engine.bindLoopSignal(loopId, signal);
            try {
                operation.onLoop?.({ sessionId, loopId });
                const result = await body(async (statement) => {
                    signal.throwIfAborted();
                    return await this.#dispatchClientStatement({
                        workspaceId, sessionId, loopId, statement,
                        contextSessionId: contextSessionId ?? null,
                    });
                });
                signal.throwIfAborted();
                await Envelope.closeClientLoop(this.#db, loopId, { status: 200 });
                return result;
            } catch (error) {
                // A cancelled operation settles cancelled, however its statement in flight ended.
                const failure = signal.aborted ? new OperationFailureError(clientOperationCancelled(signal.reason)) : error;
                await Envelope.closeClientLoop(this.#db, loopId, clientActionFailure(failure));
                throw failure;
            } finally {
                unbind();
                this.#loops.delete(loopId);
                settled.resolve();
            }
        } finally {
            releaseCapabilities();
        }
    }

    // {§connection-lifecycle} Cancel exactly one client operation: its dispatch while it runs, and every execution its
    // rows started that still runs. The rest of the runtime session runs on.
    async cancelLoop(args: { workspaceId: number; loopId: number; reason?: string }): Promise<boolean> {
        const workspaceId = ClientInput.assertId("operation.cancel", "workspaceId", args.workspaceId);
        const loopId = ClientInput.assertId("operation.cancel", "loopId", args.loopId);
        const operation = this.#loops.get(loopId);
        const dispatching = operation !== undefined && operation.workspaceId === workspaceId && !operation.scope.signal.aborted;
        if (dispatching) operation.scope.abort(args.reason ?? "user_cancelled");
        const executions = await ChannelWrite.findOpenSubscriptionsForClientLoop(this.#db, { workspaceId, loopId });
        const reaped = await Promise.all(executions.map((subscriptionId) => this.#engine.cancelSubscription(subscriptionId)));
        return dispatching || reaped.includes(true);
    }

    // {§methods-workspace-create} Cancel a single live stream subscription owned by `sessionId`.
    async cancelStream(args: {
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly entryId?: number;
        readonly target?: string;
        readonly coordinate?: string;
    }): Promise<boolean> {
        const workspaceId = ClientInput.assertId("stream.cancel", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("stream.cancel", "sessionId", args.sessionId);
        await this.#assertSessionOwned(workspaceId, sessionId);
        const rows = await this.#db.session_open_streams.all<{
            id: number;
            entry_id: number;
            session_id: number;
            scheme: string;
            authority: string;
            pathname: string;
            source: string | null;
        }>({ session_id: sessionId });
        if (rows.length === 0) return false;
        const matched = new Set<number>();
        const fallbackTarget = args.target;
        const fallbackCoordinate = args.coordinate;
        for (const row of rows) {
            const targetUri = renderAddress({ scheme: row.scheme, authority: row.authority, pathname: row.pathname });
            if (
                (args.entryId !== undefined && row.entry_id === args.entryId) ||
                (fallbackTarget !== undefined && targetUri === fallbackTarget) ||
                (fallbackCoordinate !== undefined && row.source !== null && row.source.startsWith(`log:///${fallbackCoordinate}/`))
            ) {
                matched.add(row.id);
            }
        }
        if (matched.size === 0 && args.entryId !== undefined) {
            const logRow = await this.#db.log_entry_by_id.get<{
                session_id: number;
                loop_seq: number;
                turn_seq: number;
                sequence: number;
                attrs: string;
            }>({ id: args.entryId });
            if (logRow !== undefined && logRow.session_id === sessionId) {
                const coord = `${logRow.loop_seq}/${logRow.turn_seq}/${logRow.sequence}`;
                let streamTarget: string | undefined;
                try {
                    const parsed: unknown = JSON.parse(logRow.attrs);
                    if (isRecord(parsed) && typeof parsed.stream === "string") streamTarget = parsed.stream;
                } catch {
                    // ignore
                }
                for (const row of rows) {
                    const targetUri = renderAddress({ scheme: row.scheme, authority: row.authority, pathname: row.pathname });
                    if (
                        (streamTarget !== undefined && targetUri === streamTarget) ||
                        (row.source !== null && row.source.startsWith(`log:///${coord}/`))
                    ) {
                        matched.add(row.id);
                    }
                }
            }
        }
        if (matched.size === 0) return false;
        const reaped = await Promise.all([...matched].map((subscriptionId) => this.#engine.cancelSubscription(subscriptionId)));
        return reaped.includes(true);
    }

    async #dispatchClientStatement(args: {
        workspaceId: number; sessionId: number; loopId: number; statement: PlurnkStatement; contextSessionId: number | null;
    }): Promise<{ status: number; [key: string]: unknown }> {
        const { workspaceId, sessionId, loopId, statement, contextSessionId } = args;
        return this.#workspaceGate.withTurn(workspaceId, sessionId, async () => {
            await this.#residency.reconcile(workspaceId);
            const { id: turnId } = await Turn.open(this.#db, {
                loopId,
                producer: "client",
                kind: "operation" });
            let turnOpen = true;
            try {
                const entryIds: number[] = [];
                const result = await this.#engine.dispatch({
                    statement, workspaceId, sessionId, loopId, turnId, sequence: 1,
                    origin: "client", client: { contextSessionId },
                    onDispatch: (logEntryId: number) => { entryIds.push(logEntryId); } });
                await Turn.complete(this.#db, turnId, result.status);
                turnOpen = false;
                for (const logEntryId of entryIds) await this.#emitLogEntry(workspaceId, logEntryId);
                return result;
            } catch (cause) {
                if (turnOpen) {
                    try {
                        await Turn.complete(this.#db, turnId, 500);
                    } catch (completionCause) {
                        throw new AggregateError(
                            [cause, completionCause],
                            `client operation turn ${turnId} failed and could not be completed`,
                        );
                    }
                }
                throw cause;
            }
        }, this.#loops.get(loopId)?.scope.signal);
    }

    // {§log-wire-format} {§methods-workspace-create} — the compensations are one client operation of the acting person
    // ({§connection-lifecycle}): attributed to that person and, being that person's decision, never routed for review.
    async rollback(args: { workspaceId: number; sessionId: number; actor: string; to: string }): Promise<RollbackReport> {
        const workspaceId = ClientInput.assertId("workspace.rollback", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("workspace.rollback", "sessionId", args.sessionId);
        const actor = ClientInput.assertActor("workspace.rollback", args.actor);
        if (typeof args.to !== "string") throw daemonFailure("daemon:rollback", "coordinate-invalid", 400, "The rollback coordinate must be a string.", {});
        await this.#assertSessionOwned(workspaceId, sessionId);
        const report = await this.#clientOperation({ workspaceId, actor, contextSessionId: sessionId }, (dispatch) => Rollback.run({
            db: this.#db,
            projectRoot: async (id) => (await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id }))?.project_root ?? null,
            executorTags: (id) => this.#engine.executorTags(id),
            apply: async (statement) => await dispatch(statement),
        }, { workspaceId, sessionId, to: args.to }));
        return Validator.assertRollbackReport(report);
    }
}
