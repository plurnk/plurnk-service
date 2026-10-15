import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import AdministrativeLoop from "../../src/core/AdministrativeLoop.ts";
import type { Db } from "../../src/core/Db.ts";
import type Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import Envelope from "../../src/server/envelope.ts";

// A test reads a resource the way a client does ({§connection-lifecycle}): one administrative loop on
// the reading worker, one client operation turn, one durable row. Resource identity never depends on
// the reader ({§turn-source-resources}), so a test whose subject's log and packets must stay as they
// were reads through another worker of the same workspace.
export const clientRead = async (
    engine: Engine,
    db: Db,
    context: { readonly workspaceId: number; readonly workerId: number; readonly statement: PlurnkStatement },
): Promise<Awaited<ReturnType<Engine["dispatch"]>>> => {
    const loop = await AdministrativeLoop.open(db, context.workerId);
    const turn = await Turn.open(db, { loopId: loop.id, producer: "client", kind: "operation" });
    const { statement, workspaceId, workerId } = context;
    const result = await engine.dispatch({ statement, workspaceId, workerId, loopId: loop.id, turnId: turn.id, sequence: 1, origin: "client" });
    await Turn.complete(db, turn.id, result.status);
    await Envelope.closeClientLoop(db, loop.id, { status: 200 });
    return result;
};
