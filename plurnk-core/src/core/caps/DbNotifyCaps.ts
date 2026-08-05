// Db-backed implementation of the trusted plugin notification capability.
// plurnk-schemes {§capability-ctx}; core {§notifications-stream-event-on-channel-change}.
// Worker wake belongs to subscriptions.close because only that seam owns the
// complete conclusion context. {§scheme-subscriptions}
//
// streamEvent is sync per the cap contract, but the StreamEventPayload's entryId
// needs an async pathname→entryId lookup. The event is advisory (not a state
// change), so no notifier (standalone/test) is a no-op and a vanished entry
// yields no event. #182 owns diagnosis of exceptional lookup/notify failures.

import type { NotifyCaps, ChannelState } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import type { StreamEventNotify } from "../ChannelWrite.ts";
import CapsResolve from "./CapsResolve.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbNotifyCaps implements NotifyCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;

    constructor(ctx: PlurnkSchemeContext, scheme: string) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    streamEvent(pathname: string, channel: string, state: ChannelState, contentLength: number): void {
        const notify = this.#ctx.streamEventNotify;
        if (notify === undefined) return;
        // Keep the synchronous capability fire-and-forget without producing an
        // unhandled rejection; #182 owns preserving exceptional failure evidence.
        this.#emit(notify, pathname, channel, state, contentLength).catch(() => {});
    }

    async #emit(notify: StreamEventNotify, pathname: string, channel: string, state: ChannelState, contentLength: number): Promise<void> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return;
        const target = renderAddress(this.#scheme, pathname);
        notify(this.#ctx.workspaceId, { entryId, target, channel, state, contentLength });
    }
}
