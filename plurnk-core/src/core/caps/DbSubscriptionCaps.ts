// Db-backed implementation of plurnk-schemes {§capability-ctx}.
// The streaming lifecycle a sibling drives:
//   open(pathname, handle) → registers the subscription and hands back a
//     session+teardown-composed StreamSubscription; a session abort also
//     force-cancels the sibling's handle.
//   notifyChunk(channel, chunk) → FUSED append-to-channel + stream/event.
//   close(result, summary?, channelResults?) → composites every channel's
//     terminal state, registry close, and rich session wake (the only place with
//     the close context; NotifyCaps therefore has no wakeSession operation).
// The returned object owns the exact retained lifecycle. Namespace methods are
// operation-scoped compatibility forwarders to that same object.

import type {
    SubscriptionCaps,
    SubscriptionHandle,
    StreamSubscription,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import ChannelWrite from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";
import type LiveSubscriptions from "../LiveSubscriptions.ts";
import LiveSubscription from "../LiveSubscription.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbSubscriptionCaps implements SubscriptionCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;
    readonly #authority: string;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #publishedChannel: string | null;

    constructor(
        ctx: PlurnkSchemeContext,
        scheme: string,
        authority: string,
        liveSubscriptions: LiveSubscriptions,
        publishedChannel: string | null,
    ) {
        this.#ctx = ctx;
        this.#scheme = scheme;
        this.#authority = authority;
        this.#liveSubscriptions = liveSubscriptions;
        this.#publishedChannel = publishedChannel;
    }

    async open(pathname: string, handle: SubscriptionHandle): Promise<StreamSubscription> {
        const entry = await CapsResolve.entry(this.#ctx, this.#scheme, this.#authority, pathname);
        if (entry === null) throw new Error(`subscriptions.open: no entry at ${pathname}`);
        const { entryId } = entry;
        const {
            db,
            sessionId,
            workspaceId,
            signal: parent,
            streamEventNotify,
            wakeSessionNotify,
        } = this.#ctx;
        const scheme = this.#scheme;
        const liveSubscriptions = this.#liveSubscriptions;
        const publishedChannel = this.#publishedChannel;
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId, entryId, scheme, handle: pathname, publishedChannel,
        });
        const controller = new AbortController();
        let unlink = (): void => {};
        const notifyChunk = async (channel: string, chunk: string, mimetype?: string): Promise<void> => {
            await ChannelWrite.appendToChannel(db, {
                entryId, producerSessionId: sessionId, channel, chunk,
                ...(publishedChannel === null || publishedChannel === channel ? { notify: streamEventNotify } : {}),
                mimetype,
            });
        };
        const lifecycle = new LiveSubscription({
            db, registry: liveSubscriptions,
            identity: {
                workspaceId, sessionId, entryId,
                target: renderAddress({ scheme, authority: this.#authority, pathname }),
                subscriptionId, scheme,
            },
            notify: streamEventNotify, wake: wakeSessionNotify, release: () => unlink(),
            reaperLoopId: parent === undefined ? null : this.#ctx.loopId,
            handle: { cancel: async () => {
                controller.abort("subscription cancelled");
                await handle.cancel();
            } },
        });
        const subscription = Object.assign(controller.signal, {
            notifyChunk, close: lifecycle.close.bind(lifecycle),
        });
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
}
