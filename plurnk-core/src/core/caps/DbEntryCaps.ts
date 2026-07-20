// db-backed EntryCaps (@plurnk/plurnk-schemes) — the keystone PR-2 seam (#180).
// schemes exports the capability interfaces; plurnk-service injects this
// db-backed impl so a third-party `@plurnk/plurnk-schemes-*` sibling reaches
// entries through intent (read/write/delete) instead of the forbidden raw
// `ctx.db` (schemes SPEC §channels). Binds a PlurnkSchemeContext + the scheme name and
// delegates 1:1 to EntryCrud — the same path the in-tree schemes use during
// transition, so the adapter is zero-behavior-change over a proven primitive.

import type { EntryCaps, EntryData } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import EntryCrud from "../../schemes/_entry-crud.ts";

export default class DbEntryCaps implements EntryCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;

    constructor(ctx: PlurnkSchemeContext, scheme: string) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    async read(pathname: string): Promise<{ status: number; entry: EntryData | null }> {
        return EntryCrud.readEntry(pathname, this.#ctx, this.#scheme);
    }

    async write(pathname: string, entry: EntryData): Promise<{ status: number; created: boolean; entryId: number | null }> {
        // schemes' EntryData carries `tags` as ReadonlyArray; EntryCrud writes a
        // mutable array — copy at the boundary.
        return EntryCrud.writeEntry(pathname, { channels: entry.channels, tags: [...entry.tags] }, this.#ctx, this.#scheme);
    }

    async delete(pathname: string): Promise<{ status: number }> {
        return EntryCrud.deleteEntry(pathname, this.#ctx, this.#scheme);
    }
}
