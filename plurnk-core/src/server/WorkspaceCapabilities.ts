export type WorkspaceCapabilityRelease = () => void;

export interface WorkspaceCapabilityPolicy {
    readonly warmMs: number;
    readonly warmMax: number;
}

export interface WorkspaceCapabilityCallbacks {
    readonly activate: (workspaceId: number) => Promise<void>;
    readonly deactivate: (workspaceId: number) => Promise<boolean>;
    readonly report: (workspaceId: number, error: unknown) => void;
}

type WorkspaceCapabilityPhase = "activating" | "active" | "cooling";

interface WorkspaceCapabilityState {
    readonly workspaceId: number;
    phase: WorkspaceCapabilityPhase;
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

export const workspaceCapabilityPolicy = (
    env: NodeJS.ProcessEnv = process.env,
): WorkspaceCapabilityPolicy => ({
    warmMs: readBound(env, "PLURNK_SERVICE_WORKSPACE_WARM_MS"),
    warmMax: readBound(env, "PLURNK_SERVICE_WORKSPACE_WARM_MAX"),
});

// {§module-workspace-residency} — one process-local owner separates durable
// workspace identity from optional capability residency. Leases represent
// actual work; timers and the idle LRU are availability policy, not identity.
export default class WorkspaceCapabilities {
    readonly #policy: WorkspaceCapabilityPolicy;
    readonly #activate: WorkspaceCapabilityCallbacks["activate"];
    readonly #deactivate: WorkspaceCapabilityCallbacks["deactivate"];
    readonly #report: WorkspaceCapabilityCallbacks["report"];
    readonly #states = new Map<number, WorkspaceCapabilityState>();
    #idleSequence = 0;
    #stopping = false;

    constructor(
        policy: WorkspaceCapabilityPolicy,
        callbacks: WorkspaceCapabilityCallbacks,
    ) {
        this.#policy = policy;
        this.#activate = callbacks.activate;
        this.#deactivate = callbacks.deactivate;
        this.#report = callbacks.report;
    }

    async acquire(workspaceId: number): Promise<WorkspaceCapabilityRelease> {
        WorkspaceCapabilities.#assertWorkspaceId(workspaceId);
        if (this.#stopping) throw new Error("Workspace capabilities are stopping.");

        for (;;) {
            const current = this.#states.get(workspaceId);
            if (current?.phase === "cooling") {
                await current.transition;
                if (this.#stopping) throw new Error("Workspace capabilities are stopping.");
                continue;
            }

            const state = current ?? this.#beginActivation(workspaceId);
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
                throw new Error("Workspace capabilities are stopping.");
            }
            return this.#releaseOnce(state);
        }
    }

    retain(workspaceId: number): WorkspaceCapabilityRelease {
        WorkspaceCapabilities.#assertWorkspaceId(workspaceId);
        if (this.#stopping) throw new Error("Workspace capabilities are stopping.");
        const state = this.#states.get(workspaceId);
        if (state === undefined || state.phase === "cooling") {
            throw new Error(`Workspace ${workspaceId} capabilities are not resident.`);
        }
        this.#cancelIdle(state);
        state.leases++;
        return this.#releaseOnce(state);
    }

    activeWorkspaceIds(): number[] {
        return [...this.#states.values()]
            .filter(({ phase }) => phase === "active")
            .map(({ workspaceId }) => workspaceId)
            .toSorted((left, right) => left - right);
    }

    isActive(workspaceId: number): boolean {
        return this.#states.get(workspaceId)?.phase === "active";
    }

    beginStop(): void {
        if (this.#stopping) return;
        this.#stopping = true;
        for (const state of this.#states.values()) this.#cancelIdle(state);
    }

    static #assertWorkspaceId(workspaceId: number): void {
        if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) {
            throw new Error("Workspace capability residency requires a positive workspace id.");
        }
    }

    #beginActivation(workspaceId: number): WorkspaceCapabilityState {
        const state: WorkspaceCapabilityState = {
            workspaceId,
            phase: "activating",
            leases: 0,
            transition: null,
            idleOrder: null,
            timer: null,
        };
        this.#states.set(workspaceId, state);
        state.transition = Promise.resolve()
            .then(() => this.#activate(workspaceId))
            .then(() => {
                if (this.#states.get(workspaceId) !== state) return;
                state.phase = "active";
                state.transition = null;
                if (state.leases === 0) this.#markIdle(state);
            })
            .catch((cause: unknown) => {
                if (this.#states.get(workspaceId) === state) {
                    this.#cancelIdle(state);
                    this.#states.delete(workspaceId);
                }
                throw cause;
            });
        return state;
    }

    #releaseOnce(state: WorkspaceCapabilityState): WorkspaceCapabilityRelease {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#release(state);
        };
    }

    #release(state: WorkspaceCapabilityState): void {
        if (state.leases === 0) return;
        state.leases--;
        if (
            state.leases === 0
            && state.phase === "active"
            && this.#states.get(state.workspaceId) === state
            && !this.#stopping
        ) {
            this.#markIdle(state);
        }
    }

    #markIdle(state: WorkspaceCapabilityState): void {
        if (state.phase !== "active" || state.leases !== 0 || this.#stopping) return;
        this.#cancelIdle(state);
        state.idleOrder = ++this.#idleSequence;
        this.#scheduleCooling(state, this.#policy.warmMs);
        this.#enforceWarmMaximum();
    }

    #scheduleCooling(state: WorkspaceCapabilityState, delayMs: number): void {
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

    async #cool(state: WorkspaceCapabilityState): Promise<void> {
        if (
            this.#stopping
            || state.phase !== "active"
            || state.leases !== 0
            || this.#states.get(state.workspaceId) !== state
        ) return;
        this.#cancelIdle(state);
        state.phase = "cooling";
        const transition = Promise.resolve()
            .then(() => this.#deactivate(state.workspaceId))
            .then((cooled) => {
                if (this.#states.get(state.workspaceId) !== state) return;
                if (cooled) {
                    this.#states.delete(state.workspaceId);
                    return;
                }
                state.phase = "active";
                state.transition = null;
                state.idleOrder = ++this.#idleSequence;
                this.#scheduleCooling(state, COOLING_RETRY_MS);
            })
            .catch((cause: unknown) => {
                if (this.#states.get(state.workspaceId) !== state) return;
                state.phase = "active";
                state.transition = null;
                state.idleOrder = ++this.#idleSequence;
                this.#report(state.workspaceId, cause);
                this.#scheduleCooling(state, COOLING_RETRY_MS);
            });
        state.transition = transition;
        await transition;
    }

    #cancelIdle(state: WorkspaceCapabilityState): void {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.idleOrder = null;
    }
}
