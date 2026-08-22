// Shared pathname→entry identity resolution for the db-backed capability impls.
// channels/notify operate on entry-id-keyed statements; entries goes
// through EntryCrud (which resolves internally). Static delegation, not a base
// class — the caps call it, they don't inherit it.

import type { PlurnkSchemeContext } from "../scheme-types.ts";
import Owner from "../Owner.ts";

export default class CapsResolve {
    static async entry(
        ctx: PlurnkSchemeContext,
        scheme: string,
        authority: string,
        pathname: string,
        ownerId?: number,
    ): Promise<{ entryId: number; workerId: number } | null> {
        const workerId = ownerId ?? await Owner.commonsId(ctx.db, ctx.workspaceId);
        const row = await ctx.db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: ctx.workspaceId, owner_id: workerId, scheme, authority, pathname,
        });
        return row === undefined ? null : { entryId: row.id, workerId };
    }

    static async entryId(ctx: PlurnkSchemeContext, scheme: string, authority: string, pathname: string, ownerId?: number): Promise<number | null> {
        return (await CapsResolve.entry(ctx, scheme, authority, pathname, ownerId))?.entryId ?? null;
    }
}
