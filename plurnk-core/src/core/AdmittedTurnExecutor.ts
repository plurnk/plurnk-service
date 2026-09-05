// Executing an admitted turn: its ordered statements dispatched, problems and notices recorded, the bare batch when no provider spoke. Split out of TurnRunner, which keeps the delegating entry point.
import { PlurnkParser } from "@plurnk/plurnk-contracts";
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
import type { ProviderEncryptedReasoningItem } from "@plurnk/plurnk-providers";
import BareBatchRunner from "./BareBatchRunner.ts";
import { ENGINE_PROBLEMS, TERMINAL_SEND_SIGNALS, TURN_STATUS_IMPLICIT_CONTINUE } from "./turn-signals.ts";
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
        sourceFolded,
        sourceModelCallId = null,
        sourceReasoningItems,
        reasoning = null,
        origin,
        workspaceId,
        workerId,
        loopId,
        turnId,
        fromSequence,
        maxCommands = Number.POSITIVE_INFINITY,
        enforceIdle = false,
        failOnOperationError = false,
        recoverableParseErrors = [],
        bare,
        signal,
        onDispatch,
        onSettled,
    }: {
        statements: readonly PlurnkStatement[];
        source: string | null;
        sourceFolded: boolean;
        sourceModelCallId?: number | null;
        sourceReasoningItems?: ReadonlyArray<ProviderEncryptedReasoningItem>;
        reasoning?: string | null;
        origin: WriterTier;
        workspaceId: number;
        workerId: number;
        loopId: number;
        turnId: number;
        fromSequence: number;
        maxCommands?: number;
        enforceIdle?: boolean;
        failOnOperationError?: boolean;
        recoverableParseErrors?: readonly ParseErrorInfo[];
        bare?: BareExecution;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        onSettled?: (logEntryId: number) => void | Promise<void>;
    }): Promise<AdmittedTurnResult> {
        // {§turn-shape} — PLAN is a SHOULD; the terminal SEND is the one structural requirement.
        const finalOp = statements.at(-1);
        if (finalOp?.op !== "SEND") {
            throw new Error("an admitted operation batch must end in a disposition SEND");
        }
        const dispositionSignal = finalOp.status;
        if (dispositionSignal === null || !TERMINAL_SEND_SIGNALS.has(dispositionSignal)) {
            throw new Error("an admitted turnOps program must end in a terminal disposition SEND");
        }
        let sendOp = finalOp;
        let turnStatus: number = dispositionSignal;
        let steerStruck = false;
        const pendingEngineErrors: EngineProblemKind[] = [];
        const middleCount = statements.filter((statement) => statement.op !== "PLAN" && statement.op !== "SEND").length
            + recoverableParseErrors.length;
        if (enforceIdle && turnStatus === TURN_STATUS_IMPLICIT_CONTINUE && middleCount === 0) {
            // {§send-idle-turn} — an empty (NEXT) while the worker holds a live stream or child is a
            // mis-spelled wait, not idleness: it parks as (WAIT) and no strike (#441). The correction
            // rides the SEND row's annotation — a park drops transient notices, the row survives the
            // wake. With nothing in flight the idle-turn 409 stands.
            if (await this.#dispatcher.hasLiveWork(workerId)) {
                const note = "an empty NEXT while a stream or child is in flight waits like WAIT - say WAIT to wait on it";
                sendOp = { ...finalOp, status: 202, annotation: finalOp.annotation === null ? note : `${finalOp.annotation} · ${note}` };
                turnStatus = 202;
            } else {
                steerStruck = true;
                pendingEngineErrors.push("idle_turn");
            }
        }
        const turnStatements = sendOp === finalOp ? statements : statements.map((statement) => statement === finalOp ? sendOp : statement);

        let realCommands = 0;
        const admitted = turnStatements.filter((statement) => statement.op === "PLAN"
            || statement === sendOp
            || realCommands++ < maxCommands);
        const scheduled = scheduleTurnOps(admitted.flatMap(expandSafeUriTargetGroup));
        const logSelectionMaxId = (await this.#db.engine_log_selection_high_water.get<{ max_id: number }>({
            worker_id: workerId,
        }))?.max_id;
        if (logSelectionMaxId === undefined) {
            throw new Error(`log selection boundary could not be resolved for worker ${workerId}`);
        }
        await this.#dispatcher.prepareEditBatches(
            scheduled,
            { workspaceId, workerId, loopId, turnId, origin, onDispatch, onSettled },
        );
        const droppedCount = statements.length - admitted.length;
        const bareStatements = scheduled.filter(
            (statement): statement is BareStatement => statement.op === "BARE",
        );
        let bareResults: ReadonlyMap<BareStatement, BareBatchResult> | null = null;
        const outcomes: StrikeOutcome[] = [];
        const results: DispatchResult[] = [];
        let rowSequence = fromSequence;
        if (reasoning !== null && reasoning.length > 0) {
            await this.#dispatcher.writeReasoning({
                verbatim: reasoning, workerId, loopId, turnId, sequence: rowSequence++,
            });
        }
        let parseErrorsRecorded = false;
        const recordRecoverableParseErrors = async (): Promise<void> => {
            if (parseErrorsRecorded) return;
            parseErrorsRecorded = true;
            for (const error of recoverableParseErrors) {
                const envelopeDefault = error.code === PlurnkParser.MISSING_SEND;
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
                            ...(envelopeDefault ? {} : { siblingsRetained: true }),
                            retryable: false,
                        },
                    ),
                });
                outcomes.push({ op: null, status: recorded.result.status, problemType: recorded.result.problem?.type ?? null });
                onDispatch?.(recorded.id);
                await onSettled?.(recorded.id);
            }
        };

        for (const statement of scheduled) {
            if (statement === sendOp) {
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
            }
            const result = await observed(
                "op.dispatch",
                { op: statement.op },
                async (span) => {
                    let dispatchResult: DispatchResult;
                    if (statement.op === "BARE") {
                        if (bare === undefined) {
                            throw new Error(`${origin} turnOps cannot execute BARE without provider acquisition context`);
                        }
                        if (bareResults === null) {
                            const batch = await this.#bareBatch.runBareBatch({
                                statements: bareStatements,
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
            if (failOnOperationError && result.status >= 400) throw new OperationFailureError(result);
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
            if (statement === sendOp && result.status === 409) {
                steerStruck = true;
                turnStatus = TURN_STATUS_IMPLICIT_CONTINUE;
            }
            if (
                statement === sendOp
                && result.status !== 409
                && sendOp.target === null
                && sendOp.status === 202
                && result.status !== 202
            ) {
                turnStatus = result.status;
            }
            rowSequence += (result.rowsWritten as number | undefined) ?? 1;
        }
        await recordRecoverableParseErrors();
        if (droppedCount > 0) pendingEngineErrors.push("max_commands_exceeded");
        for (const kind of pendingEngineErrors) {
            const problem = ENGINE_PROBLEMS[kind];
            const extensions = kind === "max_commands_exceeded"
                ? {
                    operationLimit: maxCommands,
                    omittedOperations: droppedCount,
                    stage: "dispatch-admission",
                    recovery: "Continue with no more than the configured operation limit.",
                    retryable: false,
                }
                : {
                    stage: "turn",
                    recovery: "Perform an operation before continuing with `### SEND0 (NEXT)`.",
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
        if (source !== null) {
            await this.#dispatcher.writeTurnOps({
                verbatim: source,
                workerId,
                loopId,
                turnId,
                sequence: rowSequence,
                origin,
                folded: sourceFolded,
                modelCallId: sourceModelCallId,
                ...(sourceReasoningItems !== undefined ? { reasoningItems: sourceReasoningItems } : {}),
            });
        }
        await Turn.complete(this.#db, turnId, turnStatus);
        return {
            status: turnStatus,
            outcomes,
            fingerprint: StrikeRail.fingerprintTurn(scheduled, results),
            steerStruck,
        };
    }


}
