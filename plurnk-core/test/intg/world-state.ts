// The WorldState invariant harness ({§fs-world-state}) — coverage that closes the CLASS,
// not the instance: op-outcome tests check what an op returned; this checks what the world
// looks like after. Run as a test epilogue and at every soak turn boundary. Pure-db,
// read-only; a violation names its law and its row.
import type { Db } from "../../src/core/Db.ts";
import Namespace from "../../src/core/namespace.ts";

export interface WorldStateViolation { invariant: string; detail: string }

export default class WorldState {
    static async check(db: Db): Promise<WorldStateViolation[]> {
        const violations: WorldStateViolation[] = [];

        const dups = await db.ws_dup_identities.all<{ workspace_id: number; owner_id: number; scheme: string; authority: string; pathname: string; n: number }>({});
        for (const d of dups) {
            violations.push({ invariant: "{§entry-identity-no-null}", detail: `identity (ws ${d.workspace_id}, owner ${d.owner_id}, ${d.scheme}, ${d.authority}, ${d.pathname}) holds ${d.n} rows` });
        }

        const keys = await db.ws_file_keys.all<{ workspace_id: number; pathname: string; project_root: string | null }>({});
        for (const k of keys) {
            if (!Namespace.isCanonical(k.pathname, k.project_root)) {
                violations.push({ invariant: "{§fs-canonical-name}", detail: `ws ${k.workspace_id}: stored key '${k.pathname}' is not its own canon` });
            }
        }

        const orphanChannels = await db.ws_orphan_channels.get<{ n: number }>({});
        if ((orphanChannels?.n ?? 0) > 0) violations.push({ invariant: "orphan-freedom", detail: `${orphanChannels?.n} entry_channels rows without a parent entry` });

        const alien = await db.ws_alien_origin.all<{ workspace_id: number; pathname: string; membership_origin: string }>({});
        for (const a of alien) {
            violations.push({ invariant: "{§fs-write-surface} admission", detail: `ws ${a.workspace_id}: '${a.pathname}' carries alien grantor '${a.membership_origin}'` });
        }

        const sigLeak = await db.ws_sig_on_nonfile.get<{ n: number }>({});
        if ((sigLeak?.n ?? 0) > 0) violations.push({ invariant: "sig-coherence", detail: `${sigLeak?.n} non-file rows carry synced_sig` });

        return violations;
    }

    // The soak's delta half: total entries rows — an idle turn grows this by ZERO.
    static async entryCount(db: Db): Promise<number> {
        return (await db.ws_entry_count.get<{ n: number }>({}))?.n ?? 0;
    }
}
