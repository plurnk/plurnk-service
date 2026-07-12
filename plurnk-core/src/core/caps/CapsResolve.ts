// Shared pathname→entryId resolution for the db-backed capability impls.
// channels/tags/notify operate on entry-id-keyed statements; entries goes
// through EntryCrud (which resolves internally). Static delegation, not a base
// class — the caps call it, they don't inherit it.

import type { PlurnkSchemeContext } from "../scheme-types.ts";
import type { PrepMethod } from "../Db.ts";

export default class CapsResolve {
    static async entryId(ctx: PlurnkSchemeContext, scheme: string | null, pathname: string): Promise<number | null> {
        const row = await (ctx.db.crud_find_session_entry as PrepMethod).get<{ id: number }>({
            session_id: ctx.sessionId, scheme, pathname,
        });
        return row?.id ?? null;
    }
}
