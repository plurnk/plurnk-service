// Shared pathname→entryId resolution for the db-backed capability impls.
// channels/tags/notify operate on entry-id-keyed statements; entries goes
// through EntryCrud (which resolves internally). Static delegation, not a base
// class — the caps call it, they don't inherit it.

import type { PlurnkSchemeContext } from "../scheme-types.ts";
import Owner from "../Owner.ts";

export default class CapsResolve {
    static async entryId(ctx: PlurnkSchemeContext, scheme: string | null, pathname: string): Promise<number | null> {
        const row = await ctx.db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme, pathname,
        });
        return row?.id ?? null;
    }
}
