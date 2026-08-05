// Db-backed implementation of the channel namespace in plurnk-schemes
// {§capability-ctx}.
// append/replace/setState over a single channel, addressed by pathname. Resolves
// pathname→entryId, then drives the ChannelWrite SQL. append grows existing
// content (token re-count deferred to render, per {§tokenomics}); replace swaps content
// and re-tokenizes at write. Absent entry or channel → 404.

import { Results, type ChannelCaps, type ChannelState, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import CapsResolve from "./CapsResolve.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbChannelCaps implements ChannelCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;

    constructor(ctx: PlurnkSchemeContext, scheme: string) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    #failure(code: string, detail: string, pathname: string, channel?: string): SchemeResult {
        const target = renderAddress(this.#scheme, pathname);
        return Results.failure(
            `scheme:${this.#scheme}`,
            code,
            404,
            detail,
            {},
            {
                target,
                ...(channel === undefined ? {} : { channel }),
            },
        );
    }

    async append(pathname: string, channel: string, content: string): Promise<SchemeResult> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return this.#failure("entry-not-found", `No entry exists at ${renderAddress(this.#scheme, pathname)}.`, pathname);
        const r = await this.#ctx.db.append_to_channel.run({ chunk: content, entry_id: entryId, channel });
        return r.changes > 0
            ? Results.assert({ status: 200 })
            : this.#failure("channel-not-found", `Entry ${renderAddress(this.#scheme, pathname)} has no '${channel}' channel.`, pathname, channel);
    }

    async replace(pathname: string, channel: string, content: string): Promise<SchemeResult> {
        const { tokenize } = this.#ctx;
        if (tokenize === undefined) throw new Error("DbChannelCaps.replace: ctx.tokenize is required for token accounting");
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return this.#failure("entry-not-found", `No entry exists at ${renderAddress(this.#scheme, pathname)}.`, pathname);
        const r = await this.#ctx.db.replace_channel_content.run({
            content, tokens: tokenize(content), entry_id: entryId, channel,
        });
        return r.changes > 0
            ? Results.assert({ status: 200 })
            : this.#failure("channel-not-found", `Entry ${renderAddress(this.#scheme, pathname)} has no '${channel}' channel.`, pathname, channel);
    }

    async setState(pathname: string, channel: string, state: ChannelState): Promise<SchemeResult> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return this.#failure("entry-not-found", `No entry exists at ${renderAddress(this.#scheme, pathname)}.`, pathname);
        const r = await this.#ctx.db.set_channel_state.run({ state, entry_id: entryId, channel });
        return r.changes > 0
            ? Results.assert({ status: 200 })
            : this.#failure("channel-not-found", `Entry ${renderAddress(this.#scheme, pathname)} has no '${channel}' channel.`, pathname, channel);
    }
}
