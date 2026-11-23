import { MAX_TIMER_MS } from "@plurnk/plurnk-contracts";
import type {
    InferenceLaneAcquireOptions,
    InferenceLaneHandoff,
    InferenceLaneLease,
    InferenceLaneQueueState,
} from "./types.ts";

export interface InferenceAdmissionOptions {
    readonly configuredLimit?: number;
    readonly generation?: number;
}

export interface InferenceAdmissionAcquireOptions extends InferenceLaneAcquireOptions {
    readonly burstMs?: number;
    readonly handoffMs?: number;
}

interface QueuedWaiter {
    readonly sessionId: string | undefined;
    readonly model: string | undefined;
    readonly onQueueChange: ((state: InferenceLaneQueueState) => void) | undefined;
    readonly enter: () => void;
    lastPosition: number;
    lastDepth: number;
}

interface LaneReservation {
    readonly sessionId: string;
    readonly burstMs: number;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly expire: () => void;
}

interface ModelCooldown {
    readonly until: number;
    readonly timer: ReturnType<typeof setTimeout>;
}

const MAX_COOLDOWN_MS = 60_000;

const assertValidLimit = (limit: number): void => {
    if (!Number.isSafeInteger(limit) || (limit !== -1 && limit < 1)) {
        throw new TypeError("PLURNK_PROVIDERS_MAX_CONCURRENCY must be -1 or a positive safe integer");
    }
};

const assertValidBurstMs = (burstMs: number): void => {
    if (!Number.isSafeInteger(burstMs) || (burstMs !== -1 && (burstMs < 0 || burstMs > MAX_TIMER_MS))) {
        throw new TypeError(`PLURNK_PROVIDERS_LANE_BURST_MS must be -1 or an integer from 0 through ${MAX_TIMER_MS}`);
    }
};

const assertValidHandoffMs = (handoffMs: number): void => {
    if (!Number.isSafeInteger(handoffMs) || handoffMs < 0 || handoffMs > MAX_TIMER_MS) {
        throw new TypeError(`PLURNK_PROVIDERS_LANE_HANDOFF_MS must be an integer from 0 through ${MAX_TIMER_MS}`);
    }
};

// {§provider-inference-admission} One process-local lane scheduler per canonical endpoint.
export default class InferenceAdmission {
    static readonly #endpoints = new Map<string, InferenceAdmission>();
    static #currentGeneration = 0;

    #limit: number;
    #configuredLimit: number;
    #generation: number;
    readonly #waiting = new Set<QueuedWaiter>();
    readonly #reservations = new Map<string, LaneReservation>();
    readonly #burstStartedAt = new Map<string, number>();
    readonly #activeBySession = new Map<string, number>();
    readonly #modelCooldowns = new Map<string, ModelCooldown>();
    #active = 0;

    static get currentGeneration(): number {
        return this.#currentGeneration;
    }

