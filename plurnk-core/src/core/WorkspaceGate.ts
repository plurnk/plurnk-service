type Release = () => void;

type TurnRequest = {
    workerId: number;
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
    setRoot(workerId: number | null): void;
    release(): void;
}

// Fair workspace reader/writer gate for serialized Git branch batches.
// Ordinary turns share the workspace. Once an exclusive request is queued,
// later turns wait behind it. While exclusive, only one turn at a time from
// the selected branch worker's lineage may run.
export default class WorkspaceGate {
    readonly #isDescendant: (workerId: number, rootWorkerId: number) => Promise<boolean>;
    readonly #states = new Map<number, WorkspaceState>();

    constructor(isDescendant: (workerId: number, rootWorkerId: number) => Promise<boolean>) {
        this.#isDescendant = isDescendant;
    }

    acquireTurn(workspaceId: number, workerId: number): Promise<Release> {
        const state = this.#state(workspaceId);
        return new Promise<Release>((resolve, reject) => {
            state.turns.push({ workerId, resolve, reject });
            this.#requestPump(workspaceId, state);
        });
    }

    requestExclusive(workspaceId: number): WorkspaceExclusive {
        const state = this.#state(workspaceId);
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const acquired = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const request = { resolve, reject };
        state.writers.push(request);
        this.#requestPump(workspaceId, state);
        let held = true;
        return {
            acquired,
            setRoot: (workerId) => {
                if (!state.exclusive || state.writers.includes(request)) {
                    throw new Error("Workspace exclusive root cannot change before the gate is acquired");
                }
                if (!held) throw new Error("Workspace exclusive gate has already been released");
                if (state.exclusiveTurns !== 0) {
                    throw new Error("Workspace exclusive root cannot change during an active turn");
                }
                state.exclusiveRoot = workerId;
                this.#requestPump(workspaceId, state);
            },
            release: () => {
                if (!held) return;
                held = false;
                if (!state.exclusive) {
                    const index = state.writers.indexOf(request);
                    if (index >= 0) {
                        state.writers.splice(index, 1);
                        reject(new Error("Workspace exclusive request was released before acquisition"));
                        this.#requestPump(workspaceId, state);
                        return;
                    }
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
            setRoot: (workerId) => {
                if (!held) throw new Error("Workspace exclusive gate has already been released");
                if (state.exclusiveTurns !== 0) {
                    throw new Error("Workspace exclusive root cannot change during an active turn");
                }
                state.exclusiveRoot = workerId;
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
                for (let index = 0; index < state.turns.length; index++) {
                    const request = state.turns[index];
                    if (!await this.#isDescendant(request.workerId, state.exclusiveRoot)) continue;
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
