import { TurnDisposition, isExecution, isRecord, writtenOp } from "@plurnk/plurnk-contracts";
// Durable operation recording: one log row per dispatched statement, split out of Dispatcher.
import type { LogAddressColumns, ParsedPath, PlurnkStatement } from "@plurnk/plurnk-contracts";
import ExecutionOutputs from "./ExecutionOutputs.ts";
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
import { STORAGE_MAXIMUM_BYTES, sqliteCharacterCount } from "./file-materialization.ts";

// The columns `engine_insert_log_entry` takes, as one dispatch writes them.
export interface LogRecord extends LogAddressColumns, Record<string, unknown> {
    session_id: number; loop_id: number; turn_id: number; sequence: number;
    origin: WriterTier; source: string | null; model_call_id: number | null;
    op: string; signal: string | null;
    lineMarker: string | null;
    tx: string; mimetype_tx: string; rx: string; mimetype_rx: string; status_rx: number;
    weight: number; state: string; outcome: null; attrs: string; initial_folded: string;
}

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

    static payloadLimitFailure(observedCharacters: number, retainedAttrs?: Readonly<Record<string, unknown>>): DispatchResult {
        const result = Results.failure(
            "engine:log",
            "result-payload-too-large",
            413,
            `Operation payload is ${observedCharacters} characters and exceeds the ${STORAGE_MAXIMUM_BYTES}-character log storage limit.`,
            {},
            {
                maximumCharacters: STORAGE_MAXIMUM_BYTES,
                observedCharacters,
                retryable: false,
            },
        );
        return retainedAttrs === undefined || Object.keys(retainedAttrs).length === 0
            ? result
            : { ...result, attrs: retainedAttrs };
    }

    async writeLog(args: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; sessionId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
        curationPlan: LogCurationPlan | null;
        modelCallId: number | null;
        emissionIndex?: number;
    }): Promise<number> {
        return (await this.writeDispatchedLog(args)).id;
    }

    async writeDispatchedLog({
        statement, result, workspaceId, sessionId, loopId, turnId, sequence, origin, curationPlan, modelCallId, emissionIndex,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; sessionId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
        curationPlan: LogCurationPlan | null;
        modelCallId: number | null;
        emissionIndex?: number;
    }): Promise<{ id: number; result: DispatchResult }> {
        if (isExecution(statement) && result.status === 202 && result.attrs !== undefined) {
            const { attrs } = result;
            if (!isRecord(attrs) || attrs.pathname !== "") throw new Error("Prepared execution must have an unclaimed output address.");
            attrs.pathname = await ExecutionOutputs.claim(this.#db, workspaceId, execRouteOf(statement).runtime);
        }
        const { record, result: effectiveResult } = await this.#recordWithResult({
            statement, result, workspaceId, sessionId, loopId, turnId, sequence, origin, curationPlan, modelCallId, emissionIndex,
        });
        await this.#canonColumns(record, workspaceId);
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>(record);
        if (row === undefined) throw new Error("Dispatcher.#writeLog: INSERT ... RETURNING produced no row");
        return { id: row.id, result: effectiveResult };
    }

    // The row a dispatch would write, before it is written: the fit test renders it to weigh it
    // ({§tokenomics}) and writeLog inserts it. A failed result gets its instance here.
    async record(args: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; sessionId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
        curationPlan: LogCurationPlan | null;
        modelCallId: number | null;
        emissionIndex?: number;
    }): Promise<LogRecord> {
        return (await this.#recordWithResult(args)).record;
    }

    async #recordWithResult({
        statement, result, workspaceId, sessionId, loopId, turnId, sequence, origin, curationPlan, modelCallId, emissionIndex,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; sessionId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
        curationPlan: LogCurationPlan | null;
        modelCallId: number | null;
        emissionIndex?: number;
    }): Promise<{ record: LogRecord; result: DispatchResult }> {
        let durableStatement = DurableStatement.project(statement);
        const target = this.#extractTarget(primaryTargetOf(durableStatement), workspaceId);
        const lineMarker = primaryLineMarkerOf(durableStatement);
        const lineMarkerJson = lineMarker !== null
            ? JSON.stringify(lineMarker)
            : null;
        // A proposal (status 202 from a side-effecting op) is written to the log in
        // state='proposed' until the proposal lifecycle resolves it; attrs holds the
        // scheme-supplied payload (file diff, exec command, etc.) the client renders
        // for review and the scheme consumes on accept. A WAIT is
        // parked, not proposed (#isProposal) → state='resolved'.
        let effectiveResult = result;
        let isProposed = this.#isProposal(statement, effectiveResult);
        let attrsObj: Record<string, unknown> = isRecord(effectiveResult.attrs) ? { ...effectiveResult.attrs } : {};
        if (Object.hasOwn(attrsObj, "emissionIndex")) throw new Error("Result attrs collide with content-operation provenance.");
        if (emissionIndex !== undefined) attrsObj.emissionIndex = emissionIndex;
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
        const fetchSeqs = () => this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
            loop_id: loopId,
            turn_id: turnId,
        });
        let seqs = isExecution(statement) || effectiveResult.problem !== undefined
            ? await fetchSeqs()
            : undefined;
        if ((isExecution(statement) || effectiveResult.problem !== undefined) && seqs === undefined) {
            throw new Error(`Dispatcher.#writeLog: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
        }
        if (statement.op === "read") Results.assertReadResult(effectiveResult);
        const coordinateOf = (currentSeqs: { loop_seq: number; turn_seq: number }, currentAttrs: Record<string, unknown>) =>
            LogEntryProjection.coordinate(
                `${currentSeqs.loop_seq}/${currentSeqs.turn_seq}/${sequence}`,
                { op: writtenOp(durableStatement), origin, tx: durableStatement, attrs: currentAttrs },
            );
        if (effectiveResult.problem !== undefined && effectiveResult.problem.instance === undefined && seqs !== undefined) {
            Results.attachInstance(effectiveResult, `log:///${coordinateOf(seqs, attrsObj)}`);
        } else {
            Results.assert(effectiveResult);
        }
        if (isExecution(statement) && typeof attrsObj.pathname === "string" && attrsObj.pathname !== "") {
            attrsObj.stream = `${execRouteOf(statement).runtime}://${attrsObj.pathname}`;
            if (seqs === undefined) throw new Error("Execution provenance has no loop/turn coordinate.");
            attrsObj.coordinate = { loop_seq: seqs.loop_seq, turn_seq: seqs.turn_seq, sequence };
            if (isRecord(effectiveResult.attrs)) effectiveResult.attrs.coordinate = attrsObj.coordinate;
        }
        // Strip internal `attrs` before serializing wire `rx` so proposal payloads are not
        // duplicated inside `contents.content` alongside `log_entry_rows.attrs`.
        const { attrs: _wireAttrs, ...wireResult } = effectiveResult;
        let txJson = JSON.stringify(durableStatement);
        let rxJson = JSON.stringify(wireResult);
        const txChars = txJson.length > STORAGE_MAXIMUM_BYTES ? sqliteCharacterCount(txJson) : txJson.length;
        const rxChars = rxJson.length > STORAGE_MAXIMUM_BYTES ? sqliteCharacterCount(rxJson) : rxJson.length;
        if (txChars > STORAGE_MAXIMUM_BYTES || rxChars > STORAGE_MAXIMUM_BYTES) {
            const retainedAttrs: Record<string, unknown> = {};
            if (emissionIndex !== undefined) retainedAttrs.emissionIndex = emissionIndex;
            if (Object.hasOwn(attrsObj, "fanout")) retainedAttrs.fanout = attrsObj.fanout;
            effectiveResult = LogWriter.payloadLimitFailure(Math.max(txChars, rxChars), retainedAttrs);
            isProposed = false;
            attrsObj = retainedAttrs;
            if (txChars > STORAGE_MAXIMUM_BYTES && "body" in durableStatement && typeof durableStatement.body === "string") {
                durableStatement = { ...durableStatement, body: "" };
                txJson = JSON.stringify(durableStatement);
            }
            seqs ??= await fetchSeqs();
            if (seqs === undefined) {
                throw new Error(`Dispatcher.#writeLog: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
            }
            Results.attachInstance(effectiveResult, `log:///${coordinateOf(seqs, attrsObj)}`);
            const { attrs: _failedAttrs, ...failedWire } = effectiveResult;
            rxJson = JSON.stringify(failedWire);
        }
        const attrs = JSON.stringify(attrsObj);
        const record: LogRecord = {
            session_id: sessionId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: sequence,
            origin,
            source: null,  // dispatch entries are self-authored; {§env-delta} deltas set this
            model_call_id: modelCallId,
            op: writtenOp(durableStatement),
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
            status_rx: effectiveResult.status,
            weight: LogBody.weight({
                op: writtenOp(durableStatement),
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
        return { record, result: effectiveResult };
    }

}
