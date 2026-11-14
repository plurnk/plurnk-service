// {§session-causal-admission} {§session-wait-timing}
// Per-workspace FIFO serializer governing cross-session message admission, source-loop liveness,
// idempotent message addresses, and atomic subtree cancellation before entering SessionProcess.
// Lock partial order: WorkspaceAdmission(workspaceId) < SessionProcess(sessionId).

import ChannelWrite from "../core/ChannelWrite.ts";
import type { Db } from "../core/Db.ts";
import type LoopLifecycle from "../core/LoopLifecycle.ts";
import MessageResources from "../core/MessageResources.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import type SessionProcess from "./SessionProcess.ts";
import type { AdmittedDelivery, DrainInjectionArgs } from "./SessionProcess.ts";

export type PreparedSubtreeCancel = Readonly<{
    loops: ReadonlyArray<{
        loopId: number;
        sessionId: number;
        result: SchemeResult;
    }>;
    subscriptions: ReadonlyMap<number, ReadonlyArray<{ id: number }>>;
    drains: ReadonlyMap<number, Promise<unknown>>;
}>;

export default class WorkspaceAdmission {
    readonly #db: Db;
    readonly #lifecycle: LoopLifecycle;
    readonly #isAcceptingWork: () => boolean;
    readonly #getSession: (sessionId: number) => SessionProcess;
    readonly #peekSession: (sessionId: number) => SessionProcess | undefined;
    readonly #locks = new Map<number, Promise<unknown>>();

    constructor(args: {
        readonly db: Db;
        readonly lifecycle: LoopLifecycle;
        readonly isAcceptingWork: () => boolean;
        readonly getSession: (sessionId: number) => SessionProcess;
        readonly peekSession: (sessionId: number) => SessionProcess | undefined;
    }) {
        this.#db = args.db;
        this.#lifecycle = args.lifecycle;
        this.#isAcceptingWork = args.isAcceptingWork;
        this.#getSession = args.getSession;
        this.#peekSession = args.peekSession;
    }

    get activeWorkspaceLockCount(): number {
        return this.#locks.size;
    }

    #withLock<T>(workspaceId: number, fn: () => Promise<T>): Promise<T> {
        const prev = this.#locks.get(workspaceId) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        const tail = run.catch(() => {});
        this.#locks.set(workspaceId, tail);
        void tail.then(() => {
            if (this.#locks.get(workspaceId) === tail) this.#locks.delete(workspaceId);
        });
        return run;
    }

    admitMessage(args: DrainInjectionArgs): Promise<AdmittedDelivery> {
        const { workspaceId, sessionId, prompt } = args;
        return this.#withLock(workspaceId, async () => {
            if (!this.#isAcceptingWork()) throw new Error("The daemon is not accepting work.");
            if (args.messageAddress !== undefined) {
                const accepted = await this.#db.message_source_by_address.get<{ loop_id: number; body: string }>({
                    workspace_id: workspaceId,
                    path: args.messageAddress,
                });
                if (accepted !== undefined && accepted.body !== prompt) {
                    throw MessageResources.reused(args.messageAddress, accepted.loop_id);
                }
                if (accepted !== undefined) {
                    throw new OperationFailureError(Results.failure(
                        "daemon:admission",
                        "message-already-accepted",
                        409,
                        "This message address has already been accepted in this workspace.",
                        {},
                        { address: args.messageAddress, loopId: accepted.loop_id, retryable: false },
                    ));
                }
            }
            if (args.sourceLoopId !== undefined) {
                const source = await this.#db.drain_message_source.get<{ workspace_id: number; status: number }>({
                    loop_id: args.sourceLoopId,
                });
                if (source === undefined || source.workspace_id !== workspaceId) {
                    throw new Error(`message source loop ${args.sourceLoopId} does not belong to workspace ${workspaceId}`);
                }
                if (source.status !== 102) {
                    throw new OperationFailureError(Results.failure(
                        "daemon:admission",
                        "source-not-running",
                        409,
                        `The originating task is not running (status ${source.status}); no message was admitted.`,
                        {},
                        { loopId: args.sourceLoopId, sourceStatus: source.status, retryable: false },
                    ));
                }
            }
            return this.#getSession(sessionId).admitDelivery(args);
        });
    }

    prepareCancelTree(
        workspaceId: number,
        rootSessionId: number,
        reason: string,
        includeRoot: boolean,
    ): Promise<PreparedSubtreeCancel> {
        return this.#withLock(workspaceId, async () => {
            const tree = await this.#lifecycle.cancelTree(rootSessionId, reason, includeRoot);
            const openEntries = await Promise.all(
                tree.sessionIds.map(async (id) =>
                    [id, await ChannelWrite.findOpenSubscriptionsForSession(this.#db, id)] as const,
                ),
            );
            const subscriptions = new Map(openEntries);
            const drains = new Map<number, Promise<unknown>>();
            for (const targetSessionId of tree.sessionIds) {
                const openSubs = subscriptions.get(targetSessionId) ?? [];
                const existing = this.#peekSession(targetSessionId);
                if (existing === undefined && openSubs.length === 0) continue;
                const proc = existing ?? this.#getSession(targetSessionId);
                const draining = proc.cancelEpoch(
                    reason,
                    openSubs.map(({ id }) => id),
                );
                if (draining !== undefined) drains.set(targetSessionId, draining);
            }
            return {
                loops: tree.loops,
                subscriptions,
                drains,
            };
        });
    }
}
