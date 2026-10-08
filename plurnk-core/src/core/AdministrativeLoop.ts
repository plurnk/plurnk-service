import type { Db } from "./Db.ts";

// {§runtime-bookkeeping-policy} Turn purpose governs bookkeeping.
export default class AdministrativeLoop {
    static async open(db: Db, workerId: number): Promise<{ id: number; sequence: number }> {
        const loop = await db.envelope_insert_client_loop.get<{ id: number; sequence: number }>({
            worker_id: workerId,
        });
        if (loop === undefined) throw new Error("administrative loop insert returned no row");
        return loop;
    }
}
