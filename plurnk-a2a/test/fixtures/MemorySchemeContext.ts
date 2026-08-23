import {
    Results,
    type ChannelProducerResult,
    type EntryCaps,
    type EntryData,
    type EntryStorageReadResult,
    type SchemeCtx,
    type StoredEntryData,
    type StreamSubscription,
    type SubscriptionHandle,
} from "@plurnk/plurnk-schemes";

export interface MemorySubscriptionClose {
    readonly result: ChannelProducerResult;
    readonly summary?: string;
}

interface MemorySubscription {
    readonly controller: AbortController;
    readonly handle: SubscriptionHandle;
    readonly settled: PromiseWithResolvers<MemorySubscriptionClose>;
}

/** A contract-shaped in-memory SchemeCtx for composed sibling-package tests. */
export default class MemorySchemeContext {
    readonly entries = new Map<string, StoredEntryData>();
    readonly ctx: SchemeCtx;
    readonly #subscriptions = new Map<string, MemorySubscription>();

    constructor() {
        const entries: EntryCaps = {
            operations: {
                async editBatch() { throw new Error("editBatch is outside the A2A specimen"); },
                async read() { throw new Error("operation read is outside the A2A specimen"); },
                async find() { throw new Error("find is outside the A2A specimen"); },
                async send() { throw new Error("operation send is outside the A2A specimen"); },
            },
            read: async (pathname) => {
                const entry = this.entries.get(pathname) ?? null;
                return entry === null
                    ? Results.failure(
                        "scheme:memory",
                        "entry-not-found",
                        404,
                        `No entry exists at ${pathname}.`,
                        { entry: null },
                    ) as EntryStorageReadResult
                    : { status: 200, entry };
            },
            write: async (pathname, entry) => {
                const created = !this.entries.has(pathname);
                this.entries.set(pathname, MemorySchemeContext.#stored(entry));
                return { status: created ? 201 : 200, created, entryId: this.entries.size };
            },
            delete: async (pathname, channel) => {
                if (channel === undefined) this.entries.delete(pathname);
                else {
                    const entry = this.entries.get(pathname);
                    if (entry !== undefined) delete entry.channels[channel];
                }
                return { status: 200 };
            },
        };
        this.ctx = {
            workspaceId: 1,
            workerId: 1,
            functionalityWorkerId: 1,
            loopId: 1,
            turnId: 1,
            writer: "model",
            signal: undefined,
            entries,
            channels: {
                append: async (pathname, channel, content) => {
                    const entry = this.#entry(pathname);
                    entry.channels[channel]!.content += content;
                    return { status: 200 };
                },
                replace: async (pathname, channel, content) => {
                    const entry = this.#entry(pathname);
                    entry.channels[channel]!.content = content;
                    return { status: 200 };
                },
                setState: async (pathname, channel, state) => {
                    const entry = this.#entry(pathname);
                    entry.channels[channel]!.state = state;
                    return { status: 200 };
                },
            },
            notify: { streamEvent() {} },
            projection: {
                async readable() { throw new Error("projection is outside the A2A specimen"); },
                async readableBytes() { throw new Error("projection is outside the A2A specimen"); },
                async identity(mimetype) { return mimetype; },
                async isBinary() { return false; },
                async parseIssues() { return undefined; },
            },
            interactions: {
                async request() { throw new Error("interaction is outside the A2A specimen"); },
            },
            subscriptions: {
                open: async (pathname, handle) => this.#open(pathname, handle),
                async notifyChunk() { throw new Error("retain the returned subscription"); },
                async close() { throw new Error("retain the returned subscription"); },
            },
        };
    }

    entry(pathname: string): StoredEntryData {
        return this.#entry(pathname);
    }

    waitForClose(pathname: string): Promise<MemorySubscriptionClose> {
        const subscription = this.#subscriptions.get(pathname);
        if (subscription === undefined) throw new Error(`No subscription exists at ${pathname}`);
        return subscription.settled.promise;
    }

    async cancel(pathname: string): Promise<void> {
        const subscription = this.#subscriptions.get(pathname);
        if (subscription === undefined) throw new Error(`No subscription exists at ${pathname}`);
        subscription.controller.abort("cancelled by test");
        await subscription.handle.cancel();
    }

    #entry(pathname: string): StoredEntryData {
        const entry = this.entries.get(pathname);
        if (entry === undefined) throw new Error(`No entry exists at ${pathname}`);
        return entry;
    }

    #open(pathname: string, handle: SubscriptionHandle): StreamSubscription {
        const entry = this.#entry(pathname);
        const controller = new AbortController();
        const settled = Promise.withResolvers<MemorySubscriptionClose>();
        const subscription = Object.assign(controller.signal, {
            notifyChunk: async (channel: string, chunk: string, mimetype?: string) => {
                const target = entry.channels[channel];
                if (target === undefined) throw new Error(`No channel ${channel} exists at ${pathname}`);
                target.content += chunk;
                if (mimetype !== undefined) target.mimetype = mimetype;
            },
            close: async (result: ChannelProducerResult, summary?: string) => {
                for (const channel of Object.values(entry.channels)) {
                    channel.state = result.status >= 400 ? "errored" : "closed";
                    channel.producerResult = result;
                }
                settled.resolve({ result, ...(summary === undefined ? {} : { summary }) });
            },
        });
        this.#subscriptions.set(pathname, { controller, handle, settled });
        return subscription;
    }

    static #stored(entry: EntryData): StoredEntryData {
        return {
            channels: Object.fromEntries(Object.entries(entry.channels).map(([name, channel]) => [
                name,
                { ...channel, state: channel.state ?? "static" },
            ])),
            ...(entry.attributes === undefined ? {} : { attributes: entry.attributes }),
        };
    }
}
