import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { Db } from "../core/Db.ts";
import WorkerName from "../core/WorkerName.ts";
import Envelope from "./envelope.ts";

type Reference = Parameters<ApplicationPort["readWorkerReference"]>[0];
type Binding = NonNullable<Awaited<ReturnType<ApplicationPort["readWorkerReference"]>>>;

/** {§worker-external-reference} All three records are committed by the allocation view. */
export default class WorkerReferences {
    static async read(db: Db, { namespace, reference }: Reference): Promise<Binding | null> {
        return await db.worker_reference_read.get<Binding>({ namespace, reference }) ?? null;
    }

    static async ensure(db: Db, { namespace, reference }: Reference): Promise<{ binding: Binding; created: boolean }> {
        while (true) {
            const allocated = await db.worker_reference_allocate.get({
                namespace, reference,
                workspace_name: Envelope.generateWorkspaceName(),
                worker_name: WorkerName.short(),
            });
            const binding = await WorkerReferences.read(db, { namespace, reference });
            if (binding !== null) return { binding, created: allocated !== undefined };
            if (allocated !== undefined) throw new Error("Allocated worker reference is absent after commit.");
            // A colliding automatic workspace name created nothing; redraw under {§workspace-auto-name}.
        }
    }
}
