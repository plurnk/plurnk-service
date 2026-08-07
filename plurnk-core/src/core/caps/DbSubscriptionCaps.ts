// Db-backed implementation of plurnk-schemes {§scheme-subscriptions}.
// The streaming lifecycle a sibling drives:
//   open(pathname, handle) → registers the subscription and hands back a
//     worker+teardown-composed StreamSubscription; a worker abort also
//     force-cancels the sibling's handle.
//   notifyChunk(channel, chunk) → FUSED append-to-channel + stream/event.
//   close(result, summary?, channelStates?) → composites every channel's
//     terminal state, registry close, and rich worker wake (the only place with
//     the close context; NotifyCaps therefore has no wakeWorker operation).
// The returned object owns the exact retained lifecycle. Namespace methods are
// operation-scoped compatibility forwarders to that same object.

import { Results } from "@plurnk/plurnk-schemes";
import type {
    SubscriptionCaps,
    SubscriptionHandle,
    StreamSubscription,
    ChannelState,
    TerminalChannelState,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import ChannelWrite from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";
import type LiveSubscriptions from "../LiveSubscriptions.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbSubscriptionCaps implements SubscriptionCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;
    readonly #liveSubscriptions: LiveSubscriptions;
    #current: StreamSubscription | null = null;

    constructor(ctx: PlurnkSchemeContext, scheme: string, liveSubscriptions: LiveSubscriptions) {
        this.#ctx = ctx;
        this.#scheme = scheme;
        this.#liveSubscriptions = liveSubscriptions;
    }

    async open(pathname: string, handle: SubscriptionHandle, options?: { publishedChannel?: string }): Promise<StreamSubscription> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) throw new Error(`subscriptions.open: no entry at ${pathname}`);
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
        const publishedChannel = options?.publishedChannel ?? null;
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
            result: SchemeResult,
            summary?: string,
            channelStates?: Readonly<Record<string, TerminalChannelState>>,
        ): Promise<void> => {
            Results.assert(result);
            const defaultState: ChannelState = result.status >= 400 ? "errored" : "closed";
            const channels = await db.crud_read_channels.all<{ name: string }>({ entry_id: entryId });
            const channelNames = new Set(channels.map(({ name }) => name));
            for (const [name, state] of Object.entries(channelStates ?? {})) {
                if (!channelNames.has(name)) throw new Error(`subscriptions.close: unknown channel state override ${name}`);
                if (state !== "closed" && state !== "errored") {
                    throw new Error(`subscriptions.close: invalid state ${JSON.stringify(state)} for channel ${name}`);
                }
            }
            for (const { name } of channels) {
                const state: ChannelState = channelStates?.[name] ?? defaultState;
                await ChannelWrite.setChannelState(db, {
                    entryId, channel: name, state,
                    ...(publishedChannel === null || publishedChannel === name ? { notify: streamEventNotify } : {}),
                });
            }
            await ChannelWrite.closeSubscription(db, { subscriptionId, result });
            liveSubscriptions.unregister(subscriptionId);
            unlink();
            wakeWorkerNotify?.({
                workspaceId, workerId, entryId,
                target: renderAddress(scheme, pathname),
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
        result: SchemeResult,
        summary?: string,
        channelStates?: Readonly<Record<string, TerminalChannelState>>,
    ): Promise<void> {
        const current = this.#current;
        if (current === null) throw new Error("subscriptions.close: no open subscription");
        await current.close(result, summary, channelStates);
    }
}
