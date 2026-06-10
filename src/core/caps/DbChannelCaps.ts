// db-backed ChannelCaps (@plurnk/plurnk-schemes) — keystone PR-2 seam (#180).
// append/replace/setState over a single channel, addressed by pathname. Resolves
// pathname→entryId, then drives the ChannelWrite SQL. append grows existing
// content (token re-count deferred to render, per §14.2); replace swaps content
// and re-tokenizes at write. Absent entry or channel → 404.

import type { ChannelCaps, ChannelState } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import type { PrepMethod } from "../Db.ts";
import CapsResolve from "./CapsResolve.ts";

export default class DbChannelCaps implements ChannelCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string | null;

    constructor(ctx: PlurnkSchemeContext, scheme: string | null) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    async append(pathname: string, channel: string, content: string): Promise<{ status: number }> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return { status: 404 };
        const r = await (this.#ctx.db.append_to_channel as PrepMethod).run({ chunk: content, entry_id: entryId, channel });
        return { status: r.changes > 0 ? 200 : 404 };
    }

    async replace(pathname: string, channel: string, content: string): Promise<{ status: number }> {
        const { tokenize } = this.#ctx;
        if (tokenize === undefined) throw new Error("DbChannelCaps.replace: ctx.tokenize is required for token accounting");
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return { status: 404 };
        const r = await (this.#ctx.db.replace_channel_content as PrepMethod).run({
            content, tokens: tokenize(content), entry_id: entryId, channel,
        });
        return { status: r.changes > 0 ? 200 : 404 };
    }

    async setState(pathname: string, channel: string, state: ChannelState): Promise<{ status: number }> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return { status: 404 };
        const r = await (this.#ctx.db.set_channel_state as PrepMethod).run({ state, entry_id: entryId, channel });
        return { status: r.changes > 0 ? 200 : 404 };
    }
}
