// Self-hosting keystone (SPEC {§actor-boundary}, {§actor-boundary-self-hosting}): the runtime acting as an ordinary `plurnk`
// actor. Uses the workspace's reserved plurnk worker, opens an ephemeral loop+turn,
// and fires ops through Engine.dispatch with origin=_plurnk — the same path the
// model and clients use. Mirrors _dispatchAsClient, but the work is the
// runtime's own (e.g. materializing operator doc entries). The ops land in the
// plurnk worker's log, NOT the model's; other workers see only the resulting
// commons-owned entries through the shared filesystem ({§machine-processes}), never the log.

import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import Envelope from "./envelope.ts";
import JournalTurn from "../core/JournalTurn.ts";
import Results, { OperationFailureError } from "../core/results.ts";

export default class DispatchAsPlurnk {
    static async dispatch(engine: Engine, db: Db, workspaceId: number, statements: PlurnkStatement[]): Promise<void> {
        if (statements.length === 0) return;
        const workerId = await Envelope.ensurePlurnkWorker(db, workspaceId);
        const loopId = await Envelope.ensureClientLoop(db, workerId);
        const { id: turnId } = await JournalTurn.insert(db, loopId);
        let sequence = 1;
        try {
            for (const statement of statements) {
                const result = await engine.dispatch({
                    statement, workspaceId, workerId, loopId, turnId,
                    sequence: sequence++, origin: "_plurnk",
                });
                if (result.status >= 400) {
                    throw new OperationFailureError(result);
                }
            }
            await Envelope.closeClientLoop(db, loopId, { status: 200 });
        } catch (cause) {
            console.error(`Plurnk actor dispatch failed for loop ${loopId}:`, cause);
            const failure = cause instanceof OperationFailureError
                ? cause.result
                : Results.failure(
                    "daemon:plurnk-actor",
                    "dispatch-threw",
                    500,
                    "The Plurnk actor failed outside its operation result contract.",
                    {},
                    {
                        stage: "dispatch",
                        retryable: false,
                    },
                );
            try {
                await Envelope.closeClientLoop(db, loopId, failure);
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
