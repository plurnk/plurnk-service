// db-backed TagCaps (@plurnk/plurnk-schemes) — keystone PR-2 seam (#180).
// add/remove/list folksonomic tags on an entry, addressed by pathname. add is
// INSERT OR IGNORE (idempotent — re-adding a tag is a no-op); list returns them
// tag-sorted; remove drops the named tags. Absent entry → 404.

import { Results, type SchemeResult, type TagCaps, type TagListResult } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import CapsResolve from "./CapsResolve.ts";
import { renderAddress } from "../plurnk-uri.ts";

export default class DbTagCaps implements TagCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;

    constructor(ctx: PlurnkSchemeContext, scheme: string) {
        this.#ctx = ctx;
        this.#scheme = scheme;
    }

    #missing(pathname: string, fields: Readonly<Record<string, unknown>> = {}): SchemeResult {
        const target = renderAddress(this.#scheme, pathname);
        return Results.failure(
            `scheme:${this.#scheme}`,
            "entry-not-found",
            404,
            `No entry exists at ${target}.`,
            fields,
            { target },
        );
    }

    async add(pathname: string, tags: ReadonlyArray<string>): Promise<SchemeResult> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return this.#missing(pathname);
        for (const tag of tags) await this.#ctx.db.crud_write_tag.run({ entry_id: entryId, tag });
        return Results.assert({ status: 200 });
    }

    async remove(pathname: string, tags: ReadonlyArray<string>): Promise<SchemeResult> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return this.#missing(pathname);
        for (const tag of tags) await this.#ctx.db.crud_delete_tag.run({ entry_id: entryId, tag });
        return Results.assert({ status: 200 });
    }

    async list(pathname: string): Promise<TagListResult> {
        const entryId = await CapsResolve.entryId(this.#ctx, this.#scheme, pathname);
        if (entryId === null) return this.#missing(pathname, { tags: [] }) as TagListResult;
        const rows = await this.#ctx.db.crud_read_tags.all<{ tag: string }>({ entry_id: entryId });
        return Results.assert({ status: 200, tags: rows.map((r) => r.tag) });
    }
}
