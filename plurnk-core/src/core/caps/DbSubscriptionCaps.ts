// db-backed SubscriptionCaps (@plurnk/plurnk-schemes) — keystone PR-2 seam (#180).
// The streaming lifecycle a sibling drives:
//   open(pathname, handle) → registers the subscription and hands back a
//     run+teardown-composed AbortSignal; a worker abort also force-cancels the
//     sibling's handle (mirrors the exec scheme's #activeAborts).
//   notifyChunk(channel, chunk) → FUSED append-to-channel + stream/event.
//   close(reason, outcome?) → composites every channel's terminal state, the
//     registry close, and the rich run-wake (the only place with the close
//     context to populate it — which is why NotifyCaps dropped wakeWorker, #180).
// Stateful: open() binds the entry + subscription that notifyChunk()/close()
// operate on. Models src/schemes/Exec.ts over the same ChannelWrite primitives.

import type { SubscriptionCaps, SubscriptionHandle, ChannelState } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import type { PrepMethod } from "../Db.ts";
import ChannelWrite from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";

export default class DbSubscriptionCaps implements SubscriptionCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string | null;
    #pathname: string | null = null;
    #entryId: number | null = null;
    #subscriptionId: number | null = null;
    #publishedChannel: string | null = null;
    #unlink: () => void = () => {};

    constructor(ctx: PlurnkSchemeContext, scheme: string | null) {
        this.#ctx = ctx;
        this.#scheme = scheme;
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
        const parent = this.#ctx.signal;
        if (parent !== undefined) {
            if (parent.aborted) { void handle.cancel(); controller.abort(parent.reason); }
            else {
                const onAbort = (): void => { void handle.cancel(); controller.abort(parent.reason); };
                parent.addEventListener("abort", onAbort, { once: true });
                this.#unlink = (): void => parent.removeEventListener("abort", onAbort);
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

    async close(reason: "done" | "error", outcome?: string): Promise<void> {
        const entryId = this.#entryId;
        const subscriptionId = this.#subscriptionId;
        if (entryId === null || subscriptionId === null) throw new Error("subscriptions.close: no open subscription");
        const state: ChannelState = reason === "error" ? "errored" : "closed";
        const closeStatus = reason === "error" ? 500 : 200;
        // Every channel of the entry → terminal state, then the registry row
        // closes, then the worker wakes with the scheme's summary.
        const channels = await (this.#ctx.db.crud_read_channels as PrepMethod).all<{ name: string }>({ entry_id: entryId });
        for (const { name } of channels) {
            await ChannelWrite.setChannelState(this.#ctx.db, {
                entryId, channel: name, state,
                ...(this.#publishedChannel === null || this.#publishedChannel === name ? { notify: this.#ctx.streamEventNotify } : {}),
            });
        }
        await ChannelWrite.closeSubscription(this.#ctx.db, { subscriptionId, status: closeStatus });
        this.#unlink();
        const target = this.#scheme === null ? `file://${this.#pathname}` : `${this.#scheme}://${this.#pathname}`;
        this.#ctx.wakeWorkerNotify?.({
            workspaceId: this.#ctx.workspaceId, workerId: this.#ctx.workerId,
            entryId, target, subscriptionId, closeStatus,
            scheme: this.#scheme ?? "file", summary: outcome ?? "",
        });
        this.#pathname = null;
        this.#entryId = null;
        this.#subscriptionId = null;
        this.#publishedChannel = null;
        this.#unlink = (): void => {};
    }
}
