import type { ChannelProducerResult, SubscriptionHandle } from "@plurnk/plurnk-schemes";
import type { Db } from "./Db.ts";
import ChannelWrite, { type StreamEventNotify, type WakeWorkerNotify, type WakeWorkerPayload } from "./ChannelWrite.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";

interface Options {
    readonly db: Db;
    readonly registry: LiveSubscriptions;
    readonly identity: Omit<WakeWorkerPayload, "result" | "summary">;
    readonly handle: SubscriptionHandle;
    readonly release: () => void;
    readonly notify?: StreamEventNotify;
    readonly wake?: WakeWorkerNotify;
}

interface Terminal {
    readonly result: ChannelProducerResult;
    readonly summary: string;
    readonly channelResults?: Readonly<Record<string, ChannelProducerResult>>;
}

// {§subscription-finalization} Persistence decides closure; observers cannot undo it.
export default class LiveSubscription {
    readonly #options: Options;
    #terminal: Terminal | null = null;
    #closing: Promise<void> | null = null;
    #closed = false;

    constructor(options: Options) {
        this.#options = options;
        options.registry.register(options.identity.subscriptionId, {
            cancel: () => this.#terminal === null
                ? options.handle.cancel()
                : this.close(this.#terminal.result, this.#terminal.summary, this.#terminal.channelResults),
        }, options.identity.workerId);
    }

    close(result: ChannelProducerResult, summary = "", channelResults?: Readonly<Record<string, ChannelProducerResult>>): Promise<void> {
        if (this.#closed) return Promise.resolve();
        if (this.#closing !== null) return this.#closing;
        // {§stream-asked-stop} — a stream its worker's KILL stopped concludes as asked, never as a cancellation.
        const asked = this.#options.registry.wasAsked(this.#options.identity.subscriptionId);
        const concluded = (produced: ChannelProducerResult): ChannelProducerResult => {
            if (!asked || produced.status !== 499) return produced;
            const exitCode = (produced as { exitCode?: unknown }).exitCode;
            return typeof exitCode === "number" ? { status: 200, exitCode } as ChannelProducerResult : { status: 200 };
        };
        this.#terminal = {
            result: concluded(result), summary,
            channelResults: channelResults === undefined ? undefined
                : Object.fromEntries(Object.entries(channelResults).map(([channel, produced]) => [channel, concluded(produced)])),
        };
        const closing = this.#settle(this.#terminal);
        this.#closing = closing;
        void closing.then(() => { this.#closing = null; }, () => {
            this.#closing = null;
            if (!this.#closed) this.#options.registry.retryable(this.#options.identity.subscriptionId);
        });
        return closing;
    }

    async #settle({ result, summary, channelResults }: Terminal): Promise<void> {
        const { db, registry, identity, release, notify, wake } = this.#options;
        const { subscriptionId, loop_seq, turn_seq, sequence } = identity;
        const coordinate = loop_seq === undefined || turn_seq === undefined || sequence === undefined
            ? undefined : { loop_seq, turn_seq, sequence };
        const events = await ChannelWrite.closeSubscription(db, { subscriptionId, result, channelResults, coordinate });
        this.#closed = true;
        registry.unregister(subscriptionId);
        const failures: unknown[] = [];
        try { release(); } catch (cause) { failures.push(cause); }
        if (events !== null) {
            for (const [workspaceId, event] of events) {
                try { notify?.(workspaceId, event); } catch (cause) { failures.push(cause); }
            }
            try { wake?.({ ...identity, result, summary }); } catch (cause) { failures.push(cause); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, `Subscription ${subscriptionId} post-close delivery failed`);
    }
}
