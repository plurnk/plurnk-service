import type { Db } from "./Db.ts";

// The text a turn left unconcluded, and the address it already lives at.
export type UnconcludedEmission = { readonly retained: string; readonly resource: string };

// {§terminal-evidence}: the last inference turn's text when it authored no operations.
export const unconcludedEmission = async (db: Db, loopId: number): Promise<UnconcludedEmission | null> => {
    const row = await db.engine_unconcluded_emission.get<{ retained: string | null; resource: string }>({
        loop_id: loopId,
    });
    if (row === undefined || row.retained === null) return null;
    const retained = row.retained.trim();
    return retained.length === 0 ? null : { retained, resource: row.resource };
};
