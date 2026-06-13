// Self-hosting keystone (SPEC §actor-boundary): the runtime acting as an ordinary `plurnk`
// actor. Uses the session's reserved plurnk run, opens an ephemeral loop+turn,
// and fires ops through Engine.dispatch with origin=plurnk — the same path the
// model and clients use. Mirrors _dispatchAsClient, but the work is the
// runtime's own (e.g. materializing operator doc entries). The ops land in the
// plurnk run's log, NOT the model's; other runs see only the resulting
// session-scoped entries through the shared filesystem (§machine-processes), never the log.

import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Db } from "../../core/Db.ts";
import type Engine from "../../core/Engine.ts";
import Envelope from "../envelope.ts";
import ClientTurn from "../clientTurn.ts";

export default class DispatchAsPlurnk {
    static async dispatch(engine: Engine, db: Db, sessionId: number, statements: PlurnkStatement[]): Promise<void> {
        if (statements.length === 0) return;
        const runId = await Envelope.ensurePlurnkRun(db, sessionId);
        const loopId = await Envelope.ensureClientLoop(db, runId);
        const turnId = await ClientTurn.insertClientTurn(db, loopId);
        let sequence = 1;
        for (const statement of statements) {
            await engine.dispatch({ statement, sessionId, runId, loopId, turnId, sequence: sequence++, origin: "plurnk" });
        }
    }
}