    // Advance the configuration generation monotonically on operator environment reload so live
    // endpoints resize in place while conflicting aliases within the same generation still fail fast.
    static advanceGeneration(generation?: number): number {
        if (generation === undefined) {
            this.#currentGeneration += 1;
            return this.#currentGeneration;
        }
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("InferenceAdmission generation must be a non-negative safe integer");
        }
        if (generation > this.#currentGeneration) {
            this.#currentGeneration = generation;
        }
        return this.#currentGeneration;
    }

    static forEndpoint(
        endpoint: string,
        limit: number,
        options?: InferenceAdmissionOptions,
    ): InferenceAdmission {
        assertValidLimit(limit);
        const configuredLimit = options?.configuredLimit ?? limit;
        assertValidLimit(configuredLimit);
        const generation = options?.generation ?? this.#currentGeneration;
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("InferenceAdmission generation must be a non-negative safe integer");
        }
        const key = new URL(endpoint).href.replace(/\/+$/, "");
        const existing = this.#endpoints.get(key);
        if (existing !== undefined) {
            if (generation > existing.#generation) {
                existing.#generation = generation;
                existing.#configuredLimit = configuredLimit;
                existing.#resize(limit);
                return existing;
            }
            if (existing.#limit === limit) {
                if (configuredLimit !== -1) existing.#configuredLimit = configuredLimit;
                return existing;
            }
            // Same operator policy on a restarted endpoint whose probed physical slot count changed.
            if (existing.#configuredLimit === configuredLimit) {
                existing.#resize(limit);
                return existing;
            }
            throw new TypeError(
                `Provider aliases resolving to ${key} have conflicting PLURNK_PROVIDERS_MAX_CONCURRENCY values ${existing.#limit} and ${limit}; one endpoint has one allowance`,
            );
        }
        const admission = new InferenceAdmission(limit, configuredLimit, generation);
        this.#endpoints.set(key, admission);
        return admission;
    }

    private constructor(limit: number, configuredLimit: number, generation: number) {
        this.#limit = limit;
        this.#configuredLimit = configuredLimit;
        this.#generation = generation;
    }

    get limit(): number {
        return this.#limit;
    }

    get activeCount(): number {
        return this.#active;
    }

    get reservedCount(): number {
        return this.#reservations.size;
    }

    get waitingCount(): number {
        return this.#waiting.size;
    }

    noteRateLimit(model: string, delayMs: number): void {
        if (!Number.isFinite(delayMs) || delayMs <= 0) return;
        const clamped = Math.min(Math.ceil(delayMs), MAX_COOLDOWN_MS);
        const until = performance.now() + clamped;
        const existing = this.#modelCooldowns.get(model);
        if (existing !== undefined && existing.until >= until) return;
        if (existing !== undefined) clearTimeout(existing.timer);
        const timer = setTimeout(() => {
            if (this.#modelCooldowns.get(model)?.timer === timer) {
                this.#modelCooldowns.delete(model);
                this.#drainQueue();
            }
        }, clamped);
        timer.unref();
        this.#modelCooldowns.set(model, { until, timer });
    }

    #isModelCoolingDown(model: string | undefined): boolean {
        if (model === undefined) return false;
        const entry = this.#modelCooldowns.get(model);
        if (entry === undefined) return false;
        if (performance.now() >= entry.until) {
            clearTimeout(entry.timer);
            this.#modelCooldowns.delete(model);
            return false;
        }
        return true;
    }

    #isBurstExpired(sessionId: string, burstMs: number): boolean {
        if (burstMs === 0) return true;
        if (burstMs === -1) return false;
        const startedAt = this.#burstStartedAt.get(sessionId);
        if (startedAt === undefined) return false;
        return performance.now() - startedAt >= burstMs;
    }

    #evictExpiredReservations(forOtherSessionId: string | undefined): void {
        for (const [sid, reservation] of [...this.#reservations]) {
            if (sid === forOtherSessionId) continue;
            if (this.#isBurstExpired(sid, reservation.burstMs)) {
                clearTimeout(reservation.timer);
                this.#reservations.delete(sid);
                this.#burstStartedAt.delete(sid);
            }
        }
    }

    #resize(limit: number): void {
        this.#limit = limit;
        if (this.#limit === -1) {
            for (const [sid, reservation] of [...this.#reservations]) {
                clearTimeout(reservation.timer);
                this.#reservations.delete(sid);
                this.#burstStartedAt.delete(sid);
            }
        } else {
            for (const [sid, reservation] of [...this.#reservations]) {
                if (this.#active + this.#reservations.size <= this.#limit) break;
                clearTimeout(reservation.timer);
                this.#reservations.delete(sid);
                this.#burstStartedAt.delete(sid);
            }
        }
        this.#drainQueue();
    }

    #hasCapacity(): boolean {
        return this.#limit === -1 || this.#active + this.#reservations.size < this.#limit;
    }

    #notifyWaiters(): void {
        const depth = this.#waiting.size;
        let position = 0;
        for (const waiter of this.#waiting) {
            position += 1;
            if (waiter.onQueueChange === undefined) continue;
            if (waiter.lastPosition === position && waiter.lastDepth === depth) continue;
            waiter.lastPosition = position;
            waiter.lastDepth = depth;
            waiter.onQueueChange({
                queuePosition: position,
                queueDepth: depth,
                activeCount: this.#active,
                reservedCount: this.#reservations.size,
                laneLimit: this.#limit,
            });
        }
    }

    #drainQueue(): void {
        let progressed = true;
        while (progressed && this.#waiting.size > 0 && this.#hasCapacity()) {
            progressed = false;
            for (const waiter of this.#waiting) {
                if (this.#isModelCoolingDown(waiter.model)) continue;
                this.#waiting.delete(waiter);
                waiter.enter();
                progressed = true;
                break;
            }
        }
        if (this.#waiting.size > 0) this.#notifyWaiters();
    }

    #incrementSessionActive(sessionId: string | undefined, reclaimed: boolean): void {
        this.#active += 1;
        if (sessionId === undefined) return;
        this.#activeBySession.set(sessionId, (this.#activeBySession.get(sessionId) ?? 0) + 1);
        if (!reclaimed && !this.#burstStartedAt.has(sessionId)) {
            this.#burstStartedAt.set(sessionId, performance.now());
        }
    }

    #decrementSessionActive(sessionId: string | undefined, keepBurst: boolean): void {
        this.#active -= 1;
        if (sessionId === undefined) return;
        const remaining = (this.#activeBySession.get(sessionId) ?? 1) - 1;
        if (remaining <= 0) {
            this.#activeBySession.delete(sessionId);
            if (!keepBurst && !this.#reservations.has(sessionId)) {
                this.#burstStartedAt.delete(sessionId);
            }
        } else {
            this.#activeBySession.set(sessionId, remaining);
        }
    }

    #enterSlot(options: {
        readonly sessionId: string | undefined;
        readonly model: string | undefined;
        readonly burstMs: number;
        readonly handoffMs: number;
        readonly signal: AbortSignal | undefined;
        readonly onQueueChange: ((state: InferenceLaneQueueState) => void) | undefined;
    }): Promise<void> {
        const { sessionId, model, signal, onQueueChange } = options;
        signal?.throwIfAborted();
        return new Promise<void>((resolve, reject) => {
            const cooling = this.#isModelCoolingDown(model);

            // Fast path 1: reclaim this session's warm inter-turn handoff reservation.
            if (!cooling && sessionId !== undefined) {
                const reservation = this.#reservations.get(sessionId);
                if (reservation !== undefined) {
                    clearTimeout(reservation.timer);
                    this.#reservations.delete(sessionId);
                    this.#incrementSessionActive(sessionId, true);
                    resolve();
                    return;
                }
            }

            // If another session's reservation has already exhausted its burst budget,
            // evict it now so an arriving peer does not wait for an expired handoff timer.
            if (!cooling && !this.#hasCapacity()) {
                this.#evictExpiredReservations(sessionId);
            }

            // Fast path 2: immediate free physical capacity with no eligible waiter ahead.
            let eligibleWaiterAhead = false;
            if (this.#waiting.size > 0) {
                for (const candidate of this.#waiting) {
                    if (!this.#isModelCoolingDown(candidate.model)) {
                        eligibleWaiterAhead = true;
                        break;
                    }
                }
            }
            if (!cooling && this.#hasCapacity() && !eligibleWaiterAhead) {
                this.#incrementSessionActive(sessionId, false);
                resolve();
                return;
            }

            const onAbort = (): void => {
                this.#waiting.delete(waiter);
                this.#drainQueue();
                reject(signal!.reason);
            };
            const waiter: QueuedWaiter = {
                sessionId,
                model,
                onQueueChange,
                lastPosition: 0,
                lastDepth: 0,
                enter: () => {
                    signal?.removeEventListener("abort", onAbort);
                    this.#incrementSessionActive(sessionId, false);
                    resolve();
                },
            };
            this.#waiting.add(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
            this.#notifyWaiters();
        });
    }

    async acquire(options?: InferenceAdmissionAcquireOptions): Promise<InferenceLaneLease> {
        const burstMs = options?.burstMs ?? 0;
        const handoffMs = options?.handoffMs ?? 0;
        assertValidBurstMs(burstMs);
        assertValidHandoffMs(handoffMs);
        const sessionId = options?.sessionId;
        const model = options?.model;

        await this.#enterSlot({
            sessionId,
            model,
            burstMs,
            handoffMs,
            signal: options?.signal,
            onQueueChange: options?.onQueueChange,
        });

        let state: "active" | "suspended" | "handed_off" | "released" = "active";

        const lease: InferenceLaneLease = {
            gate: this,
            get active(): boolean {
                return state === "active";
            },
            release: (): void => {
                if (state === "released" || state === "handed_off") {
                    throw new Error("Inference admission lease was released twice");
                }
                if (state === "suspended") {
                    state = "released";
                    return;
                }
                state = "released";
                this.#decrementSessionActive(sessionId, false);
                this.#drainQueue();
            },
            handoff: (): InferenceLaneHandoff => {
                if (state !== "active") {
                    throw new Error("Inference admission lease was released twice");
                }
                state = "handed_off";
                const burstExpired = sessionId === undefined || this.#isBurstExpired(sessionId, burstMs);
                const canReserve =
                    this.#limit !== -1
                    && sessionId !== undefined
                    && handoffMs > 0
                    && burstMs !== 0
                    && !(burstExpired && this.#waiting.size > 0)
                    && !this.#reservations.has(sessionId)
                    && this.#active - 1 + this.#reservations.size < this.#limit;

                if (!canReserve) {
                    this.#decrementSessionActive(sessionId, false);
                    this.#drainQueue();
                    return { gate: this, yield: (): void => {} };
                }

                // Keep burst timestamp intact across fast inter-turn hops so a long solo loop
                // yields promptly at its next boundary if an interactive peer arrives.
                this.#decrementSessionActive(sessionId, true);
                let yielded = false;
                const expire = (): void => {
                    if (yielded) return;
                    yielded = true;
                    const current = this.#reservations.get(sessionId);
                    if (current !== reservation) return;
                    clearTimeout(reservation.timer);
                    this.#reservations.delete(sessionId);
                    if (!this.#activeBySession.has(sessionId)) {
                        this.#burstStartedAt.delete(sessionId);
                    }
                    this.#drainQueue();
                };
                const timer = setTimeout(expire, handoffMs);
                timer.unref();
                const reservation: LaneReservation = {
                    sessionId,
                    burstMs,
                    timer,
                    expire,
                };
                this.#reservations.set(sessionId, reservation);
                return { gate: this, yield: expire };
            },
            suspend: async (
                during: () => Promise<void>,
                signal?: AbortSignal,
                onQueueChange?: (queueState: InferenceLaneQueueState) => void,
            ): Promise<void> => {
                if (state !== "active") {
                    throw new Error("Inference admission lease cannot suspend when not active");
                }
                state = "suspended";
                this.#decrementSessionActive(sessionId, false);
                this.#drainQueue();
                await during();
                await this.#enterSlot({
                    sessionId,
                    model,
                    burstMs,
                    handoffMs,
                    signal,
                    onQueueChange,
                });
                state = "active";
            },
        };
        return lease;
    }
}
