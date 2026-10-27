import type { Db } from "./Db.ts";

// {§actor-boundary} The runtime has an actor for its actual operation turns: the
// workspace's one session of origin `_plurnk`, named `_plurnk` — a spelling `SESSION_NAME` never
// admits, so no model or client can mint or resume it ({§session-scheme}).
export default class RuntimeSession {
    static async ensure(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.runtime_session_get.get<{ id: number }>({ workspace_id: workspaceId });
        if (existing !== undefined) return existing.id;
        const row = await db.runtime_session_ensure.get<{ id: number }>({ workspace_id: workspaceId });
        if (row === undefined) throw new Error("Runtime session creation returned no row.");
        return row.id;
    }
}
