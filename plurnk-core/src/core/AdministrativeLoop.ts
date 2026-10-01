import type { Db } from "./Db.ts";
import LoopPolicies from "./LoopPolicies.ts";

// {§loop-policy-composition} {§runtime-bookkeeping-policy}
export default class AdministrativeLoop {
    static async open(db: Db, workerId: number, purpose: "client" | "runtime"): Promise<{ id: number; sequence: number }> {
        const loop = await db.envelope_insert_client_loop.get<{ id: number; sequence: number }>({
            worker_id: workerId,
            policy: JSON.stringify(LoopPolicies.compose(purpose === "runtime"
                ? { attended: false, proposals: "reject" }
                : {})),
        });
        if (loop === undefined) throw new Error("administrative loop insert returned no row");
        return loop;
    }
}
