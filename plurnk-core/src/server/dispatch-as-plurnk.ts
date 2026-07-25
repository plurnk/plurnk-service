// Self-hosting keystone (SPEC §actor-boundary, §actor-boundary-self-hosting): the runtime acting as an ordinary `plurnk`
// actor. Uses the workspace's reserved plurnk worker, opens an ephemeral loop+turn,
// and fires ops through Engine.dispatch with origin=plurnk — the same path the
// model and clients use. Mirrors _dispatchAsClient, but the work is the
// runtime's own (e.g. materializing operator doc entries). The ops land in the
// plurnk worker's log, NOT the model's; other workers see only the resulting
// workspace-scoped entries through the shared filesystem (§machine-processes), never the log.

import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import Envelope from "./envelope.ts";
import ClientTurn from "./clientTurn.ts";

export default class DispatchAsPlurnk {
    static async dispatch(engine: Engine, db: Db, workspaceId: number, statements: PlurnkStatement[]): Promise<void> {
        if (statements.length === 0) return;
        const workerId = await Envelope.ensurePlurnkWorker(db, workspaceId);
        const loopId = await Envelope.ensureClientLoop(db, workerId);
        const turnId = await ClientTurn.insertClientTurn(db, loopId);
        let sequence = 1;
        try {
            for (const statement of statements) {
                const result = await engine.dispatch({
                    statement, workspaceId, workerId, loopId, turnId,
                    sequence: sequence++, origin: "plurnk",
                });
                if (result.status >= 400) {
                    throw new Error(`plurnk actor ${statement.op} failed with status ${result.status}`);
                }
            }
            await Envelope.closeClientLoop(db, loopId, 200);
        } catch (cause) {
            try {
                await Envelope.closeClientLoop(db, loopId, 499);
            } catch (closeCause) {
                throw new AggregateError(
                    [cause, closeCause],
                    `plurnk actor loop ${loopId} failed and could not be closed`,
                );
            }
            throw cause;
        }
    }
}
