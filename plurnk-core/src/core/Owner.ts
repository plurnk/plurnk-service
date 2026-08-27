import type { Db } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

// {§entry-owner} — every entry is owned by a worker row: the workspace's
// reserved 'commons' worker for shared content, the spawning worker for capability streams. The
// owner id is a storage foreign key that NEVER renders into a URI or packet; the model addresses
// owners by NAME in the authority slot, and an empty authority resolves to the ambient principal
// (the caller on streams). 'plurnk' (the kernel) and 'commons' are the two reserved rows.
export default class Owner {
    // The workspace's reserved commons worker — lazily ensured, one per workspace. A real row
    // (never a NULL owner: NULLs are distinct under UNIQUE, so a nullable owner_id would let
    // the shared-content identity fragment into duplicate colliding rows).
    static async commonsId(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "commons" });
        if (existing !== undefined) return existing.id;
        const created = await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "commons", origin: "_plurnk" });
        if (created === undefined) throw new Error("Owner.commonsId: commons worker insert returned no row");
        return created.id;
    }

    // The reserved runtime actor ({§actor-boundary}); its named space is private like any other worker's.
    static async kernelId(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        if (existing !== undefined) return existing.id;
        const created = await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "_plurnk" });
        if (created === undefined) throw new Error("Owner.kernelId: kernel worker insert returned no row");
        return created.id;
    }

    // {§stream-owner-scoped} — resolve a capability-stream address's authority to its owner:
    // empty authority = the CALLING worker (a worker's own streams need no qualifier, and two
    // fan-out siblings' identical coordinates never collide); a named authority = that worker,
    // any worker of the workspace — topology is the parent's design (#394). Unknown name = null →
    // the caller 404s.
    static async resolveStreamOwner(hostname: string | null | undefined, ctx: PlurnkSchemeContext): Promise<number | null> {
        if (hostname === null || hostname === undefined || hostname === "") return ctx.workerId;
        const named = await ctx.db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: hostname });
        if (named === undefined) return null;
        if (named.id === ctx.workerId) return named.id;
        const permitted = await ctx.db.owner_shares_workspace.get<{ permitted: number }>({ owner_id: named.id, reader_id: ctx.workerId });
        return permitted === undefined ? null : named.id;
    }
}
