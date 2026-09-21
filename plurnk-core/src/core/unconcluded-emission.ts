import type { Db } from "./Db.ts";

// The text a turn left unconcluded, and the address it already lives at.
export type UnconcludedEmission = { readonly retained: string; readonly resource: string };

// {§conclusion-recovery} {§terminal-evidence} — the most recent inference turn (before `before`, or
// the loop's last) whose admitted program was empty and which kept something to say. Read from the
// record, never remembered, so neither the recovery offer nor a terminal depends on process memory
// surviving between the turn and its reader.
export const unconcludedEmission = async (db: Db, loopId: number, before: number | null = null): Promise<UnconcludedEmission | null> => {
    const row = await db.engine_unconcluded_emission.get<{ retained: string | null; resource: string }>({
        loop_id: loopId,
        before,
    });
    if (row === undefined || row.retained === null) return null;
    const retained = row.retained.trim();
    return retained.length === 0 ? null : { retained, resource: row.resource };
};
