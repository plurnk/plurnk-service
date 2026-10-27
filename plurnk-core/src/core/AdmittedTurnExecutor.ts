import { TurnDisposition, isExecution, isRecord, writtenOp } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
// Executing an admitted turn: its ordered statements dispatched, problems and notices recorded, the bare batch when no provider spoke. Split out of TurnRunner, which keeps the delegating entry point.
import type { BareStatement, DispositionStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import Results, { OperationFailureError } from "./results.ts";
import Turn from "./Turn.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type ProblemLog from "./ProblemLog.ts";
import StrikeRail, { isProgress, type StrikeOutcome } from "./StrikeRail.ts";
import type Dispatcher from "./Dispatcher.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { observed } from "../observe/spans.ts";
import { OPS_DISPATCHED, recordCounter } from "../observe/metrics.ts";
import { scheduleTurnOps } from "./turn-scheduler.ts";
import { readOptimisticSettlementMs } from "./optimistic-settlement.ts";
import type BareBatchRunner from "./BareBatchRunner.ts";
import EditSequence from "./EditSequence.ts";
import { isContextReceipt, reserved, type ContextFit } from "./ContextFit.ts";
import LineAnchors from "../content/line-anchors.ts";
import { ENGINE_PROBLEMS } from "./turn-signals.ts";
import type { ParseErrorInfo, EngineProblemKind, BareBatchResult, BareExecution, AdmittedTurnResult, AdmittedTextSource } from "./TurnRunner.ts";

// SEND recipients own their input; resource operations use the manifest.
const OWNS_METADATA: ReadonlySet<string> = new Set(["SEND"]);

// The exec scheme's turn settlement: its own hook, read where a turn settles.
const settlesTurnSpawns = (handler: object | undefined): handler is {
    settleTurnSpawns(sessionId: number, turnId: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
} => handler !== undefined && "settleTurnSpawns" in handler && typeof handler.settleTurnSpawns === "function";

// {§op-methods-op-dispatch} — the rules an EDIT batch's resolutions applied, as its result's merged fact names them.
const mergedRules = (result: DispatchResult): string[] => Array.isArray(result.merged)
    ? result.merged.flatMap((merge: unknown) => isRecord(merge) && typeof merge.rule === "string" ? [merge.rule] : [])
    : [];

export default class AdmittedTurnExecutor {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #notices: NoticeChannel;
    readonly #problems: ProblemLog;
    readonly #dispatcher: Dispatcher;
    readonly #bareBatch: BareBatchRunner;

    constructor({ db, schemes, notices, problems, dispatcher, bareBatch }: {
        db: Db;
        schemes: SchemeRegistry;
        notices: NoticeChannel;
        problems: ProblemLog;
        dispatcher: Dispatcher;
        bareBatch: BareBatchRunner;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#notices = notices;
        this.#problems = problems;
        this.#dispatcher = dispatcher;
        this.#bareBatch = bareBatch;
    }

    // {§turn-record} — source acquisition ends before this seam.
    // Every admitted producer program is scheduled, dispatched, recorded, and
    // completed here; inference is only the model-specific way one program is
    // acquired and supplied with BARE capability.
    async executeAdmittedTurn({
        statements,
        source,
        emission,
        reasoning = null,
        sourceModelCallId = null,
        origin,
        workspaceId,
        sessionId,
        loopId,
        turnId,
        fromSequence,
        maxCommands = Number.POSITIVE_INFINITY,
        failOnOperationError = false,
        recoverableParseErrors = [],
        emptyTurn = false,
        completionAllowed = true,
        bare,
        fit,
        signal,
        onDispatch,
        onSettled,
    }: {
        statements: readonly PlurnkStatement[];
        source: string | null;
        // {§turn-source-resources} — the admitted emission this turn announces, or null when nothing was admitted
        // from a recorded source. Every caller states it.
        emission: (AdmittedTextSource & { statements: readonly PlurnkStatement[] }) | null;
        reasoning?: AdmittedTextSource | null;
        sourceModelCallId?: number | null;
        origin: WriterTier;
        workspaceId: number;
        sessionId: number;
        loopId: number;
        turnId: number;
        fromSequence: number;
        maxCommands?: number;
        failOnOperationError?: boolean;
        recoverableParseErrors?: readonly ParseErrorInfo[];
        emptyTurn?: boolean;
        completionAllowed?: boolean;
        bare?: BareExecution;
        // {§tokenomics} — the turn's measure of the budget left for one more result; absent, rows land whole.
        fit?: ContextFit;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        onSettled?: (logEntryId: number) => void | Promise<void>;
    }): Promise<AdmittedTurnResult> {
        // {§loop-completion}: settlement follows durable message and observation obligations.
        // {§op-shapes} — every WAIT is admitted and dispatched; together they are one park,
        // and the last of them settles the turn.
        const dispositions = statements.filter(TurnDisposition.is);
        const finalOp = dispositions.at(-1);
        if (statements.length === 0 && !emptyTurn) {
            throw new Error("an admitted operation batch must contain operations");
        }
        if (emission === undefined) throw new Error("executeAdmittedTurn requires the admitted emission, or null, to be stated");
        if (emission !== null && source === null) throw new Error("an admitted emission requires its recorded ops source");
        // {§turn-source-resources}: reserve chronology, not budget. The optional row is admitted after results.
        const reasoningSequence = reasoning?.content && Knob.flag("PLURNK_SERVICE_REASONING_ROWS") ? fromSequence : null;
        let rowSequence = fromSequence + (reasoningSequence === null ? 0 : 1);
        const recordReasoning = async (): Promise<void> => {
            if (reasoning === null || reasoningSequence === null) return;
            const id = await this.#dispatcher.writeReasoning({
                ...reasoning, sessionId, loopId, turnId, sequence: reasoningSequence, fit,
            });
            if (id !== null) { onDispatch?.(id); await onSettled?.(id); }
        };
        // {§outside-text}: preserve evidence even when no operation was admitted.
        const recordEngineProblem = async (kind: EngineProblemKind, sequence: number, extensions: Record<string, unknown>): Promise<void> => {
            const problem = ENGINE_PROBLEMS[kind];
            await this.#problems.record({
                sessionId,
                loopId,
                turnId,
                sequence,
                origin: "_plurnk",
                source: "rail",
                result: Results.failure("engine:rail", problem.code, problem.status, problem.detail, {}, extensions),
            });
        };
        const emptyTurnExtensions = { stage: "dispatch-admission", recovery: "Emit at least one fenced operation.", retryable: true };
        const waits: DispositionStatement[] = [];
        const pendingEngineErrors: EngineProblemKind[] = [];
        let realCommands = 0;
        let droppedCount = 0;
        const scheduled = scheduleTurnOps(statements);
        const executed: PlurnkStatement[] = [];
        const logSelectionMaxId = (await this.#db.engine_log_selection_high_water.get<{ max_id: number }>({
            session_id: sessionId,
        }))?.max_id;
        if (logSelectionMaxId === undefined) {
            throw new Error(`log selection boundary could not be resolved for session ${sessionId}`);
        }
        const editSequence = scheduled.some((statement) =>
            (statement.op === "EDIT" || statement.op === "KILL") && LineAnchors.hasAnchor(statement.lineMarker))
            ? new EditSequence() : undefined;
        let bareResults: ReadonlyMap<BareStatement, BareBatchResult> = new Map();
        const outcomes: StrikeOutcome[] = [];
        let progressed = false;
        const results: DispatchResult[] = [];
        if (source !== null) {
            await Turn.recordSource(this.#db, turnId, "ops", source, {
                modelCallId: sourceModelCallId,
            });
        }
        // {§turn-source-resources} — the turn's next sequence after its recorded inputs and before its
        // operations, written after the selection snapshot so the emission's own program cannot select it.
        if (emission !== null) {
            const id = await this.#dispatcher.writeEmission({ ...emission, sessionId, loopId, turnId, sequence: rowSequence++ });
            onDispatch?.(id);
            await onSettled?.(id);
        }
        let parseErrorsRecorded = false;
        const recordRecoverableParseErrors = async (): Promise<void> => {
            if (parseErrorsRecorded) return;
            parseErrorsRecorded = true;
            for (const error of recoverableParseErrors) {
                const recorded = await this.#problems.record({
                    sessionId,
                    loopId,
                    turnId,
                    sequence: rowSequence++,
                    origin,
                    source: "grammar",
                    result: Results.failure(
                        "grammar:parser",
                        "invalid-operation-syntax",
                        400,
                        error.message,
                        {},
                        {
                            line: error.line,
                            column: error.column,
                            source: error.source,
                            stage: "parse",
                            siblingsRetained: true,
                            // {§parse-recovery}: the parser's working form rides as the Problem's recovery.
                            ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
                            retryable: false,
                        },
                    ),
                    // {§parse-recovery} The statement the parser refused rides the row, outside its body.
                    ...(error.attempt === undefined ? {} : { attrs: { attempt: error.attempt } }),
                });
                outcomes.push({ op: null, status: recorded.result.status, problemType: recorded.result.problem?.type ?? null });
                onDispatch?.(recorded.id);
                await onSettled?.(recorded.id);
            }
        };

        const settleTurn = async (): Promise<void> => {
            await recordRecoverableParseErrors();
            const execHandler = this.#schemes.get("exec");
            if (settlesTurnSpawns(execHandler)) {
                await execHandler.settleTurnSpawns(sessionId, turnId, readOptimisticSettlementMs(), signal);
            }
        };

        const emissionIndices = new Map(emission?.statements.map((statement, index) => [statement, index]));
        for (const [index, scheduledStatement] of scheduled.entries()) {
            const emissionIndex = emissionIndices.get(scheduledStatement);
            signal?.throwIfAborted();
            if (!TurnDisposition.is(scheduledStatement) && realCommands >= maxCommands) {
                droppedCount++;
                continue;
            }
            // {§outside-text} — an unsupported resource option is dropped,
            // and the model gets one notice, never a refusal. SEND recipients and invocation owners
            // receive their own input whole ({§op-methods-op-dispatch}).
            let statement = scheduledStatement;
            if ("metadata" in statement && statement.metadata !== null && !(isExecution(statement) || OWNS_METADATA.has(statement.op))) {
                const target = (statement as { target?: { kind: string; scheme?: string } | null }).target;
                const schemeName = target === null || target === undefined
                    ? (statement.op === "WORK" || statement.op === "FORK" ? "session" : null)
                    : target.kind === "url" ? target.scheme ?? null : "file";
                const manifest = schemeName === null ? undefined : this.#schemes.manifestFor(schemeName, workspaceId);
                if (manifest !== undefined && manifest.metadataModifier !== true) {
                    this.#notices.push(workspaceId, sessionId, loopId, {
                        source: "engine:dispatcher",
                        kind: "metadata_ignored",
                        level: "warn",
                        directive: "YOU SHOULD NOT write [metadata] on an operation that takes none.",
                        message: `${statement.op} on '${schemeName}' takes no [metadata]; the ${statement.op} ran without it.`,
                    });
                    statement = { ...statement, metadata: null };
                }
            }
            if (scheduledStatement === finalOp) await settleTurn();
            const { result, commandsExecuted, commandsOmitted } = await observed(
                "op.dispatch",
                { op: writtenOp(statement) },
                async (span) => {
                    let dispatchResult: DispatchResult;
                    let executedCount = 1;
                    let omittedCount = 0;
                    if (statement.op === "BARE") {
                        if (bare === undefined) {
                            throw new Error(`${origin} turnOps cannot execute BARE without provider acquisition context`);
                        }
                        if (!bareResults.has(statement)) {
                            const bareStatements: BareStatement[] = [];
                            for (const candidate of scheduled.slice(index)) {
                                if (candidate.op !== "BARE" || bareStatements.length >= maxCommands - realCommands) break;
                                bareStatements.push(candidate);
                            }
                            const batch = await this.#bareBatch.runBareBatch({
                                statements: bareStatements,
                                preparePrompt: (bareStatement) => this.#dispatcher.prepareBarePrompt({
                                    statement: bareStatement, workspaceId, sessionId, loopId, turnId, origin,
                                    sequence: rowSequence + bareStatements.indexOf(bareStatement),
                                }),
                                provider: bare.provider,
                                turnId,
                                workspaceId,
                                sessionId,
                                loopId,
                                loopSequence: bare.loopSequence,
                                turnSequence: bare.turnSequence,
                                signal: bare.signal,
                                notice: (notice) => this.#notices.push(workspaceId, sessionId, loopId, notice),
                            });
                            bareResults = new Map(batch.map((item) => [item.statement, item]));
                        }
                        const bareResult = bareResults.get(statement);
                        if (bareResult === undefined) {
                            throw new Error("BARE statement reached dispatch without its batch result");
                        }
                        dispatchResult = await this.#dispatcher.recordBareResult({
                            statement,
                            emissionIndex,
                            workspaceId,
                            sessionId,
                            loopId,
                            turnId,
                            sequence: rowSequence,
                            origin,
                            onDispatch,
                            onSettled,
                        }, bareResult.result, bareResult.modelCallId);
                    } else {
                        const execution = await this.#dispatcher.dispatch({
                            statement,
                            emissionIndex,
                            workspaceId,
                            sessionId,
                            loopId,
                            turnId,
                            sequence: rowSequence,
                            origin,
                            logSelectionMaxId,
                            editSequence,
                            remainingCommands: maxCommands - realCommands,
                            failOnOperationError,
                            ...(fit === undefined ? {} : { fit: reserved(fit, scheduled.length - index - 1) }),
                            onDispatch,
                            onSettled,
                        });
                        ({ result: dispatchResult, commandsExecuted: executedCount, commandsOmitted: omittedCount } = execution);
                    }
                    span.setAttribute("status", dispatchResult.status);
                    recordCounter(OPS_DISPATCHED, { op: writtenOp(statement), status: dispatchResult.status });
                    return { result: dispatchResult, commandsExecuted: executedCount, commandsOmitted: omittedCount };
                },
            );
            outcomes.push({ op: writtenOp(statement), status: result.status, problemType: result.problem?.type ?? null });
            progressed ||= isProgress(statement, result.status);
            executed.push(statement);
            results.push(result);
            if (!TurnDisposition.is(statement)) realCommands += commandsExecuted;
            droppedCount += commandsOmitted;
            rowSequence += Results.rowsWritten(result);
            if (failOnOperationError && result.status >= 400 && !isContextReceipt(result)) {
                throw new OperationFailureError(result);
            }
            for (const normalization of result.scopeNormalizations ?? []) {
                this.#notices.push(workspaceId, sessionId, loopId, {
                    source: "engine:slicer",
                    kind: "scope_normalized",
                    level: "warn",
                    directive: "YOU SHOULD write the normalized scope.",
                    message: `Scope <${normalization.requested.join(",")}> was normalized to <${normalization.canonical.join(",")}>.`,
                });
            }
            // {§op-methods-op-dispatch} — every applied resolution is also a notice, so the row's
            // `merged` fact is never the only place it is said.
            for (const rule of mergedRules(result)) {
                this.#notices.push(workspaceId, sessionId, loopId, {
                    source: "engine:slicer",
                    kind: "edit_merged",
                    level: "warn",
                    directive: "YOU SHOULD verify the merged EDIT before building on it.",
                    message: `EDIT resolution applied: ${rule}; the row's merged fact has the coordinates.`,
                });
            }
            if (TurnDisposition.is(scheduledStatement) && result.status < 400) waits.push(scheduledStatement);
        }
        signal?.throwIfAborted();
        if (finalOp === undefined) await settleTurn();
        if (droppedCount > 0) pendingEngineErrors.push("max_commands_exceeded");
        const completionEligible = completionAllowed && droppedCount === 0 && recoverableParseErrors.length === 0;
        const unresolved = await this.#db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId });
        const emptyRecovery = emptyTurn && (!completionEligible || unresolved!.count > 0);
        if (emptyRecovery) pendingEngineErrors.push("no_operation");
        for (const kind of pendingEngineErrors) {
            const extensions = kind === "no_operation" ? emptyTurnExtensions : {
                operationLimit: maxCommands,
                omittedOperations: droppedCount,
                stage: "dispatch-admission",
                recovery: "Continue with no more than the configured operation limit.",
                retryable: false,
            };
            await recordEngineProblem(kind, rowSequence++, extensions);
        }
        const turnStatus = await this.#dispatcher.settleProgram({ workspaceId, sessionId, loopId, turnId, origin }, waits, completionEligible);
        await recordReasoning();
        await Turn.complete(this.#db, turnId, turnStatus);
        return {
            status: turnStatus,
            outcomes,
            progressed,
            fingerprint: emptyTurn ? StrikeRail.fingerprintEmptyTurn(source ?? "") : StrikeRail.fingerprintTurn(executed, results),
            emptyTurn: emptyRecovery,
        };
    }


}
