import { TurnDisposition } from "@plurnk/plurnk-contracts";
// Durable operation recording: one log row per dispatched statement, split out of Dispatcher.
import type { ParsedPath, PlurnkStatement } from "@plurnk/plurnk-contracts";
import { execRouteOf } from "../schemes/exec-runtime.ts";
import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import Results from "./results.ts";
import DurableStatement from "./DurableStatement.ts";
import type { LogCurationPlan } from "../schemes/Log.ts";
import { primaryLineMarkerOf, primaryTargetOf } from "./statement-primary.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import type { DispatchResult } from "./Dispatcher.ts";

export default class LogWriter {
    readonly #db: Db;
    readonly #weighContent: (text: string) => number;
    readonly #extractTarget: (path: ParsedPath | null, workspaceId: number) => { scheme: string | null; username: string | null; password: string | null; hostname: string | null; port: number | null; pathname: string | null; query: string | null; fragment: string | null; };
    readonly #canonColumns: (target: { scheme: string | null; pathname: string | null }, workspaceId: number) => Promise<void>;
    readonly #signalToJson: (signal: unknown) => string | null;
    readonly #isProposal: (statement: PlurnkStatement, result: DispatchResult) => boolean;

    constructor({ db, weighContent, extractTarget, canonColumns, signalToJson, isProposal }: {
        db: Db;
        weighContent: (text: string) => number;
        extractTarget: (path: ParsedPath | null, workspaceId: number) => { scheme: string | null; username: string | null; password: string | null; hostname: string | null; port: number | null; pathname: string | null; query: string | null; fragment: string | null; };
        canonColumns: (target: { scheme: string | null; pathname: string | null }, workspaceId: number) => Promise<void>;
        signalToJson: (signal: unknown) => string | null;
        isProposal: (statement: PlurnkStatement, result: DispatchResult) => boolean;
    }) {
        this.#db = db;
        this.#weighContent = weighContent;
        this.#extractTarget = extractTarget;
        this.#canonColumns = canonColumns;
        this.#signalToJson = signalToJson;
        this.#isProposal = isProposal;
    }

    async writeLog(context: Parameters<LogWriter["prepareLog"]>[0]): Promise<number> {
        const draft = await this.prepareLog(context);
        await this.#canonColumns(draft, context.workspaceId);
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>(draft);
        if (row === undefined) throw new Error("Dispatcher.#writeLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // {§reasoning-initial-read} — candidate receipt and committed receipt share
    // this representation. Preparing it neither writes nor publishes a log row.
    async prepareLog({
        statement, result, workspaceId, workerId, loopId, turnId, sequence, origin, curationPlan, modelCallId,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; workerId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
        curationPlan: LogCurationPlan | null;
        modelCallId: number | null;
    }) {
        const durableStatement = DurableStatement.project(statement);
        const target = this.#extractTarget(primaryTargetOf(durableStatement), workspaceId);
        const lineMarker = primaryLineMarkerOf(durableStatement);
        const lineMarkerJson = lineMarker !== null
            ? JSON.stringify(lineMarker)
            : null;
        // A proposal (status 202 from a side-effecting op) is written to the log in
        // state='proposed' until the proposal lifecycle resolves it; attrs holds the
        // scheme-supplied payload (file diff, exec command, etc.) the client renders
        // for review and the scheme consumes on accept. A waiting TASK is
        // parked, not proposed (#isProposal) → state='resolved'.
        const isProposed = this.#isProposal(statement, result);
        let attrsObj: Record<string, unknown> = (result.attrs !== undefined && result.attrs !== null)
            ? { ...(result.attrs as Record<string, unknown>) }
            : {};
        if (curationPlan !== null) {
            if (Object.hasOwn(attrsObj, "__plurnk_curation")) {
                throw new Error("Dispatcher.#writeLog: result attrs collide with private log curation state");
            }
            attrsObj.__plurnk_curation = {
                targets: curationPlan.targets,
                add: curationPlan.add,
                remove: curationPlan.remove,
            };
        }
        const seqs = statement.op === "EXEC" || result.problem !== undefined
            ? await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                loop_id: loopId,
                turn_id: turnId,
            })
            : undefined;
        if ((statement.op === "EXEC" || result.problem !== undefined) && seqs === undefined) {
            throw new Error(`Dispatcher.#writeLog: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
        }
        if (statement.op === "READ") Results.assertReadResult(result);
        const coordinate = seqs === undefined ? null : LogEntryProjection.coordinate(
            `${seqs.loop_seq}/${seqs.turn_seq}/${sequence}`,
            { op: durableStatement.op, origin, tx: durableStatement, attrs: attrsObj },
        );
        if (result.problem !== undefined && seqs !== undefined) {
            Results.attachInstance(result, `log:///${coordinate}`);
        } else {
            Results.assert(result);
        }
        // {§log-coordinate-hierarchy}: the stream and its invocation share one
        // item path. The stream link never replaces the authored input target.
        if (statement.op === "EXEC") {
            if (coordinate === null) throw new Error("Dispatcher.#writeLog: EXEC coordinate was not resolved");
            const { runtime } = execRouteOf(statement);
            const coordPathname = `/${coordinate}`;
            attrsObj.pathname = coordPathname;
            attrsObj.stream = `${runtime}://${coordPathname}`;
            // Mutate the in-memory result.attrs too: the dispatch path
            // hands originalResult.attrs to handler.applyResolution after
            // proposal accept (see ProposalLifecycle.workerApply). Both views —
            // the stored row AND the in-memory proposal — need the same
            // pathname so applyResolution writes the entry at the same URI.
            if (result.attrs !== undefined && result.attrs !== null) {
                (result.attrs as Record<string, unknown>).pathname = coordPathname;
            }
        }
        const attrs = JSON.stringify(attrsObj);
        const txJson = JSON.stringify(durableStatement);
        const rxJson = JSON.stringify(result);
        return {
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: sequence,
            origin,
            source: null,  // dispatch entries are self-authored; {§env-delta} deltas set this
            model_call_id: modelCallId,
            op: durableStatement.op,
            signal: this.#signalToJson(TurnDisposition.is(durableStatement) ? TurnDisposition.status(durableStatement) : null),
            scheme: target.scheme,
            username: target.username,
            password: target.password,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            query: target.query,
            fragment: target.fragment,
            lineMarker: lineMarkerJson,
            tx: txJson,
            mimetype_tx: "application/json",
            rx: rxJson,
            mimetype_rx: "application/json",
            status_rx: result.status,
            weight: LogBody.weight({
                op: durableStatement.op,
                attrs,
                tx: txJson,
                rx: rxJson,
                mimetypeTx: "application/json",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: isProposed ? "proposed" : "resolved",
            outcome: null,
            attrs,
            initial_folded: LogVisibility.serialize(LogVisibility.OPEN),
        };
    }

}

export type LogEntryDraft = Awaited<ReturnType<LogWriter["prepareLog"]>>;
