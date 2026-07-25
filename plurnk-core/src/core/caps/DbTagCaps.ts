// db-backed TagCaps (@plurnk/plurnk-schemes) — keystone PR-2 seam (#180).
// add/remove/list folksonomic tags on an entry, addressed by pathname. add is
// INSERT OR IGNORE (idempotent — re-adding a tag is a no-op); list returns them
// tag-sorted; remove drops the named tags. Absent entry → 404.

import type { TagCaps } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import CapsResolve from "./CapsResolve.ts";

export default class DbTagCaps implements TagCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string | null;

    constructor(ctx: PlurnkSchemeContext, scheme: string | null) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    async add(pathname: string, tags: ReadonlyArray<string>): Promise<{ status: number }> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return { status: 404 };
        for (const tag of tags) await this.#ctx.db.crud_write_tag.run({ entry_id: entryId, tag });
        return { status: 200 };
    }

    async remove(pathname: string, tags: ReadonlyArray<string>): Promise<{ status: number }> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return { status: 404 };
        for (const tag of tags) await this.#ctx.db.crud_delete_tag.run({ entry_id: entryId, tag });
        return { status: 200 };
    }

    async list(pathname: string): Promise<{ status: number; tags: ReadonlyArray<string> }> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return { status: 404, tags: [] };
        const rows = await this.#ctx.db.crud_read_tags.all<{ tag: string }>({ entry_id: entryId });
        return { status: 200, tags: rows.map((r) => r.tag) };
    }
}
