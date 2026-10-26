import { AsyncLocalStorage } from "node:async_hooks";

type Release = () => void;
type TurnScope = { workspaceId: number; sessionId: number; signal?: AbortSignal; release: Release | null; closed: boolean };

type TurnRequest = {
    sessionId: number;
    resolve: (release: Release) => void;
    reject: (error: unknown) => void;
};

type ExclusiveRequest = {
    resolve: () => void;
    reject: (error: unknown) => void;
};

type WorkspaceState = {
    readers: number;
    exclusive: boolean;
    exclusiveTurns: number;
    exclusiveRoot: number | null;
    writers: ExclusiveRequest[];
    turns: TurnRequest[];
    pumping: boolean;
};

export interface WorkspaceExclusive {
    readonly acquired: Promise<void>;
    setRoot(sessionId: number | null): void;
    release(): void;
}

// Fair workspace reader/writer gate. Ordinary turns share the workspace. Once an
// exclusive request is queued (a workspace capability mutation), later turns
// wait behind it. While exclusive, only one turn at a time from the exclusive
// root session's lineage may run.
export default class WorkspaceGate {
    readonly #isDescendant: (sessionId: number, rootSessionId: number) => Promise<boolean>;
    readonly #states = new Map<number, WorkspaceState>();
    readonly #turnScope = new AsyncLocalStorage<TurnScope | undefined>();

    constructor(isDescendant: (sessionId: number, rootSessionId: number) => Promise<boolean>) {
        this.#isDescendant = isDescendant;
    }

