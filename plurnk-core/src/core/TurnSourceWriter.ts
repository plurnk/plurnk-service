import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import { UNKNOWN_POSITION, type BareStatement, type PlurnkStatement, type ReadStatement } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError } from "@plurnk/plurnk-schemes";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LogWriter from "./LogWriter.ts";
import type DataStatementRunner from "./DataStatementRunner.ts";
import type { DispatchContext, DispatchResult } from "./Dispatcher.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { ContextFit } from "./ContextFit.ts";
import LogBody from "./LogBody.ts";
import BodyPreview from "../content/body-preview.ts";
import ReadResolve from "../content/read-resolve.ts";
import LogVisibility from "./LogVisibility.ts";
import DurableStatement from "./DurableStatement.ts";
import ResourceBindings from "./ResourceBindings.ts";
import Results, { OperationFailureError } from "./results.ts";
import { schemeNameOf } from "./plurnk-uri.ts";

export default class TurnSourceWriter {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #weighContent: (text: string) => number;
    readonly #logWriter: LogWriter;
    readonly #dataRun: DataStatementRunner;
    readonly #buildSchemeCtx: (context: Pick<DispatchContext, "workspaceId" | "sessionId" | "loopId" | "turnId" | "sequence" | "origin">) => PlurnkSchemeContext;
    readonly #checkCapabilities: (statement: PlurnkStatement, ctx: PlurnkSchemeContext) => Promise<DispatchResult | null>;
    readonly #operationEvent: (context: Pick<DispatchContext, "workspaceId" | "sessionId" | "loopId" | "turnId" | "sequence" | "origin" | "statement">, phase: "started" | "settled", result?: DispatchResult) => Promise<void>;
    readonly #noticeFilePaths: (context: Pick<DispatchContext, "statement" | "origin" | "workspaceId" | "sessionId" | "loopId">) => Promise<void>;
    readonly #notifySettled: (context: DispatchContext, logEntryId: number) => Promise<void>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    constructor({
        db,
        schemes,
        weighContent,
        logWriter,
        dataRun,
        buildSchemeCtx,
        checkCapabilities,
        operationEvent,
        noticeFilePaths,
        notifySettled,
        failure,
    }: {
        db: Db;
        schemes: SchemeRegistry;
        weighContent: (text: string) => number;
        logWriter: LogWriter;
        dataRun: DataStatementRunner;
        buildSchemeCtx: (context: Pick<DispatchContext, "workspaceId" | "sessionId" | "loopId" | "turnId" | "sequence" | "origin">) => PlurnkSchemeContext;
        checkCapabilities: (statement: PlurnkStatement, ctx: PlurnkSchemeContext) => Promise<DispatchResult | null>;
        operationEvent: (context: Pick<DispatchContext, "workspaceId" | "sessionId" | "loopId" | "turnId" | "sequence" | "origin" | "statement">, phase: "started" | "settled", result?: DispatchResult) => Promise<void>;
        noticeFilePaths: (context: Pick<DispatchContext, "statement" | "origin" | "workspaceId" | "sessionId" | "loopId">) => Promise<void>;
        notifySettled: (context: DispatchContext, logEntryId: number) => Promise<void>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#weighContent = weighContent;
        this.#logWriter = logWriter;
        this.#dataRun = dataRun;
        this.#buildSchemeCtx = buildSchemeCtx;
        this.#checkCapabilities = checkCapabilities;
        this.#operationEvent = operationEvent;
        this.#noticeFilePaths = noticeFilePaths;
        this.#notifySettled = notifySettled;
        this.#failure = failure;
    }

    // {§turn-source-resources} — rejected provider bytes, never an admitted program.
    async writeEmissionAttempt({ verbatim, sessionId, loopId, turnId, sequence, modelCallId }: {
        verbatim: string; sessionId: number; loopId: number; turnId: number; sequence: number;
        modelCallId: number;
    }): Promise<number> {
        const durableAttrs = { kind: "emissionAttempt" };
        const rx = JSON.stringify({ content: verbatim, mimetype: "text/vnd.plurnk" });
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence,
            origin: "model", source: null, model_call_id: modelCallId,
            op: null, signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/vnd.plurnk",
            rx,
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: LogBody.weight({
                op: null,
                attrs: durableAttrs,
                tx: "",
                rx,
                mimetypeTx: "text/vnd.plurnk",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "resolved", outcome: null,
            attrs: JSON.stringify(durableAttrs),
            initial_folded: LogVisibility.serialize(LogVisibility.FOLDED),
        });
        if (row === undefined) throw new Error("Dispatcher.writeEmissionAttempt: insert returned no row");
        return row.id;
    }

    // {§turn-source-resources} — the announcement of an admitted emission: the harness's born-folded READ of its
    // own turn's ops source, whose frozen body is the complete canonical content program.
    async writeEmission({ content, sessionName, loopSeq, turnSeq, sessionId, loopId, turnId, sequence }: {
        content: string; sessionName: string; loopSeq: number; turnSeq: number;
        sessionId: number; loopId: number; turnId: number; sequence: number;
    }): Promise<number> {
        if (content.length === 0) throw new Error("Dispatcher.writeEmission: an admitted emission is never empty");
        const pathname = `/${loopSeq}/${turnSeq}`;
        const statement: ReadStatement = {
            op: "READ", aside: null, metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION,
            target: {
                kind: "url", raw: `ops://${sessionName}${pathname}`, scheme: "ops",
                username: null, password: null, hostname: sessionName, port: null, pathname, query: null, fragment: null,
            },
        };
        const durableAttrs = { kind: "emission" };
        const tx = JSON.stringify(DurableStatement.project(statement));
        const rx = JSON.stringify({ status: 200, content, mimetype: "text/vnd.plurnk" });
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence,
            origin: "_plurnk", source: null, model_call_id: null,
            op: "READ", signal: null,
            scheme: "ops", username: null, password: null, hostname: sessionName, port: null,
            pathname, query: null, fragment: null, lineMarker: null,
            tx, mimetype_tx: "application/json",
            rx,
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: LogBody.weight({
                op: "READ",
                attrs: durableAttrs,
                tx,
                rx,
                mimetypeTx: "application/json",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "resolved", outcome: null,
            attrs: JSON.stringify(durableAttrs),
            initial_folded: LogVisibility.serialize(LogVisibility.FOLDED),
        });
        if (row === undefined) throw new Error("Dispatcher.writeEmission: insert returned no row");
        return row.id;
    }

    // {§turn-source-resources} — the model's own reasoning, landed as the harness's READ of the turn's reasoning
    // source immediately before the emission row: whole when it fits the row's page, otherwise its last page
    // (#999: a turn's conclusions sit at its end), only when the packet has room for it after everything else
    // this turn lands; without room, no row and nothing else changes.
    async writeReasoning({ content: reasoning, sessionName, loopSeq, turnSeq, sessionId, loopId, turnId, sequence, fit }: {
        content: string; sessionName: string; loopSeq: number; turnSeq: number;
        sessionId: number; loopId: number; turnId: number; sequence: number; fit: ContextFit | undefined;
    }): Promise<number | null> {
        if (reasoning.length === 0) return null;
        const pathname = `/${loopSeq}/${turnSeq}`;
        const pageLines = Knob.optionalInteger("PLURNK_SERVICE_REASONING_TRAILING_LINES", -1) ?? Knob.integer("PLURNK_SERVICE_PREVIEW_LINES", 1);
        if (pageLines === 0) throw new ConfigurationError("PLURNK_SERVICE_REASONING_TRAILING_LINES", "PLURNK_SERVICE_REASONING_TRAILING_LINES must be -1 or a positive integer.");
        const tail = pageLines === -1 ? null : BodyPreview.selectTail(reasoning, pageLines);
        const lineMarker = tail === null || tail.whole ? null : tail.marker;
        const projected = lineMarker === null ? null : await ReadResolve.resolve({ content: reasoning, mimetype: "text/markdown", lineMarker });
        const statement: ReadStatement = {
            op: "READ", aside: null, metadata: null, lineMarker, matcher: null, body: null, position: UNKNOWN_POSITION,
            target: {
                kind: "url", raw: `reasoning://${sessionName}${pathname}`, scheme: "reasoning",
                username: null, password: null, hostname: sessionName, port: null, pathname, query: null, fragment: null,
            },
        };
        const durableAttrs = { kind: "reasoning" };
        const tx = JSON.stringify(DurableStatement.project(statement));
        const rx = JSON.stringify(projected === null
            ? { status: 200, content: reasoning, mimetype: "text/markdown" }
            : { ...projected, mimetype: "text/markdown" });
        const weight = LogBody.weight({
            op: "READ", attrs: durableAttrs, tx, rx, mimetypeTx: "application/json", mimetypeRx: "application/json",
        }, this.#weighContent);
        if (fit !== undefined) {
            const remaining = await fit.remaining();
            if (remaining !== null && weight > remaining) return null;
        }
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence,
            origin: "_plurnk", source: null, model_call_id: null,
            op: "READ", signal: null,
            scheme: "reasoning", username: null, password: null, hostname: sessionName, port: null,
            pathname, query: null, fragment: null, lineMarker: lineMarker === null ? null : JSON.stringify(lineMarker),
            tx, mimetype_tx: "application/json",
            rx,
            mimetype_rx: "application/json",
            status_rx: 200,
            weight,
            state: "resolved", outcome: null,
            attrs: JSON.stringify(durableAttrs),
            initial_folded: LogVisibility.serialize(LogVisibility.OPEN),
        });
        if (row === undefined) throw new Error("Dispatcher.writeReasoning: insert returned no row");
        return row.id;
    }

    // {§op-methods-op-dispatch} Reuse exact READ projection without its log/presentation layer.
    async prepareBarePrompt(
        context: Pick<DispatchContext, "workspaceId" | "sessionId" | "loopId" | "turnId" | "sequence" | "origin"> & { statement: BareStatement },
    ): Promise<{ prompt: string } | { result: DispatchResult }> {
        await this.#operationEvent(context, "started");
        await this.#noticeFilePaths(context);
        return ResourceBindings.using(this.#schemes, this.#buildSchemeCtx(context), async (ctx) => {
            try {
                return await this.#prepareBarePrompt(context.statement, ctx);
            } catch (error) {
                if (error instanceof OperationFailureError) return { result: error.result };
                throw error;
            }
        });
    }

    async #prepareBarePrompt(statement: BareStatement, ctx: PlurnkSchemeContext): Promise<{ prompt: string } | { result: DispatchResult }> {
        const denial = await this.#checkCapabilities(statement, ctx);
        if (denial !== null) return { result: denial };
        let resource = "";
        if (statement.target !== null) {
            const read: ReadStatement = {
                ...statement,
                op: "READ",
                matcher: null,
                body: null,
                lineMarker: { marks: [1, -1] },
            };
            const result = Results.assertReadResult(await this.#dataRun.run(schemeNameOf(read.target), read, ctx));
            if (result.status !== 200 && result.status !== 204) return { result };
            if (typeof result.content === "string") resource = result.content;
            else if (result.content !== null) {
                throw new InvalidOperationResultError("BARE source READ returned non-text content.");
            }
        }
        const prompt = [resource, statement.body].filter((part) => part !== "").join("\n\n");
        // {§op-methods-op-dispatch} — empty combined text is a refusal that creates no model call.
        if (prompt.trim() === "") {
            return { result: this.#failure(
                "bare-prompt-empty", 422,
                `BARE has no prompt text: the prompt is the fence body, a resource path, or both.${statement.aside === null || statement.aside === "" ? "" : " Its aside was not read as the prompt."}`,
                {}, { retryable: false },
            ) };
        }
        return { prompt };
    }

    // {§op-methods-op-dispatch} Provider work runs concurrently; receipts commit in authored order.
    async recordBareResult(
        context: Omit<DispatchContext, "statement"> & { statement: BareStatement },
        result: DispatchResult,
        modelCallId: number | null,
    ): Promise<DispatchResult> {
        Results.assert(result);
        const logEntryId = await this.#logWriter.writeLog({
            ...context,
            result,
            curationPlan: null,
            modelCallId,
        });
        context.onDispatch?.(logEntryId);
        await this.#notifySettled(context, logEntryId);
        await this.#operationEvent(context, "settled", result);
        return result;
    }
}
