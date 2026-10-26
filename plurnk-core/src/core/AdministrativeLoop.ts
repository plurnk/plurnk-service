import type { Db } from "./Db.ts";

// {§runtime-bookkeeping-policy} Turn purpose governs bookkeeping.
export default class AdministrativeLoop {
    // `source` is the actor that opened it: a person's address for their client operation
    // ({§actor-boundary-client-operations}), absent for the daemon's own.
    static async open(db: Db, sessionId: number, source?: string): Promise<{ id: number; sequence: number }> {
        const loop = await db.envelope_insert_client_loop.get<{ id: number; sequence: number }>({
            session_id: sessionId,
            prompt_source: source ?? null,
        });
        if (loop === undefined) throw new Error("administrative loop insert returned no row");
        return loop;
    }
}
