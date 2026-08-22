// Db-backed implementation of plurnk-schemes {§scheme-subscriptions}.
// The streaming lifecycle a sibling drives:
//   open(pathname, handle) → registers the subscription and hands back a
//     worker+teardown-composed StreamSubscription; a worker abort also
//     force-cancels the sibling's handle.
//   notifyChunk(channel, chunk) → FUSED append-to-channel + stream/event.
//   close(result, summary?, channelResults?) → composites every channel's
//     terminal state, registry close, and rich worker wake (the only place with
//     the close context; NotifyCaps therefore has no wakeWorker operation).
// The returned object owns the exact retained lifecycle. Namespace methods are
// operation-scoped compatibility forwarders to that same object.

import { Results } from "@plurnk/plurnk-schemes";
import type {
    SubscriptionCaps,
    SubscriptionHandle,
    StreamSubscription,
    ChannelProducerResult,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import ChannelWrite from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";
import type LiveSubscriptions from "../LiveSubscriptions.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbSubscriptionCaps implements SubscriptionCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;
    readonly #authority: string;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #publishedChannel: string | null;
    readonly #ownerId: number | undefined;
    #current: StreamSubscription | null = null;

    constructor(
        ctx: PlurnkSchemeContext,
        scheme: string,
        authority: string,
        liveSubscriptions: LiveSubscriptions,
        publishedChannel: string | null,
        ownerId?: number,
    ) {
        this.#ctx = ctx;
        this.#scheme = scheme;
        this.#authority = authority;
        this.#liveSubscriptions = liveSubscriptions;
        this.#publishedChannel = publishedChannel;
        this.#ownerId = ownerId;
    }

    async open(pathname: string, handle: SubscriptionHandle): Promise<StreamSubscription> {
        const entry = await CapsResolve.entry(this.#ctx, this.#scheme, this.#authority, pathname, this.#ownerId);
        if (entry === null) throw new Error(`subscriptions.open: no entry at ${pathname}`);
        const { entryId, workerId: entryOwnerId } = entry;
        const {
            db,
            workerId,
            workspaceId,
            signal: parent,
            streamEventNotify,
            wakeWorkerNotify,
        } = this.#ctx;
        const scheme = this.#scheme;
        const liveSubscriptions = this.#liveSubscriptions;
        const publishedChannel = this.#publishedChannel;
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            workerId, entryId, scheme, handle: pathname, publishedChannel,
        });
        const controller = new AbortController();
        let unlink = (): void => {};
        const notifyChunk = async (channel: string, chunk: string, mimetype?: string): Promise<void> => {
            await ChannelWrite.appendToChannel(db, {
                entryId, channel, chunk,
                ...(publishedChannel === null || publishedChannel === channel ? { notify: streamEventNotify } : {}),
                mimetype,
            });
        };
        const close = async (
            result: ChannelProducerResult,
            summary?: string,
            channelResults?: Readonly<Record<string, ChannelProducerResult>>,
        ): Promise<void> => {
            Results.assertChannelProducerResult(result);
            await ChannelWrite.closeSubscription(db, {
                subscriptionId,
                result,
                channelResults,
                notify: streamEventNotify,
            });
            liveSubscriptions.unregister(subscriptionId);
            unlink();
            wakeWorkerNotify?.({
                workspaceId, workerId, entryOwnerId, entryId,
                target: renderAddress({ scheme, authority: this.#authority, pathname }),
                subscriptionId, result, scheme, summary: summary ?? "",
            });
        };
        const subscription = Object.assign(controller.signal, { notifyChunk, close });

        liveSubscriptions.register(subscriptionId, {
            cancel: async () => {
                controller.abort("subscription cancelled");
                await handle.cancel();
            },
        });
        this.#current = subscription;
        if (parent !== undefined) {
            const cancel = (): void => {
                void liveSubscriptions.cancel(subscriptionId).catch((err: unknown) => {
                    console.error("subscription cancellation failed:", err);
                });
            };
            if (parent.aborted) cancel();
            else {
                parent.addEventListener("abort", cancel, { once: true });
                unlink = (): void => parent.removeEventListener("abort", cancel);
            }
        }
        return subscription;
    }

    async notifyChunk(channel: string, chunk: string, mimetype?: string): Promise<void> {
        const current = this.#current;
        if (current === null) throw new Error("subscriptions.notifyChunk: no open subscription");
        await current.notifyChunk(channel, chunk, mimetype);
    }

    async close(
        result: ChannelProducerResult,
        summary?: string,
        channelResults?: Readonly<Record<string, ChannelProducerResult>>,
    ): Promise<void> {
        const current = this.#current;
        if (current === null) throw new Error("subscriptions.close: no open subscription");
        await current.close(result, summary, channelResults);
    }
}
