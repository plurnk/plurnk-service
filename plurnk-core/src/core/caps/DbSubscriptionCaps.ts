// db-backed SubscriptionCaps (@plurnk/plurnk-schemes) — keystone PR-2 seam (#180).
// The streaming lifecycle a sibling drives:
//   open(pathname, handle) → registers the subscription and hands back a
//     worker+teardown-composed AbortSignal; a worker abort also force-cancels the
//     sibling's handle (mirrors the exec scheme's #activeAborts).
//   notifyChunk(channel, chunk) → FUSED append-to-channel + stream/event.
//   close(result, summary?) → composites every channel's terminal state, the
//     registry close, and the rich worker wake (the only place with the close
//     context to populate it — which is why NotifyCaps dropped wakeWorker, #180).
// Stateful: open() binds the entry + subscription that notifyChunk()/close()
// operate on. Models src/schemes/Exec.ts over the same ChannelWrite primitives.

import { Results } from "@plurnk/plurnk-schemes";
import type { SubscriptionCaps, SubscriptionHandle, ChannelState, SchemeResult } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import ChannelWrite from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";
import type LiveSubscriptions from "../LiveSubscriptions.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbSubscriptionCaps implements SubscriptionCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string | null;
    readonly #liveSubscriptions: LiveSubscriptions;
    #pathname: string | null = null;
    #entryId: number | null = null;
    #subscriptionId: number | null = null;
    #publishedChannel: string | null = null;
    #unlink: () => void = () => {};

    constructor(ctx: PlurnkSchemeContext, scheme: string | null, liveSubscriptions: LiveSubscriptions) {
        this.#ctx = ctx;
        this.#scheme = scheme;
        this.#liveSubscriptions = liveSubscriptions;
    }

    async open(pathname: string, handle: SubscriptionHandle, options?: { publishedChannel?: string }): Promise<AbortSignal> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) throw new Error(`subscriptions.open: no entry at ${pathname}`);
        const subscriptionId = await ChannelWrite.openSubscription(this.#ctx.db, {
            workerId: this.#ctx.workerId, entryId, scheme: this.#scheme ?? "file", handle: pathname,
            publishedChannel: options?.publishedChannel ?? null,
        });
        // Compose the worker signal with a fresh controller; a worker abort also
        // force-cancels the sibling's handle.
        const controller = new AbortController();
        this.#liveSubscriptions.register(subscriptionId, {
            cancel: async () => {
                controller.abort("subscription cancelled");
                await handle.cancel();
            },
        });
        const parent = this.#ctx.signal;
        if (parent !== undefined) {
            const cancel = (): void => {
                void this.#liveSubscriptions.cancel(subscriptionId).catch((err: unknown) => {
                    console.error("subscription cancellation failed:", err);
                });
            };
            if (parent.aborted) cancel();
            else {
                parent.addEventListener("abort", cancel, { once: true });
                this.#unlink = (): void => parent.removeEventListener("abort", cancel);
            }
        }
        this.#pathname = pathname;
        this.#entryId = entryId;
        this.#subscriptionId = subscriptionId;
        this.#publishedChannel = options?.publishedChannel ?? null;
        return controller.signal;
    }

    async notifyChunk(channel: string, chunk: string, mimetype?: string): Promise<void> {
        if (this.#entryId === null) throw new Error("subscriptions.notifyChunk: no open subscription");
        await ChannelWrite.appendToChannel(this.#ctx.db, {
            entryId: this.#entryId, channel, chunk,
            ...(this.#publishedChannel === null || this.#publishedChannel === channel ? { notify: this.#ctx.streamEventNotify } : {}),
            mimetype,
        });
    }

    async close(result: SchemeResult, summary?: string): Promise<void> {
        const entryId = this.#entryId;
        const subscriptionId = this.#subscriptionId;
        if (entryId === null || subscriptionId === null) throw new Error("subscriptions.close: no open subscription");
        Results.assert(result);
        const state: ChannelState = result.status >= 400 && result.status !== 499 ? "errored" : "closed";
        // Every channel of the entry → terminal state, then the registry row
        // closes, then the worker wakes with the scheme's summary.
        const channels = await this.#ctx.db.crud_read_channels.all<{ name: string }>({ entry_id: entryId });
        for (const { name } of channels) {
            await ChannelWrite.setChannelState(this.#ctx.db, {
                entryId, channel: name, state,
                ...(this.#publishedChannel === null || this.#publishedChannel === name ? { notify: this.#ctx.streamEventNotify } : {}),
            });
        }
        await ChannelWrite.closeSubscription(this.#ctx.db, { subscriptionId, result });
        this.#liveSubscriptions.unregister(subscriptionId);
        this.#unlink();
        const target = renderAddress(this.#scheme ?? "file", this.#pathname ?? "");
        this.#ctx.wakeWorkerNotify?.({
            workspaceId: this.#ctx.workspaceId, workerId: this.#ctx.workerId,
            entryId, target, subscriptionId, result,
            scheme: this.#scheme ?? "file", summary: summary ?? "",
        });
        this.#pathname = null;
        this.#entryId = null;
        this.#subscriptionId = null;
        this.#publishedChannel = null;
        this.#unlink = (): void => {};
    }
}
