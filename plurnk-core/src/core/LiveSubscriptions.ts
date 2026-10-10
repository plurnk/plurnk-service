import type { SubscriptionHandle } from "@plurnk/plurnk-schemes";

export default class LiveSubscriptions {
    readonly #handles = new Map<number, SubscriptionHandle>();
    readonly #cancellations = new Map<number, Promise<boolean>>();
    readonly #holders = new Map<number, number>();
    readonly #asked = new Set<number>();

    register(subscriptionId: number, handle: SubscriptionHandle, holderWorkerId?: number): void {
        if (this.#handles.has(subscriptionId)) {
            throw new Error(`live subscription ${subscriptionId} is already registered`);
        }
        this.#handles.set(subscriptionId, handle);
        if (holderWorkerId !== undefined) this.#holders.set(subscriptionId, holderWorkerId);
    }

    unregister(subscriptionId: number): void {
        this.#handles.delete(subscriptionId);
        this.#cancellations.delete(subscriptionId);
        this.#holders.delete(subscriptionId);
        this.#asked.delete(subscriptionId);
    }

    // {§stream-asked-stop} — a KILL by the worker that holds the stream names it before cancelling
    // it, so its conclusion is the stop that worker asked for rather than a cancellation failure.
    asked(subscriptionId: number, workerId: number): void {
        if (this.#holders.get(subscriptionId) === workerId) this.#asked.add(subscriptionId);
    }

    wasAsked(subscriptionId: number): boolean {
        return this.#asked.has(subscriptionId);
    }

    // {§subscription-finalization} A failed durable close retains the owner but permits another attempt.
    retryable(subscriptionId: number): void {
        this.#cancellations.delete(subscriptionId);
    }

    cancel(subscriptionId: number): Promise<boolean> {
        const pending = this.#cancellations.get(subscriptionId);
        if (pending !== undefined) return pending;
        const handle = this.#handles.get(subscriptionId);
        if (handle === undefined) return Promise.resolve(false);
        let cancellation: Promise<boolean>;
        try {
            cancellation = Promise.resolve(handle.cancel()).then(() => true);
        } catch (error) {
            cancellation = Promise.reject(error);
        }
        this.#cancellations.set(subscriptionId, cancellation);
        void cancellation.catch(() => {
            if (this.#cancellations.get(subscriptionId) === cancellation) this.retryable(subscriptionId);
        });
        return cancellation;
    }
}
