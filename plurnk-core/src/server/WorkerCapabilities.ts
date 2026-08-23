export type WorkerCapabilityRelease = () => void;

export interface WorkerCapabilityPolicy {
    readonly warmMs: number;
    readonly warmMax: number;
}

export interface WorkerCapabilityCallbacks {
    readonly activate: (workerId: number) => Promise<void>;
    readonly deactivate: (workerId: number) => Promise<boolean>;
    readonly report: (workerId: number, error: unknown) => void;
}

type WorkerCapabilityPhase = "activating" | "active" | "cooling";

interface WorkerCapabilityState {
    readonly workerId: number;
    phase: WorkerCapabilityPhase;
    leases: number;
    transition: Promise<void> | null;
    idleOrder: number | null;
    timer: NodeJS.Timeout | null;
}

const COOLING_RETRY_MS = 5_000;

const readBound = (env: NodeJS.ProcessEnv, name: string): number => {
    const raw = env[name];
    const value = Number(raw);
    if (raw === undefined || !Number.isSafeInteger(value) || value < -1) {
        throw new Error(`${name} must be -1 or a non-negative safe integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

export const workerCapabilityPolicy = (
    env: NodeJS.ProcessEnv = process.env,
): WorkerCapabilityPolicy => ({
    warmMs: readBound(env, "PLURNK_SERVICE_WORKER_WARM_MS"),
    warmMax: readBound(env, "PLURNK_SERVICE_WORKER_WARM_MAX"),
});

// {§module-worker-residency} — one process-local owner separates durable
// worker identity from optional Functionality residency. Leases represent
// actual work; timers and the idle LRU are availability policy, not identity.
export default class WorkerCapabilities {
    readonly #policy: WorkerCapabilityPolicy;
    readonly #activate: WorkerCapabilityCallbacks["activate"];
    readonly #deactivate: WorkerCapabilityCallbacks["deactivate"];
    readonly #report: WorkerCapabilityCallbacks["report"];
    readonly #states = new Map<number, WorkerCapabilityState>();
    #idleSequence = 0;
    #stopping = false;

    constructor(
        policy: WorkerCapabilityPolicy,
        callbacks: WorkerCapabilityCallbacks,
    ) {
        this.#policy = policy;
        this.#activate = callbacks.activate;
        this.#deactivate = callbacks.deactivate;
        this.#report = callbacks.report;
    }

    async acquire(workerId: number): Promise<WorkerCapabilityRelease> {
        WorkerCapabilities.#assertWorkerId(workerId);
        if (this.#stopping) throw new Error("Worker Functionality is stopping.");

        for (;;) {
            const current = this.#states.get(workerId);
            if (current?.phase === "cooling") {
                await current.transition;
                if (this.#stopping) throw new Error("Worker Functionality is stopping.");
                continue;
            }

            const state = current ?? this.#beginActivation(workerId);
            this.#cancelIdle(state);
            state.leases++;
            try {
                await state.transition;
            } catch (cause) {
                this.#release(state);
                throw cause;
            }
            if (this.#stopping) {
                this.#release(state);
                throw new Error("Worker Functionality is stopping.");
            }
            return this.#releaseOnce(state);
        }
    }

    retain(workerId: number): WorkerCapabilityRelease {
        WorkerCapabilities.#assertWorkerId(workerId);
        if (this.#stopping) throw new Error("Worker Functionality is stopping.");
        const state = this.#states.get(workerId);
        if (state === undefined || state.phase === "cooling") {
            throw new Error(`Worker ${workerId} Functionality is not resident.`);
        }
        this.#cancelIdle(state);
        state.leases++;
        return this.#releaseOnce(state);
    }

    activeWorkerIds(): number[] {
        return [...this.#states.values()]
            .filter(({ phase }) => phase === "active")
            .map(({ workerId }) => workerId)
            .toSorted((left, right) => left - right);
    }

    isActive(workerId: number): boolean {
        return this.#states.get(workerId)?.phase === "active";
    }

    beginStop(): void {
        if (this.#stopping) return;
        this.#stopping = true;
        for (const state of this.#states.values()) this.#cancelIdle(state);
    }

    static #assertWorkerId(workerId: number): void {
        if (!Number.isSafeInteger(workerId) || workerId < 1) {
            throw new Error("Worker Functionality residency requires a positive worker id.");
        }
    }

    #beginActivation(workerId: number): WorkerCapabilityState {
        const state: WorkerCapabilityState = {
            workerId,
            phase: "activating",
            leases: 0,
            transition: null,
            idleOrder: null,
            timer: null,
        };
        this.#states.set(workerId, state);
        state.transition = Promise.resolve()
            .then(() => this.#activate(workerId))
            .then(() => {
                if (this.#states.get(workerId) !== state) return;
                state.phase = "active";
                state.transition = null;
                if (state.leases === 0) this.#markIdle(state);
            })
            .catch((cause: unknown) => {
                if (this.#states.get(workerId) === state) {
                    this.#cancelIdle(state);
                    this.#states.delete(workerId);
                }
                throw cause;
            });
        return state;
    }

    #releaseOnce(state: WorkerCapabilityState): WorkerCapabilityRelease {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#release(state);
        };
    }

    #release(state: WorkerCapabilityState): void {
        if (state.leases === 0) return;
        state.leases--;
        if (
            state.leases === 0
            && state.phase === "active"
            && this.#states.get(state.workerId) === state
            && !this.#stopping
        ) {
            this.#markIdle(state);
        }
    }

    #markIdle(state: WorkerCapabilityState): void {
        if (state.phase !== "active" || state.leases !== 0 || this.#stopping) return;
        this.#cancelIdle(state);
        state.idleOrder = ++this.#idleSequence;
        this.#scheduleCooling(state, this.#policy.warmMs);
        this.#enforceWarmMaximum();
    }

    #scheduleCooling(state: WorkerCapabilityState, delayMs: number): void {
        if (delayMs < 0 || state.phase !== "active" || state.leases !== 0 || this.#stopping) return;
        if (delayMs === 0) {
            queueMicrotask(() => { void this.#cool(state); });
            return;
        }
        state.timer = setTimeout(() => {
            state.timer = null;
            void this.#cool(state);
        }, delayMs);
        state.timer.unref();
    }

    #enforceWarmMaximum(): void {
        if (this.#policy.warmMax < 0 || this.#stopping) return;
        const idle = [...this.#states.values()]
            .filter((state) => state.phase === "active" && state.leases === 0)
            .toSorted((left, right) => (left.idleOrder ?? 0) - (right.idleOrder ?? 0));
        for (const state of idle.slice(0, Math.max(0, idle.length - this.#policy.warmMax))) {
            void this.#cool(state);
        }
    }

    async #cool(state: WorkerCapabilityState): Promise<void> {
        if (
            this.#stopping
            || state.phase !== "active"
            || state.leases !== 0
            || this.#states.get(state.workerId) !== state
        ) return;
        this.#cancelIdle(state);
        state.phase = "cooling";
        const transition = Promise.resolve()
            .then(() => this.#deactivate(state.workerId))
            .then((cooled) => {
                if (this.#states.get(state.workerId) !== state) return;
                if (cooled) {
                    this.#states.delete(state.workerId);
                    return;
                }
                state.phase = "active";
                state.transition = null;
                state.idleOrder = ++this.#idleSequence;
                this.#scheduleCooling(state, COOLING_RETRY_MS);
            })
            .catch((cause: unknown) => {
                if (this.#states.get(state.workerId) !== state) return;
                state.phase = "active";
                state.transition = null;
                state.idleOrder = ++this.#idleSequence;
                this.#report(state.workerId, cause);
                this.#scheduleCooling(state, COOLING_RETRY_MS);
            });
        state.transition = transition;
        await transition;
    }

    #cancelIdle(state: WorkerCapabilityState): void {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.idleOrder = null;
    }
}
