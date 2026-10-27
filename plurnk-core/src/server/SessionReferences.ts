import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { Db } from "../core/Db.ts";
import SessionName from "../core/SessionName.ts";
import Envelope from "./envelope.ts";

type Reference = Parameters<ApplicationPort["readSessionReference"]>[0];
type Binding = NonNullable<Awaited<ReturnType<ApplicationPort["readSessionReference"]>>>;

/** {§session-external-reference} All three records are committed by the allocation view. */
export default class SessionReferences {
    static async read(db: Db, { namespace, reference }: Reference): Promise<Binding | null> {
        return await db.session_reference_read.get<Binding>({ namespace, reference }) ?? null;
    }

    static async ensure(db: Db, { namespace, reference }: Reference): Promise<{ binding: Binding; created: boolean }> {
        while (true) {
            const allocated = await db.session_reference_allocate.get({
                namespace, reference,
                workspace_name: Envelope.generateWorkspaceName(),
                session_name: SessionName.short(),
            });
            const binding = await SessionReferences.read(db, { namespace, reference });
            if (binding !== null) return { binding, created: allocated !== undefined };
            if (allocated !== undefined) throw new Error("Allocated session reference is absent after commit.");
            // A colliding automatic workspace name created nothing; redraw under {§execution-output-identity}.
        }
    }
}
