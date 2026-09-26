// {§provider-inference-admission} One process-local allowance per resolved endpoint.
export default class InferenceAdmission {
    static readonly #endpoints = new Map<string, InferenceAdmission>();
    readonly #limit: number;
    readonly #waiting = new Set<() => void>();
    #active = 0;

    static forEndpoint(endpoint: string, limit: number): InferenceAdmission {
        if (!Number.isSafeInteger(limit) || limit !== -1 && limit < 1) {
            throw new TypeError("PLURNK_PROVIDERS_MAX_CONCURRENCY must be -1 or a positive safe integer");
        }
        const key = new URL(endpoint).href.replace(/\/+$/, "");
        const existing = this.#endpoints.get(key);
        if (existing !== undefined) {
            if (existing.#limit !== limit) {
                throw new TypeError("Provider aliases resolving to the same endpoint have conflicting PLURNK_PROVIDERS_MAX_CONCURRENCY values");
            }
            return existing;
        }
        const admission = new InferenceAdmission(limit);
        this.#endpoints.set(key, admission);
        return admission;
    }

    private constructor(limit: number) {
        this.#limit = limit;
    }

    acquire(signal?: AbortSignal): Promise<() => void> {
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const abort = (): void => {
                this.#waiting.delete(enter);
                reject(signal!.reason);
            };
            const enter = (): void => {
                signal?.removeEventListener("abort", abort);
                this.#active += 1;
                let released = false;
                resolve(() => {
                    if (released) throw new Error("Inference admission lease was released twice");
                    released = true;
                    this.#active -= 1;
                    const next = this.#waiting.values().next().value;
                    if (next !== undefined) {
                        this.#waiting.delete(next);
                        next();
                    }
                });
            };
            if (this.#limit === -1 || this.#active < this.#limit) enter();
            else {
                this.#waiting.add(enter);
                signal?.addEventListener("abort", abort, { once: true });
            }
        });
    }
}
