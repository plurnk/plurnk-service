import type { SubscriptionHandle } from "@plurnk/plurnk-schemes";

export default class LiveSubscriptions {
    readonly #handles = new Map<number, SubscriptionHandle>();
    readonly #cancellations = new Map<number, Promise<boolean>>();

    register(subscriptionId: number, handle: SubscriptionHandle): void {
        if (this.#handles.has(subscriptionId)) {
            throw new Error(`live subscription ${subscriptionId} is already registered`);
        }
        this.#handles.set(subscriptionId, handle);
    }

    unregister(subscriptionId: number): void {
        this.#handles.delete(subscriptionId);
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
        return cancellation;
    }
}
