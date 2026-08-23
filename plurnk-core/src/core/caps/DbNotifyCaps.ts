// Db-backed implementation of the trusted plugin notification capability.
// plurnk-schemes {§capability-ctx}; core {§notifications-stream-event-on-channel-change}.
// Worker wake belongs to subscriptions.close because only that seam owns the
// complete conclusion context. {§scheme-subscriptions}
//
// streamEvent is sync per the cap contract, but the StreamEventPayload's entryId
// needs an async pathname→entryId lookup. The event is advisory (not a state
// change), so no notifier (standalone/test) is a no-op and a vanished entry
// yields no event. Exceptional work is isolated by
// {§notifications-stream-event-failure-isolation}.

import type { NotifyCaps, ChannelState } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import type { StreamEventNotify } from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbNotifyCaps implements NotifyCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;
    readonly #authority: string;
    readonly #ownerId: number;

    constructor(ctx: PlurnkSchemeContext, scheme: string, authority: string, ownerId: number) {
        this.#ctx = ctx;
        this.#scheme = scheme;
        this.#authority = authority;
        this.#ownerId = ownerId;
    }

    streamEvent(pathname: string, channel: string, state: ChannelState, contentLength: number): void {
        const notify = this.#ctx.streamEventNotify;
        if (notify === undefined) return;
        void this.#emit(notify, pathname, channel, state, contentLength).catch((cause: unknown) => {
            console.error(`Plugin stream/event emission failed for ${this.#scheme}:${pathname}#${channel}:`, cause);
        });
    }

    async #emit(notify: StreamEventNotify, pathname: string, channel: string, state: ChannelState, contentLength: number): Promise<void> {
        const entry = await CapsResolve.entry(this.#ctx, this.#scheme, this.#authority, pathname, this.#ownerId);
        if (entry === null) return;
        const target = renderAddress({ scheme: this.#scheme, authority: this.#authority, pathname });
        notify(this.#ctx.workspaceId, { entryId: entry.entryId, workerId: entry.workerId, target, channel, state, contentLength });
    }
}
