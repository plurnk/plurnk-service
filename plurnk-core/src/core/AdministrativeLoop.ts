import type { Db } from "./Db.ts";
import LoopPolicies from "./LoopPolicies.ts";

// One action allocates one administrative loop: a client's direct statements, or the runtime's own
// narration. It runs no model, yet it is a loop, and every loop states its policy
// ({§loop-policy-composition}): its creator said nothing, so the panel speaks.
export default class AdministrativeLoop {
    static async open(db: Db, workerId: number): Promise<{ id: number; sequence: number }> {
        const loop = await db.envelope_insert_client_loop.get<{ id: number; sequence: number }>({
            worker_id: workerId,
            policy: JSON.stringify(LoopPolicies.compose({})),
        });
        if (loop === undefined) throw new Error("administrative loop insert returned no row");
        return loop;
    }
}
