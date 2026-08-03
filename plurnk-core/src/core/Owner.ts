import { RESERVED_AUTHORITIES } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

// #527 {§entry-owner} — entry ownership. Every entry is owned by a worker row: the workspace's
// reserved 'commons' worker for shared content, the spawning worker for capability streams. The
// owner id is a storage foreign key that NEVER renders into a URI or packet; the model addresses
// owners by NAME in the authority slot, and an empty authority resolves to the ambient principal
// (the caller on streams). 'plurnk' (the kernel) and 'commons' are the two reserved rows.
export default class Owner {
    // Contracts owns the internal names; core adds the non-mintable current-worker sigil. {§worker-name}
    static readonly RESERVED = Object.freeze(new Set([...RESERVED_AUTHORITIES, "~"]));

    // The workspace's reserved commons worker — lazily ensured, one per workspace. A real row
    // (never a NULL owner: NULLs are distinct under UNIQUE, so a nullable owner_id would let
    // the shared-content identity fragment into duplicate colliding rows).
    static async commonsId(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "commons" });
        if (existing !== undefined) return existing.id;
        const created = await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "commons", origin: "plurnk" });
        if (created === undefined) throw new Error("Owner.commonsId: commons worker insert returned no row");
        return created.id;
    }

    // The reserved kernel row — worker://plurnk/, the runtime's own actor ({§actor-boundary}).
    static async kernelId(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        if (existing !== undefined) return existing.id;
        const created = await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "plurnk" });
        if (created === undefined) throw new Error("Owner.kernelId: kernel worker insert returned no row");
        return created.id;
    }

    // {§stream-owner-scoped} — resolve a capability-stream address's authority to its owner:
    // empty authority = the CALLING worker (a worker's own streams need no qualifier); a named
    // authority = that worker, gated by ancestry (reader must be the owner or an ancestor —
    // oversight flows down the tree). Unknown name or unpermitted reader = null → the caller
    // 404s without leaking existence.
    static async resolveStreamOwner(hostname: string | null | undefined, ctx: PlurnkSchemeContext): Promise<number | null> {
        if (hostname === null || hostname === undefined || hostname === "") return ctx.workerId;
        const named = await ctx.db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: hostname });
        if (named === undefined) return null;
        if (named.id === ctx.workerId) return named.id;
        const permitted = await ctx.db.owner_is_ancestor_or_self.get<{ permitted: number }>({ owner_id: named.id, reader_id: ctx.workerId });
        return permitted === undefined ? null : named.id;
    }
}
