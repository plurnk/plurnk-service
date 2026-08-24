// Producer-neutral runtime entry point ({§actor-boundary-doc-injection}). The
// harness opens an administrative loop and durable `_plurnk` turn in the
// addressed worker, then admits a real PLAN…SEND program through the same turn
// executor used by model and recovery programs. Generated state and its causal
// evidence therefore share one owner; neither is a hidden write or a kernel
// mirror.

import {
    UNKNOWN_POSITION,
    type FoldStatement,
    type PlanStatement,
    type PlurnkStatement,
    type SendStatement,
    type UrlPath,
} from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import Envelope from "./envelope.ts";
import Turn from "../core/Turn.ts";
import TurnOps from "../core/TurnOps.ts";
import Results, { OperationFailureError } from "../core/results.ts";

const logTurnTarget = (loopSequence: number, turnSequence: number): UrlPath => ({
    kind: "url",
    raw: `log:///${loopSequence}/${turnSequence}/*`,
    scheme: "log",
    username: null,
    password: null,
    hostname: null,
    port: null,
    pathname: `/${loopSequence}/${turnSequence}/*`,
    query: null,
    fragment: null,
});

export default class DispatchAsPlurnk {
    static async dispatch(
        engine: Engine,
        db: Db,
        workspaceId: number,
        workerId: number,
        statements: PlurnkStatement[],
        summary = "Reconcile generated Worker reference documents.",
    ): Promise<void> {
        if (statements.length === 0) return;
        const worker = await db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (worker?.workspace_id !== workspaceId) {
            throw new Error(`_plurnk dispatch worker ${workerId} does not belong to workspace ${workspaceId}`);
        }
        const loopId = await Envelope.ensureClientLoop(db, workerId);
        const loopSequence = (await db.engine_loop_sequence.get<{ sequence: number }>({
            loop_id: loopId,
        }))?.sequence;
        if (loopSequence === undefined) throw new Error(`_plurnk dispatch loop ${loopId} vanished`);
        // kind 'maintenance' — a receipt answers an asker, and these turns
        // have none: the packet render suppresses their successful rows
        // entirely (engine_render_log), while the rows stay durable and
        // READ-able and the self-FOLD below keeps client waterfalls tidy.
        const { id: turnId, sequence: turnSequence } = await Turn.open(db, {
            loopId,
            producer: "_plurnk",
            kind: "maintenance",
        });
        const serializedStatements = JSON.stringify(statements);
        let delimiter = `_plurnk${turnId}`;
        while (serializedStatements.includes(delimiter)) delimiter += "_";
        let turnOpen = true;
        const program: PlurnkStatement[] = [
            {
                op: "PLAN",
                delimiter,
                annotation: null,
                signal: null,
                target: null,
                lineMarker: null,
                body: [{ content: summary, priority: "medium", status: "in_progress" }],
                position: UNKNOWN_POSITION,
            } satisfies PlanStatement,
            ...statements,
            {
                op: "FOLD",
                delimiter: "0",
                annotation: null,
                signal: null,
                target: logTurnTarget(loopSequence, turnSequence),
                lineMarker: null,
                body: null,
                position: UNKNOWN_POSITION,
            } satisfies FoldStatement,
            {
                op: "SEND",
                delimiter: "0",
                annotation: null,
                signal: 200,
                target: null,
                lineMarker: null,
                body: { raw: "Generated Worker reference documents reconciled.", json: null },
                position: UNKNOWN_POSITION,
            } satisfies SendStatement,
        ];
        const source = TurnOps.renderInternal(program);
        const admitted = TurnOps.parseInternal(source);
        try {
            await engine.executeAdmittedTurn({
                statements: admitted,
                source,
                sourceFolded: true,
                sourceReasoningItems: [],
                origin: "_plurnk",
                workspaceId,
                workerId,
                loopId,
                turnId,
                fromSequence: 1,
                failOnOperationError: true,
            });
            turnOpen = false;
            await Envelope.closeClientLoop(db, loopId, { status: 200 });
        } catch (cause) {
            console.error(`_plurnk dispatch failed for worker ${workerId}, loop ${loopId}:`, cause);
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
            const closeFailures: unknown[] = [];
            if (turnOpen) {
                try {
                    await Turn.complete(db, turnId, failure.status);
                    turnOpen = false;
                } catch (turnCause) {
                    closeFailures.push(turnCause);
                }
            }
            try {
                await Envelope.closeClientLoop(db, loopId, failure);
            } catch (closeCause) {
                closeFailures.push(closeCause);
            }
            if (closeFailures.length > 0) {
                throw new AggregateError(
                    [cause, ...closeFailures],
                    `plurnk actor turn ${turnId} failed and could not be closed cleanly`,
                );
            }
            throw cause;
        }
    }
}
