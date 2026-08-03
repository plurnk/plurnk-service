// db-backed NotifyCaps (@plurnk/plurnk-schemes 0.4.3) — keystone PR-2 seam (#180).
// streamEvent fires a stream/event notification for a channel transition.
// (wakeWorker was dropped in 0.4.3 — the rich worker wake lives on subscriptions.close,
// the only place with the close context to populate it.)
//
// streamEvent is sync per the cap contract, but the StreamEventPayload's entryId
// needs an async pathname→entryId lookup. The event is advisory (not a state
// change), so we emit best-effort: no notifier wired (standalone/test) → no-op;
// a vanished entry → no event.

import type { NotifyCaps, ChannelState } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import type { StreamEventNotify } from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbNotifyCaps implements NotifyCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string | null;

    constructor(ctx: PlurnkSchemeContext, scheme: string | null) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    streamEvent(pathname: string, channel: string, state: ChannelState, contentLength: number): void {
        const notify = this.#ctx.streamEventNotify;
        if (notify === undefined) return;
        // Advisory best-effort emit (sync contract, async entryId lookup): a resolve/notify
        // failure — e.g. the db closing under a late emit — is silently no-event per the cap
        // contract, never an unhandled rejection on the fire-and-forget.
        this.#emit(notify, pathname, channel, state, contentLength).catch(() => {});
    }

    async #emit(notify: StreamEventNotify, pathname: string, channel: string, state: ChannelState, contentLength: number): Promise<void> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return;
        const target = renderAddress(this.#scheme ?? "file", pathname);
        notify(this.#ctx.workspaceId, { entryId, target, channel, state, contentLength });
    }
}
