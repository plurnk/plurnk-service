import { TurnDisposition } from "@plurnk/plurnk-contracts";
import TurnDispositionHandler from "./TurnDispositionHandler.ts";
// Executing an admitted turn: its ordered statements dispatched, problems and notices recorded, the bare batch when no provider spoke. Split out of TurnRunner, which keeps the delegating entry point.
import type { BareStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";
import Results, { OperationFailureError } from "./results.ts";
import Turn from "./Turn.ts";
import NoticeChannel from "./NoticeChannel.ts";
import ProblemLog from "./ProblemLog.ts";
import StrikeRail, { type StrikeOutcome } from "./StrikeRail.ts";
import Dispatcher from "./Dispatcher.ts";
import type { DispatchResult } from "./Dispatcher.ts";
import { observed } from "../observe/spans.ts";
import { OPS_DISPATCHED, recordCounter } from "../observe/metrics.ts";
import { scheduleTurnOps } from "./turn-scheduler.ts";
import { expandSafeUriTargetGroup } from "./operation-target-groups.ts";
import { readOptimisticSettlementMs } from "./optimistic-settlement.ts";
import BareBatchRunner from "./BareBatchRunner.ts";
import EditSequence from "./EditSequence.ts";
import LineAnchors from "../content/line-anchors.ts";
import { ENGINE_PROBLEMS, TURN_STATUS_IMPLICIT_CONTINUE } from "./turn-signals.ts";
import type { ParseErrorInfo, EngineProblemKind, BareBatchResult, BareExecution, AdmittedTurnResult } from "./TurnRunner.ts";

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

    // {§turn-ops-admission-path} — source acquisition ends before this seam.
    // Every admitted producer program is scheduled, dispatched, recorded, and
    // completed here; inference is only the model-specific way one program is
    // acquired and supplied with BARE capability.
    async executeAdmittedTurn({
        statements,
        source,
        sourceModelCallId = null,
        origin,
        workspaceId,
        workerId,
        loopId,
        turnId,
        fromSequence,
        maxCommands = Number.POSITIVE_INFINITY,
        allowUnobservedRetrievalCompletion = false,
        failOnOperationError = false,
        recoverableParseErrors = [],
        emptyTurn = false,
        bare,
        signal,
        onDispatch,
        onSettled,
    }: {
        statements: readonly PlurnkStatement[];
        source: string | null;
        sourceModelCallId?: number | null;
        origin: WriterTier;
        workspaceId: number;
        workerId: number;
        loopId: number;
        turnId: number;
        fromSequence: number;
        maxCommands?: number;
        allowUnobservedRetrievalCompletion?: boolean;
        failOnOperationError?: boolean;
        recoverableParseErrors?: readonly ParseErrorInfo[];
        emptyTurn?: boolean;
        bare?: BareExecution;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        onSettled?: (logEntryId: number) => void | Promise<void>;
    }): Promise<AdmittedTurnResult> {
        // {§turn-shape} — continuation is the default; TASK is explicit intent.
        const dispositions = statements.filter(TurnDisposition.is);
        const finalOp = dispositions[0];
        if ((statements.length === 0 && !emptyTurn) || dispositions.length > 1) {
            throw new Error("an admitted operation batch must contain operations and at most one disposition");
        }
        // {§empty-turn} — a model response with no operation is a turn all the same: its text and
        // reasoning are kept, the packet says so, and the strike rail counts it once.
        if (statements.length === 0) {
            if (source !== null) await Turn.recordSource(this.#db, turnId, "ops", source, { modelCallId: sourceModelCallId });
            this.#notices.push(workspaceId, workerId, loopId, {
                source: "engine:turn",
                kind: "turn_no_operations",
                level: "warn",
                message: "This turn emitted no operations; its text was kept and nothing ran. An operation opens with four backticks and its name on the fence line.",
            });
            await Turn.complete(this.#db, turnId, TURN_STATUS_IMPLICIT_CONTINUE);
            return { status: TURN_STATUS_IMPLICIT_CONTINUE, outcomes: [], fingerprint: StrikeRail.fingerprintTurn([]), steerStruck: false, emptyTurn: true };
        }
        const dispositionSignal = finalOp === undefined ? TURN_STATUS_IMPLICIT_CONTINUE : TurnDisposition.status(finalOp);
        let turnStatus: number = dispositionSignal;
        let steerStruck = false;
        const pendingEngineErrors: EngineProblemKind[] = [];
        let realCommands = 0;
        const admitted = statements.filter((statement) => statement === finalOp
            || realCommands++ < maxCommands);
        const scheduled = scheduleTurnOps(admitted.flatMap(expandSafeUriTargetGroup));
        const logSelectionMaxId = (await this.#db.engine_log_selection_high_water.get<{ max_id: number }>({
            worker_id: workerId,
        }))?.max_id;
        if (logSelectionMaxId === undefined) {
            throw new Error(`log selection boundary could not be resolved for worker ${workerId}`);
        }
        const editSequence = scheduled.some((statement) =>
            (statement.op === "EDIT" || statement.op === "KILL") && LineAnchors.hasAnchor(statement.lineMarker))
            ? new EditSequence() : undefined;
        const droppedCount = statements.length - admitted.length;
        let bareResults: ReadonlyMap<BareStatement, BareBatchResult> = new Map();
        const outcomes: StrikeOutcome[] = [];
        const results: DispatchResult[] = [];
        let rowSequence = fromSequence;
        if (source !== null) {
            await Turn.recordSource(this.#db, turnId, "ops", source, {
                modelCallId: sourceModelCallId,
            });
        }
        let parseErrorsRecorded = false;
        const recordRecoverableParseErrors = async (): Promise<void> => {
            if (parseErrorsRecorded) return;
            parseErrorsRecorded = true;
            for (const error of recoverableParseErrors) {
                const recorded = await this.#problems.record({
                    workerId,
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
                            retryable: false,
                        },
                    ),
                });
                outcomes.push({ op: null, status: recorded.result.status, problemType: recorded.result.problem?.type ?? null });
                onDispatch?.(recorded.id);
                await onSettled?.(recorded.id);
            }
        };

        const settleTurn = async (): Promise<void> => {
            await recordRecoverableParseErrors();
            const execHandler = this.#schemes.get("exec") as {
                settleTurnSpawns?: (
                    workerId: number,
                    turnId: number,
                    timeoutMs: number,
                    signal?: AbortSignal,
                ) => Promise<boolean>;
            } | undefined;
            await execHandler?.settleTurnSpawns?.(
                workerId,
                turnId,
                readOptimisticSettlementMs(),
                signal,
            );
        };

        for (const [index, scheduledStatement] of scheduled.entries()) {
            // {§metadata-ignored} — a scheme that takes no [metadata] gets the operation without it,
            // and the model gets one notice, never a refusal (operator, 2026-09-12).
            let statement = scheduledStatement;
            if ("metadata" in statement && statement.metadata !== null && statement.op !== "EXEC") {
                const target = (statement as { target?: { kind: string; scheme?: string } | null }).target;
                const schemeName = target === null || target === undefined ? null : target.kind === "url" ? target.scheme ?? null : "file";
                const manifest = schemeName === null ? undefined : this.#schemes.manifestFor(schemeName, workspaceId);
                if (manifest !== undefined && manifest.metadataModifier !== true) {
                    this.#notices.push(workspaceId, workerId, loopId, {
                        source: "engine:dispatcher",
                        kind: "metadata_ignored",
                        level: "warn",
                        message: `Scheme '${schemeName}' takes no [metadata]; the ${statement.op} ran without it.`,
                    });
                    statement = { ...statement, metadata: null } as typeof statement;
                }
            }
            if (scheduledStatement === finalOp) await settleTurn();
            const result = await observed(
                "op.dispatch",
                { op: statement.op },
                async (span) => {
                    let dispatchResult: DispatchResult;
                    if (statement.op === "BARE") {
                        if (bare === undefined) {
                            throw new Error(`${origin} turnOps cannot execute BARE without provider acquisition context`);
                        }
                        if (!bareResults.has(statement)) {
                            const bareStatements: BareStatement[] = [];
                            for (const candidate of scheduled.slice(index)) {
                                if (candidate.op !== "BARE") break;
                                bareStatements.push(candidate);
                            }
                            const batch = await this.#bareBatch.runBareBatch({
                                statements: bareStatements,
                                preparePrompt: (statement) => this.#dispatcher.prepareBarePrompt({
                                    statement, workspaceId, workerId, loopId, turnId, origin,
                                }),
                                provider: bare.provider,
                                turnId,
                                workspaceId,
                                workerId,
                                primaryWorkerId: bare.primaryWorkerId,
                                loopSequence: bare.loopSequence,
                                turnSequence: bare.turnSequence,
                                signal: bare.signal,
                            });
                            bareResults = new Map(batch.map((item) => [item.statement, item]));
                        }
                        const bareResult = bareResults.get(statement);
                        if (bareResult === undefined) {
                            throw new Error("BARE statement reached dispatch without its batch result");
                        }
                        dispatchResult = await this.#dispatcher.recordBareResult({
                            statement,
                            workspaceId,
                            workerId,
                            loopId,
                            turnId,
                            sequence: rowSequence,
                            origin,
                            onDispatch,
                            onSettled,
                        }, bareResult.result, bareResult.modelCallId);
                    } else {
                        dispatchResult = await this.#dispatcher.dispatch({
                            statement,
                            workspaceId,
                            workerId,
                            loopId,
                            turnId,
                            sequence: rowSequence,
                            origin,
                            logSelectionMaxId,
                            editSequence,
                            allowUnobservedRetrievalCompletion,
                            onDispatch,
                            onSettled,
                        });
                    }
                    span.setAttribute("status", dispatchResult.status);
                    recordCounter(OPS_DISPATCHED, { op: statement.op, status: dispatchResult.status });
                    return dispatchResult;
                },
            );
            outcomes.push({ op: statement.op, status: result.status, problemType: result.problem?.type ?? null });
            results.push(result);
            rowSequence += (result.rowsWritten as number | undefined) ?? 1;
            if (failOnOperationError && result.status >= 400) {
                throw new OperationFailureError(result);
            }
            for (const normalization of result.scopeNormalizations ?? []) {
                this.#notices.push(workspaceId, workerId, loopId, {
                    source: "engine:slicer",
                    kind: "scope_normalized",
                    level: "warn",
                    message: `Scope <${normalization.requested.join(",")}> was normalized to <${normalization.canonical.join(",")}>.`,
                });
            }
            // {§edit-batch-merges} — every applied resolution is also a notice, so the row's
            // `merged` fact is never the only place it is said.
            for (const merge of (result as { merged?: readonly { rule: string }[] }).merged ?? []) {
                this.#notices.push(workspaceId, workerId, loopId, {
                    source: "engine:slicer",
                    kind: "edit_merged",
                    level: "warn",
                    message: `EDIT resolution applied: ${merge.rule} - the row's merged fact has the coordinates; verify before building on it.`,
                });
            }
            if (scheduledStatement === finalOp) {
                steerStruck = TurnDispositionHandler.refusedCompletion(result);
                turnStatus = result.status >= 400 && result.status !== 499
                    ? TURN_STATUS_IMPLICIT_CONTINUE : result.status;
            }
        }
        if (finalOp === undefined) await settleTurn();
        if (droppedCount > 0) pendingEngineErrors.push("max_commands_exceeded");
        for (const kind of pendingEngineErrors) {
            const problem = ENGINE_PROBLEMS[kind];
            const extensions = {
                    operationLimit: maxCommands,
                    omittedOperations: droppedCount,
                    stage: "dispatch-admission",
                    recovery: "Continue with no more than the configured operation limit.",
                    retryable: false,
                };
            await this.#problems.record({
                workerId,
                loopId,
                turnId,
                sequence: rowSequence++,
                origin: "_plurnk",
                source: "rail",
                result: Results.failure(
                    "engine:rail",
                    problem.code,
                    problem.status,
                    problem.detail,
                    {},
                    extensions,
                ),
            });
        }
        await Turn.complete(this.#db, turnId, turnStatus);
        return {
            status: turnStatus,
            outcomes,
            fingerprint: StrikeRail.fingerprintTurn(scheduled, results),
            steerStruck,
            emptyTurn: false,
        };
    }


}
