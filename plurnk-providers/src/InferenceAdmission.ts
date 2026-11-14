export interface InferenceAdmissionOptions {
    readonly configuredLimit?: number;
    readonly generation?: number;
}

const assertValidLimit = (limit: number): void => {
    if (!Number.isSafeInteger(limit) || limit !== -1 && limit < 1) {
        throw new TypeError("PLURNK_PROVIDERS_MAX_CONCURRENCY must be -1 or a positive safe integer");
    }
};

// {§provider-inference-admission} One process-local FIFO allowance per canonical endpoint.
export default class InferenceAdmission {
    static readonly #endpoints = new Map<string, InferenceAdmission>();
    static #currentGeneration = 0;

    #limit: number;
    #configuredLimit: number;
    #generation: number;
    readonly #waiting = new Set<() => void>();
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

    get waitingCount(): number {
        return this.#waiting.size;
    }

    #resize(limit: number): void {
        this.#limit = limit;
        this.#drainQueue();
    }

    #drainQueue(): void {
        while (this.#waiting.size > 0 && (this.#limit === -1 || this.#active < this.#limit)) {
            const next = this.#waiting.values().next().value!;
            this.#waiting.delete(next);
            next();
        }
    }

    acquire(signal?: AbortSignal): Promise<() => void> {
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            let queued = false;
            const abort = (): void => {
                this.#waiting.delete(enter);
                reject(signal!.reason);
            };
            const enter = (): void => {
                if (queued) signal?.removeEventListener("abort", abort);
                this.#active += 1;
                let released = false;
                resolve(() => {
                    if (released) throw new Error("Inference admission lease was released twice");
                    released = true;
                    this.#active -= 1;
                    this.#drainQueue();
                });
            };
            if (this.#limit === -1 || this.#active < this.#limit) enter();
            else {
                queued = true;
                this.#waiting.add(enter);
                signal?.addEventListener("abort", abort, { once: true });
            }
        });
    }
}