    // {§functionality-model-mutation} The lease belongs to this awaited turn, not
    // callbacks or background producers that happen to originate inside it.
    async withTurn<T>(workspaceId: number, sessionId: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const scope: TurnScope = { workspaceId, sessionId, signal, release: await this.acquireTurn(workspaceId, sessionId, signal), closed: false };
        try { return await this.#turnScope.run(scope, run); }
        finally { scope.closed = true; scope.release?.(); scope.release = null; }
    }

    async atBoundary<T>(workspaceId: number, run: () => Promise<T>): Promise<T> {
        const scope = this.#turnScope.getStore();
        if (scope === undefined || scope.closed) return run();
        if (scope.workspaceId !== workspaceId) throw new Error("A configuration operation cannot yield another workspace's turn");
        if (scope.release === null) throw new Error("The workspace turn has already yielded its lease");
        scope.release();
        scope.release = null;
        try { return await this.#turnScope.run(undefined, run); }
        finally {
            // Cancellation ends the program; cleanup does not need a new read lease.
            if (!scope.signal?.aborted) scope.release = await this.acquireTurn(workspaceId, scope.sessionId, scope.signal);
        }
    }

    acquireTurn(workspaceId: number, sessionId: number, signal?: AbortSignal): Promise<Release> {
        if (signal?.aborted === true) return Promise.reject(signal.reason);
        const state = this.#state(workspaceId);
        return new Promise<Release>((resolve, reject) => {
            const clear = (): void => signal?.removeEventListener("abort", cancel);
            const request = {
                sessionId,
                resolve: (release: Release) => { clear(); resolve(release); },
                reject: (error: unknown) => { clear(); reject(error); },
            };
            const cancel = (): void => {
                const index = state.turns.indexOf(request);
                if (index < 0) return;
                state.turns.splice(index, 1);
                request.reject(signal?.reason);
                this.#requestPump(workspaceId, state);
            };
            signal?.addEventListener("abort", cancel, { once: true });
            state.turns.push(request);
            this.#requestPump(workspaceId, state);
        });
    }

    requestExclusive(workspaceId: number, signal?: AbortSignal): WorkspaceExclusive {
        signal?.throwIfAborted();
        const state = this.#state(workspaceId);
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const acquired = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        let held = true;
        const clear = (): void => signal?.removeEventListener("abort", cancel);
        const request = {
            resolve: () => { clear(); resolve(); },
            reject: (cause: unknown) => { clear(); reject(cause); },
        };
        const cancel = (): void => {
            const index = state.writers.indexOf(request);
            if (index < 0) return;
            held = false;
            state.writers.splice(index, 1);
            request.reject(signal?.reason);
            this.#requestPump(workspaceId, state);
        };
        signal?.addEventListener("abort", cancel, { once: true });
        state.writers.push(request);
        this.#requestPump(workspaceId, state);
        return {
            acquired,
            setRoot: (sessionId) => {
                if (!state.exclusive || state.writers.includes(request)) {
                    throw new Error("Workspace exclusive root cannot change before the gate is acquired");
                }
                if (!held) throw new Error("Workspace exclusive gate has already been released");
                if (state.exclusiveTurns !== 0) {
                    throw new Error("Workspace exclusive root cannot change during an active turn");
                }
                state.exclusiveRoot = sessionId;
                this.#requestPump(workspaceId, state);
            },
            release: () => {
                if (!held) return;
                held = false;
                const index = state.writers.indexOf(request);
                if (index >= 0) {
                    state.writers.splice(index, 1);
                    request.reject(new Error("Workspace exclusive request was released before acquisition"));
                    this.#requestPump(workspaceId, state);
                    return;
                }
                if (!state.exclusive) {
                    throw new Error("Workspace exclusive gate is not held");
                }
                if (state.exclusiveTurns !== 0) {
                    throw new Error("Workspace exclusive gate cannot release during an active turn");
                }
                state.exclusive = false;
                state.exclusiveRoot = null;
                this.#requestPump(workspaceId, state);
            },
        };
    }

    // Capability snapshots cannot wait behind a proposal that may require the
    // very client issuing the mutation. Acquire synchronously only at a fully
    // quiescent boundary; otherwise the caller returns 409 and retries after
    // settling current work. {§module-workspace-quiescence}
    tryExclusive(workspaceId: number): WorkspaceExclusive | null {
        const state = this.#state(workspaceId);
        if (
            state.readers !== 0
            || state.exclusive
            || state.exclusiveTurns !== 0
            || state.writers.length !== 0
            || state.turns.length !== 0
        ) return null;
        state.exclusive = true;
        let held = true;
        return {
            acquired: Promise.resolve(),
            setRoot: (sessionId) => {
                if (!held) throw new Error("Workspace exclusive gate has already been released");
                if (state.exclusiveTurns !== 0) {
                    throw new Error("Workspace exclusive root cannot change during an active turn");
                }
                state.exclusiveRoot = sessionId;
                this.#requestPump(workspaceId, state);
            },
            release: () => {
                if (!held) return;
                held = false;
                if (state.exclusiveTurns !== 0) {
                    throw new Error("Workspace exclusive gate cannot release during an active turn");
                }
                state.exclusive = false;
                state.exclusiveRoot = null;
                this.#prune(workspaceId, state);
                this.#requestPump(workspaceId, state);
            },
        };
    }

    async #pump(workspaceId: number, state: WorkspaceState): Promise<void> {
        if (state.pumping) return;
        state.pumping = true;
        try {
            if (state.exclusive) {
                if (state.exclusiveTurns !== 0 || state.exclusiveRoot === null) return;
                for (const request of [...state.turns]) {
                    const root: number = state.exclusiveRoot;
                    const allowed = await this.#isDescendant(request.sessionId, root);
                    if (!state.exclusive || state.exclusiveRoot !== root) {
                        this.#requestPump(workspaceId, state);
                        return;
                    }
                    const index = state.turns.indexOf(request);
                    if (index < 0 || !allowed) continue;
                    state.turns.splice(index, 1);
                    state.exclusiveTurns = 1;
                    request.resolve(() => {
                        if (state.exclusiveTurns !== 1) throw new Error("Workspace exclusive turn released twice");
                        state.exclusiveTurns = 0;
                        this.#requestPump(workspaceId, state);
                    });
                    return;
                }
                return;
            }

            if (state.writers.length > 0) {
                if (state.readers !== 0) return;
                state.exclusive = true;
                state.exclusiveRoot = null;
                state.writers.shift()?.resolve();
                return;
            }

            const requests = state.turns.splice(0);
            for (const request of requests) {
                state.readers++;
                let held = true;
                request.resolve(() => {
                    if (!held) throw new Error("Workspace turn gate released twice");
                    held = false;
                    state.readers--;
                    this.#requestPump(workspaceId, state);
                });
            }
            this.#prune(workspaceId, state);
        } catch (error) {
            for (const request of state.turns.splice(0)) request.reject(error);
            for (const request of state.writers.splice(0)) request.reject(error);
        } finally {
            state.pumping = false;
        }
    }

    #requestPump(workspaceId: number, state: WorkspaceState): void {
        if (state.pumping) {
            queueMicrotask(() => { void this.#pump(workspaceId, state); });
            return;
        }
        void this.#pump(workspaceId, state);
    }

    #state(workspaceId: number): WorkspaceState {
        const existing = this.#states.get(workspaceId);
        if (existing !== undefined) return existing;
        const state: WorkspaceState = {
            readers: 0,
            exclusive: false,
            exclusiveTurns: 0,
            exclusiveRoot: null,
            writers: [],
            turns: [],
            pumping: false,
        };
        this.#states.set(workspaceId, state);
        return state;
    }

    #prune(workspaceId: number, state: WorkspaceState): void {
        if (
            state.readers === 0
            && !state.exclusive
            && state.writers.length === 0
            && state.turns.length === 0
        ) {
            this.#states.delete(workspaceId);
        }
    }
}
