type Release = () => void;

type Waiter = {
    readonly signal: AbortSignal;
    readonly resolve: (release: Release) => void;
    readonly onAbort: () => void;
};

type WorkspaceState = {
    active: number;
    readonly queue: Waiter[];
};

export type ExecAdmission = {
    readonly queued: boolean;
    readonly executionsAhead: number;
    readonly concurrency: number;
    readonly ready: Promise<Release>;
};

const isConcurrency = (value: number): boolean =>
    value === -1 || (Number.isSafeInteger(value) && value >= 1);

export const readExecConcurrency = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env.PLURNK_SERVICE_EXEC_CONCURRENCY;
    const value = raw === undefined || raw.trim().length === 0 ? Number.NaN : Number(raw);
    if (isConcurrency(value)) return value;
    throw new RangeError(
        `PLURNK_SERVICE_EXEC_CONCURRENCY must be -1 (unbounded) or a positive safe integer; got ${JSON.stringify(raw)}.`,
    );
};

// {§exec-concurrency} One FIFO per workspace. A reservation is synchronous so
// its operation receipt can state whether it started or queued; execution waits
// only on `ready`, while the durable stream/subscription already exists.
export default class ExecScheduler {
    readonly #concurrency: number;
    readonly #workspaces = new Map<number, WorkspaceState>();

    constructor(concurrency = readExecConcurrency()) {
        if (!isConcurrency(concurrency)) {
            throw new RangeError("EXEC concurrency must be -1 (unbounded) or a positive safe integer.");
        }
        this.#concurrency = concurrency;
    }

    admit(workspaceId: number, signal: AbortSignal): ExecAdmission {
        if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) {
            throw new RangeError("EXEC scheduling requires a positive workspace id.");
        }
        if (this.#concurrency === -1) {
            return {
                queued: false,
                executionsAhead: 0,
                concurrency: -1,
                ready: Promise.resolve(() => {}),
            };
        }

        const state = this.#workspaces.get(workspaceId) ?? { active: 0, queue: [] };
        this.#workspaces.set(workspaceId, state);
        if (state.active < this.#concurrency) {
            state.active += 1;
            return {
                queued: false,
                executionsAhead: 0,
                concurrency: this.#concurrency,
                ready: Promise.resolve(this.#release(workspaceId, state)),
            };
        }

        const executionsAhead = state.active + state.queue.length;
        const deferred = Promise.withResolvers<Release>();
        let waiter: Waiter;
        const onAbort = (): void => {
            const index = state.queue.indexOf(waiter);
            if (index === -1) return;
            state.queue.splice(index, 1);
            signal.removeEventListener("abort", onAbort);
            deferred.resolve(() => {});
            this.#forgetEmpty(workspaceId, state);
        };
        waiter = { signal, resolve: deferred.resolve, onAbort };
        state.queue.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        return {
            queued: true,
            executionsAhead,
            concurrency: this.#concurrency,
            ready: deferred.promise,
        };
    }

    #release(workspaceId: number, state: WorkspaceState): Release {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            while (state.queue.length > 0) {
                const next = state.queue.shift()!;
                next.signal.removeEventListener("abort", next.onAbort);
                if (next.signal.aborted) {
                    next.resolve(() => {});
                    continue;
                }
                // The active slot transfers directly to the oldest waiter.
                next.resolve(this.#release(workspaceId, state));
                return;
            }
            state.active -= 1;
            this.#forgetEmpty(workspaceId, state);
        };
    }

    #forgetEmpty(workspaceId: number, state: WorkspaceState): void {
        if (state.active === 0 && state.queue.length === 0) {
            this.#workspaces.delete(workspaceId);
        }
    }
}
