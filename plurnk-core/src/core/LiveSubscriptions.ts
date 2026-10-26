import type { SubscriptionHandle } from "@plurnk/plurnk-schemes";

export default class LiveSubscriptions {
    readonly #handles = new Map<number, SubscriptionHandle>();
    readonly #cancellations = new Map<number, Promise<boolean>>();
    readonly #holders = new Map<number, number>();
    // The loop whose teardown reaps each subscription; absent for one that outlives its loop.
    readonly #reapers = new Map<number, number>();
    readonly #asked = new Set<number>();
    readonly #conclusions = new Map<number, PromiseWithResolvers<void>>();

    register(subscriptionId: number, handle: SubscriptionHandle, holderSessionId?: number, reaperLoopId: number | null = null): void {
        if (this.#handles.has(subscriptionId)) {
            throw new Error(`live subscription ${subscriptionId} is already registered`);
        }
        this.#handles.set(subscriptionId, handle);
        if (holderSessionId !== undefined) this.#holders.set(subscriptionId, holderSessionId);
        if (reaperLoopId !== null) this.#reapers.set(subscriptionId, reaperLoopId);
    }

    unregister(subscriptionId: number): void {
        this.#handles.delete(subscriptionId);
        this.#cancellations.delete(subscriptionId);
        this.#holders.delete(subscriptionId);
        this.#reapers.delete(subscriptionId);
        this.#asked.delete(subscriptionId);
    }

    // {§stream-asked-stop} — a KILL by the session that holds the stream names it before cancelling
    // it, so its conclusion is the stop that session asked for rather than a cancellation failure.
    asked(subscriptionId: number, sessionId: number): void {
        if (this.#holders.get(subscriptionId) === sessionId) this.#asked.add(subscriptionId);
    }

    wasAsked(subscriptionId: number): boolean {
        return this.#asked.has(subscriptionId);
    }

    // {§subscription-finalization} Settles once the subscription's close is committed and delivered; at once for an
    // id with no live subscription.
    concluded(subscriptionId: number): Promise<void> {
        if (!this.#handles.has(subscriptionId)) return Promise.resolve();
        let conclusion = this.#conclusions.get(subscriptionId);
        if (conclusion === undefined) {
            conclusion = Promise.withResolvers<void>();
            this.#conclusions.set(subscriptionId, conclusion);
        }
        return conclusion.promise;
    }

    // {§exec-lifetime} {§notifications-loop-terminated} Cancels every live subscription the loop's terminal reaps, whatever
    // segment of the loop opened it, and settles with those it reaped once each has concluded. A cancellation that fails
    // leaves its subscription retryable and is reported; the reap does not wait on it.
    async reapLoop(loopId: number): Promise<number[]> {
        const reaped = [...this.#reapers].flatMap(([subscriptionId, reaper]) => reaper === loopId ? [subscriptionId] : []);
        const concluded = await Promise.all(reaped.map(async (subscriptionId) => {
            const conclusion = this.concluded(subscriptionId);
            try {
                await this.cancel(subscriptionId);
            } catch (cause) {
                console.error(`loop ${loopId} could not reap subscription ${subscriptionId}:`, cause);
                return [];
            }
            await conclusion;
            return [subscriptionId];
        }));
        return concluded.flat();
    }

    delivered(subscriptionId: number): void {
        this.#conclusions.get(subscriptionId)?.resolve();
        this.#conclusions.delete(subscriptionId);
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
