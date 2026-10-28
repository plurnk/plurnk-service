import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import {
    aggregateProviderAccounting, ProviderError, scopeEnvToAlias,
    type GrammarEvidence, type Provider, type ProviderAttempt, type ProviderRequestAccounting, type ProviderResponse,
} from "@plurnk/plurnk-providers";
import Meta, { Knob, type ExtensionAttributionContext } from "@plurnk/plurnk-meta";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type ProblemLog from "./ProblemLog.ts";
import type PacketBuilder from "./PacketBuilder.ts";
import type { ChatMessage } from "./PacketBuilder.ts";
import type { EngineNotifications } from "./notifications.ts";
import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";
import Turn, { type InferenceEvidence } from "./Turn.ts";
import ModelCall, { ModelCallPersistenceError, ProviderAccountingIntegrityError } from "./ModelCall.ts";
import ProviderRecovery from "./ProviderRecovery.ts";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import EmissionSplit, { type BodyCheck, type SplitProviderResponse } from "./EmissionSplit.ts";
import SessionOwners from "./SessionOwners.ts";
import Results, { OperationFailureError, type SchemeResult } from "./results.ts";
import { observed } from "../observe/spans.ts";
import { genAiRequestName, genAiRequestOptions, settleGenAiResponse } from "../observe/genai.ts";
import { PROVIDER_CALLS, recordCounter } from "../observe/metrics.ts";
import type { EngineTurnResult, TurnArgs, TurnRequest } from "./TurnRunner.ts";

// Every turn result carries the same shape; a diversion names only what differs.
export const turnResult = (
    { createdTurnIds, turnId }: Pick<TurnRequest, "createdTurnIds" | "turnId">,
    status: number,
    facts: Partial<EngineTurnResult> = {},
): EngineTurnResult => ({
    createdTurnIds,
    turnId,
    producer: "model",
    kind: "inference",
    status,
    outcomes: [],
    progressed: false,
    fingerprint: "",
    capacityHardStop: false,
    providerParked: false,
    emptyTurn: false,
    outputCut: null,
    emissionAttempts: 0,
    emissionExhausted: false,
    ...facts,
});

// {§provider-instantiation}
export const resolveOperatorGrammarPath = (value: string): string => {
    if (value === "~" || value.startsWith("~/")) return resolvePath(homedir(), value.slice(2));
    return resolvePath(value);
};

// The wall's abort reason — runLoop branches a mid-turn teardown to the 504 terminal on it.
export const LOOP_TIMEOUT_REASON = "loop_timeout";

export type MaterializedModelRequest = {
    readonly messages: ChatMessage[];
    readonly nativeInputs: readonly string[];
};

// Phase 4 — the attempt loop's bookkeeping: every logical provider call's durable
// identities, the recovery clock ({§engine-rails}) and the wire spend, shared
// with the failure handler.
export type ProviderAttempts = {
    wire: MaterializedModelRequest;
    response: ProviderAttempt | undefined;
    split: SplitProviderResponse | undefined;
    railGrammar: string | undefined;
    railEvidence: GrammarEvidence | undefined;
    // {§fence-pairing}: judges a body in its runtime's declared media type; undefined when none declares one.
    wellFormed: BodyCheck | undefined;
    emissionAttempts: number;
    callInFlight: boolean;
    modelCallSequence: number;
    currentEmissionAttempt: number;
    attemptId: number | null;
    modelCall: ModelCall | null;
    recoveryStartedAt: number | null;
    recoveryFailures: number;
    parked: boolean;
    attributions: string[];
    readonly recoveryBudget: number;
    readonly recoveryBackoff: number;
    readonly signal: AbortSignal | undefined;
    readonly providerSessionId: string;
    // {§operation-results} (#465) — every physical exchange this turn pays
    // for, successes and failed calls alike, so the completion notice carries
    // the exact settled wire spend.
    readonly turnWireAccounting: ProviderRequestAccounting[];
};

// The completed exchange the attempt loop settled on, as admission and settlement read it.
export type ProviderEmission = {
    readonly response: ProviderAttempt;
    readonly split: SplitProviderResponse;
    readonly modelCallId: number;
    readonly railGrammar: string | undefined;
    readonly railEvidence: GrammarEvidence | undefined;
    readonly emissionAttempts: number;
    readonly signal: AbortSignal | undefined;
};

// {§notifications} — the per-call observer a provider streams reasoning through.
type ReasoningObserver = {
    readonly observeRequest: (...args: Parameters<ModelCall["observeRequest"]>) => ReturnType<ModelCall["observeRequest"]>;
    readonly observeReasoning: ((delta: string) => void) | undefined;
    readonly end: () => void;
};

const readEmissionAttempts = (): number => Knob.integer("PLURNK_SERVICE_EMISSION_ATTEMPTS", 1);

export default class ProviderAttemptRunner {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #mimetypes: Mimetypes;
    readonly #notices: NoticeChannel;
    readonly #problems: ProblemLog;
    readonly #packets: PacketBuilder;
    readonly #notify: EngineNotifications;
    readonly #executors: () => ExecutorRegistry | undefined;
    readonly #loopSignal: (loopId: number) => AbortSignal | undefined;
    readonly #resolveSessionProviderIdentity: (sessionId: number) => Promise<{ sessionId: string }>;
    readonly #recordInference: (args: {
        workspaceId: number;
        sessionId: number;
        loopId: number;
        turnId: number;
        evidence: InferenceEvidence;
    }) => Promise<void>;
    // {§provider-instantiation} — one read per path per daemon; the file is the operator's and static.
    readonly #grammarCache = new Map<string, string>();

    constructor({
        db,
        schemes,
        mimetypes,
        notices,
        problems,
        packets,
        notify,
        executors,
        loopSignal,
        resolveSessionProviderIdentity,
        recordInference,
    }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        notices: NoticeChannel;
        problems: ProblemLog;
        packets: PacketBuilder;
        notify: EngineNotifications;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        resolveSessionProviderIdentity: (sessionId: number) => Promise<{ sessionId: string }>;
        recordInference: (args: {
            workspaceId: number;
            sessionId: number;
            loopId: number;
            turnId: number;
            evidence: InferenceEvidence;
        }) => Promise<void>;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#mimetypes = mimetypes;
        this.#notices = notices;
        this.#problems = problems;
        this.#packets = packets;
        this.#notify = notify;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#resolveSessionProviderIdentity = resolveSessionProviderIdentity;
        this.#recordInference = recordInference;
    }

    static providerFailure(error: unknown, signal: AbortSignal | undefined): SchemeResult {
        if (error instanceof ProviderError) {
            return { status: error.problem.status, problem: error.problem };
        }
        if (signal?.aborted === true) {
            const timedOut = signal.reason === LOOP_TIMEOUT_REASON;
            return Results.failure(
                "engine:provider",
                timedOut ? "provider-call-timeout" : "provider-call-cancelled",
                timedOut ? 504 : 499,
                timedOut
                    ? "The provider call was interrupted by the loop deadline."
                    : "The provider call was interrupted by loop cancellation.",
                {},
                { stage: "provider-request", retryable: false },
            );
        }
        console.error("Provider failed outside its Problem Details contract:", error);
        return Results.failure(
            "engine:provider",
            "provider-contract-violation",
            502,
            "The provider failed without returning its required Problem Details.",
            {},
            { stage: "provider-request", retryable: false },
        );
    }

    providerAttributions(
        provider: Provider,
        context: ExtensionAttributionContext,
    ): string[] {
        return [...Meta.composeAttributions(provider.attributions?.(context) ?? [])];
    }

    // {§provider-instantiation} — the operator's grammar text for this provider, or undefined when
    // none is configured. A real alias scopes its knob; an alias-free direct route uses the
    // global provider configuration. Unrelated alias settings never apply
    // ({§provider-instantiation}). An unreadable file throws: a configured grammar
    // never silently degrades.
    async #operatorGrammar(provider: Provider): Promise<string | undefined> {
        ProviderInstantiate.assertGrammarConfigurationScope(provider);
        const alias = ProviderInstantiate.configurationAliasOf(provider);
        const scoped = alias === undefined
            ? process.env
            : scopeEnvToAlias(process.env, alias, ["PLURNK_PROVIDERS_GBNF"]);
        const configured = scoped.PLURNK_PROVIDERS_GBNF;
        if (configured === undefined || configured === "" || configured === "0") return undefined;
        const path = resolveOperatorGrammarPath(configured);
        const hit = this.#grammarCache.get(path);
        if (hit !== undefined) return hit;
        const text = await readFile(path, "utf8");
        this.#grammarCache.set(path, text);
        process.stderr.write(`plurnk-engine: operator grammar: ${alias || "(bare)"} → ${path} (${text.length} chars)\n`);
        return text;
    }

    async #attemptAttributions(
        provider: Provider,
        context: ExtensionAttributionContext,
    ): Promise<string[]> {
        const tags = Meta.composeAttributions(
            this.#schemes.attributions(context),
            this.#executors()?.attributions(context) ?? [],
            await this.#mimetypes.attributions(context),
            provider.attributions?.(context) ?? [],
        );
        return [...tags];
    }

    // Phase 4's bookkeeping: the wire request, the recovery knobs, the signal the
    // provider sees, the client id and the session's provider identity.
    async prepareProviderAttempts({ sessionId, loopId, signal }: TurnArgs, _request: TurnRequest, wire: MaterializedModelRequest): Promise<ProviderAttempts> {
        // {§engine-rails} — this turn's recovery clock: the first recoverable provider
        // failure starts it; the budget and backoff are the operator's.
        const recoveryBudget = ProviderRecovery.budget();
        const recoveryBackoff = ProviderRecovery.backoff();
        const providerSignal = this.#loopSignal(loopId) ?? signal;
        const { sessionId: providerSessionId } = await this.#resolveSessionProviderIdentity(sessionId);
        return {
            wire,
            response: undefined,
            split: undefined,
            railGrammar: undefined,
            wellFormed: undefined,
            railEvidence: undefined,
            emissionAttempts: 0,
            callInFlight: false,
            modelCallSequence: 0,
            currentEmissionAttempt: 0,
            attemptId: null,
            modelCall: null,
            recoveryStartedAt: null,
            recoveryFailures: 0,
            parked: false,
            attributions: [],
            recoveryBudget,
            recoveryBackoff,
            signal: providerSignal,
            providerSessionId,
            turnWireAccounting: [],
        };
    }

    // Phase 4 — the provider attempt loop. Each iteration is one logical call: a
    // recoverable failure re-issues the same emission attempt, an invalid emission
    // spends one, and a valid emission ends the loop ({§emission-admission}).
    async attemptProvider(args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts): Promise<ProviderEmission> {
        const { provider, workspaceId, sessionId, loopId, signal } = args;
        // {§operation-results}: bracket the complete provider-attempt window with liveness notices.
        if (!signal?.aborted) this.#notices.push(workspaceId, sessionId, loopId, { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" });
        attempts.railGrammar = await this.#operatorGrammar(provider);
        attempts.wellFormed = await EmissionSplit.bodyChecks(workspaceId, this.#executors(), this.#mimetypes);
        const attemptLimit = readEmissionAttempts();
        for (let attempt = 1; attempt <= attemptLimit;) {
            const verdict = await this.#issueProviderCall(args, request, attempts, attempt);
            if (verdict === "admitted") break;
            if (verdict === "rejected") attempt++;
        }
        if (!signal?.aborted) {
            const wire = aggregateProviderAccounting(attempts.turnWireAccounting);
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:turn",
                kind: "turn_generated",
                level: "info",
                message: "parsing model response",
                // {§operation-results} (#465) — the exact settled derivation,
                // never a second stored fact: a live watcher accrues loop cost per turn.
                accounting: {
                    requests: attempts.turnWireAccounting.length,
                    costUsd: wire.costUsd,
                    knownCostUsd: wire.knownCostUsd,
                    inputTokens: wire.usage?.inputTokens ?? null,
                    knownInputTokens: wire.knownUsage?.inputTokens ?? null,
                    outputTokens: wire.usage?.outputTokens ?? null,
                    knownOutputTokens: wire.knownUsage?.outputTokens ?? null,
                    reasoningTokens: wire.usage?.outputTokenDetails?.reasoningTokens ?? null,
                    knownReasoningTokens: wire.knownUsage?.outputTokenDetails?.reasoningTokens ?? null,
                    cacheReadTokens: wire.usage?.inputTokenDetails?.cacheReadTokens ?? null,
                    knownCacheReadTokens: wire.knownUsage?.inputTokenDetails?.cacheReadTokens ?? null,
                },
            });
        }
        if (attempts.response === undefined || attempts.split === undefined || attempts.modelCall === null) {
            throw new Error("provider attempt loop completed without a response");
        }
        const emission: ProviderEmission = {
            response: attempts.response,
            split: attempts.split,
            modelCallId: attempts.modelCall.id,
            railGrammar: attempts.railGrammar,
            railEvidence: attempts.railEvidence,
            emissionAttempts: attempts.emissionAttempts,
            signal: attempts.signal,
        };
        if (emission.split.packetAssistant.reasoning?.length) {
            await Turn.recordSource(this.#db, request.turnId, "reasoning", emission.split.packetAssistant.reasoning, { modelCallId: emission.modelCallId });
        }
        return emission;
    }

    // One logical provider call: its durable model call and attempt row, the exchange
    // under the reasoning observer, and its classification. {§engine-rails}
    // re-issues the same emission attempt; the parser's admission is the one verdict
    // on a completed exchange.
    async #issueProviderCall(
        args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts, attempt: number,
    ): Promise<"admitted" | "rejected" | "reissued"> {
        const { provider, workspaceId, sessionId, loopId } = args;
        // A recovery re-issue does not consume a grammar-emission attempt. Every
        // logical provider call still receives its own durable sequence and accounting.
        attempts.currentEmissionAttempt = attempt;
        attempts.modelCallSequence++;
        const attributionContext: ExtensionAttributionContext = Object.freeze({
            workspaceId: String(workspaceId),
            sessionId: attempts.providerSessionId,
            loop: request.loopSeq,
            turn: request.seq,
            attempt: attempts.modelCallSequence,
        });
        attempts.attributions = await this.#attemptAttributions(provider, attributionContext);
        request.packet = { ...request.packet, attributions: attempts.attributions };
        const modelCall = await ModelCall.open(this.#db, {
            turnId: request.turnId,
            kind: "emission",
            attributions: attempts.attributions,
            model: provider.model,
        });
        attempts.modelCall = modelCall;
        const attemptRow = await this.#db.engine_open_turn_attempt.get<{ id: number }>({
            model_call_id: modelCall.id,
        });
        if (attemptRow === undefined) {
            throw new Error(`Engine.runTurn: provider call ${attempts.modelCallSequence} did not open`);
        }
        attempts.attemptId = attemptRow.id;
        attempts.callInFlight = true;
        const reasoning = this.#reasoningObserver(args, request, modelCall);
        let completedResponse: ProviderResponse;
        try {
            completedResponse = await this.#generate(args, request, attempts, modelCall, reasoning);
        } catch (error) {
            if (error instanceof ProviderError
                && ProviderRecovery.RECOVERABLE.has(error.kind)
                && attempts.signal?.aborted !== true) {
                await this.#recoverProviderFailure(args, request, attempts, modelCall, attemptRow.id, error);
                return "reissued";
            }
            // {§tokenomics} — admission already shed for an exact refusal of this wire request;
            // an upstream refusal is the provider's own 413.
            throw error;
        } finally {
            reasoning.end();
        }
        if (attempts.recoveryFailures > 0) {
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:provider",
                kind: "provider_recovered",
                level: "info",
                message: `Provider recovered after ${attempts.recoveryFailures} failed call${attempts.recoveryFailures === 1 ? "" : "s"}.`,
            });
            attempts.recoveryFailures = 0;
            attempts.recoveryStartedAt = null;
        }
        attempts.response = completedResponse;
        attempts.turnWireAccounting.push(...completedResponse.accounting);
        await modelCall.observeResponse(completedResponse, null, attempts.wire.nativeInputs);
        attempts.railEvidence = attempts.railGrammar === undefined ? undefined : completedResponse.grammarEvidence;
        const split = EmissionSplit.splitResponse(completedResponse, this.#executors()?.availableRuntimes(workspaceId) ?? [], attempts.wellFormed);
        attempts.split = split;
        await this.#classifyProviderAttempt(attempts, attemptRow.id, split, attempt, split.emissionValid);
        return split.emissionValid ? "admitted" : "rejected";
    }

    // {§notifications} — only the parent emission is observed;
    // BARE has no observer on its isolated calls. Reasoning deltas cite the physical
    // request they stream in; a new request or the call's end closes the open span.
    #reasoningObserver({ workspaceId, sessionId, loopId }: TurnArgs, { turnId, loopSeq, seq: turnSeq }: TurnRequest, modelCall: ModelCall): ReasoningObserver {
        let reasoningStarted = false;
        let reasoningRequestSequence = 0;
        const end = (): void => {
            if (!reasoningStarted) return;
            this.#notify.reasoningEventNotify!(workspaceId, {
                sessionId,
                loopId,
                turnId,
                loopSeq,
                turnSeq,
                modelCallId: modelCall.id,
                requestSequence: reasoningRequestSequence,
                phase: "end",
            });
            reasoningStarted = false;
        };
        const observeRequest = async (...args: Parameters<ModelCall["observeRequest"]>) => {
            end();
            const settle = await modelCall.observeRequest(...args);
            reasoningRequestSequence = modelCall.requestSequence;
            return settle;
        };
        const observeReasoning = this.#notify.reasoningEventNotify === undefined
            ? undefined
            : (delta: string): void => {
                if (reasoningRequestSequence === 0) {
                    throw new Error("provider emitted reasoning before opening its physical request");
                }
                if (!reasoningStarted) {
                    reasoningStarted = true;
                    this.#notify.reasoningEventNotify!(workspaceId, {
                        sessionId,
                        loopId,
                        turnId,
                        loopSeq,
                        turnSeq,
                        modelCallId: modelCall.id,
                        requestSequence: reasoningRequestSequence,
                        phase: "start",
                    });
                }
                this.#notify.reasoningEventNotify!(workspaceId, {
                    sessionId,
                    loopId,
                    turnId,
                    loopSeq,
                    turnSeq,
                    modelCallId: modelCall.id,
                    requestSequence: reasoningRequestSequence,
                    phase: "content",
                    delta,
                });
            };
        return { observeRequest, observeReasoning, end };
    }

    // The exchange under its GenAI span: the packet's observations are recorded, the
    // provider generates against the wire request, and the call's accounting is
    // asserted whether it resolved or failed.
    async #generate(
        { provider, workspaceId }: TurnArgs, request: TurnRequest, attempts: ProviderAttempts,
        modelCall: ModelCall, reasoning: ReasoningObserver,
    ): Promise<ProviderResponse> {
        return await observed( // {§observability-boundary}
            genAiRequestName(provider.model),
            { model: provider.model, attempt: attempts.modelCallSequence },
            async (span) => {
                try {
                    await this.#packets.recordObservations(request.packet);
                    const generated = await provider.generate({
                        messages: attempts.wire.messages,
                        sessionId: attempts.providerSessionId,
                        workspaceId: String(workspaceId),
                        signal: attempts.signal,
                        grammar: attempts.railGrammar,
                        observeRequest: reasoning.observeRequest,
                        observeReasoning: reasoning.observeReasoning,
                        callKind: "emission",
                    }); // {§provider-surface} {§provider-surface} {§provider-surface} {§emission-admission}
                    modelCall.assertAccounting(generated.accounting);
                    attempts.callInFlight = false;
                    recordCounter(PROVIDER_CALLS, {
                        model: provider.model,
                        attempt: attempts.modelCallSequence,
                        status: "resolved",
                    });
                    span.setAttribute("status", "resolved");
                    settleGenAiResponse(span, generated);
                    return generated;
                } catch (error) {
                    if (error instanceof ProviderError) {
                        modelCall.assertAccounting(error.accounting);
                        attempts.turnWireAccounting.push(...error.accounting);
                    }
                    throw error;
                }
            },
            genAiRequestOptions(
                ProviderInstantiate.providerIdOf(provider) ?? "other",
                provider.model,
            ),
        );
    }

    // {§engine-rails} — a transient provider failure never ends the loop: record
    // it, wait, and re-issue the same turn; once the budget is spent the failure
    // handler parks the loop instead of failing it.
    async #recoverProviderFailure(
        { workspaceId, sessionId, loopId }: TurnArgs, request: TurnRequest, attempts: ProviderAttempts,
        modelCall: ModelCall, attemptId: number, error: ProviderError,
    ): Promise<void> {
        attempts.recoveryStartedAt ??= Date.now();
        const elapsed = Date.now() - attempts.recoveryStartedAt;
        if (elapsed >= attempts.recoveryBudget) {
            attempts.parked = true;
            throw error;
        }
        attempts.recoveryFailures += 1;
        const failure = ProviderAttemptRunner.providerFailure(error, attempts.signal);
        if (error.attempt !== undefined) {
            // {§provider-failure-normalization} — the interrupted response stays durable
            // as an unaccepted attempt; it is never admitted or replayed.
            await modelCall.observeResponse(error.attempt, failure, attempts.wire.nativeInputs);
            await this.#classifyProviderAttempt(attempts, attemptId, EmissionSplit.splitResponse(error.attempt, this.#executors()?.availableRuntimes(workspaceId) ?? [], attempts.wellFormed), attempts.currentEmissionAttempt, false);
        } else {
            await modelCall.fail(failure, error.capacity ?? null);
        }
        attempts.callInFlight = false;
        await this.#problems.record({
            sessionId,
            loopId,
            turnId: request.turnId,
            sequence: request.nextActionIndex++,
            origin: "_plurnk",
            source: "provider",
            result: failure,
        });
        const wait = ProviderRecovery.wait(attempts.recoveryBackoff, attempts.recoveryFailures);
        this.#notices.push(workspaceId, sessionId, loopId, {
            source: "engine:provider",
            kind: "provider_unavailable",
            level: "warn",
            message: `${failure.problem?.title ?? "Provider failure"}: retrying in ${Math.round(wait / 1000)}s (${Math.round(elapsed / 1000)}s of the ${Math.round(attempts.recoveryBudget / 1000)}s recovery budget spent).`,
        });
        // An abort during the wait re-enters generate, which refuses on the aborted signal.
        await delay(wait, undefined, { signal: attempts.signal }).catch(() => undefined);
        // The response is still owed for this exact input. Failure rows remain
        // durable, but recursively materializing them would mutate and cache-bust
        // the request being recovered. {§engine-rails}
    }

    // The attempt row's verdict: accepted, or rejected with the parser's errors. The
    // classified emission attempt is the turn's spent count.
    async #classifyProviderAttempt(attempts: ProviderAttempts, id: number, split: SplitProviderResponse, emissionAttempt: number, accepted: boolean): Promise<void> {
        const result = await this.#db.engine_classify_turn_attempt_response.run({
            id,
            accepted: accepted ? 1 : 0,
            parse_errors: JSON.stringify(split.parseErrors),
        });
        if (result.changes !== 1) {
            throw new Error(`emission attempt ${id} was not awaiting classification`);
        }
        attempts.emissionAttempts = emissionAttempt;
    }

    // The provider-call failure handler. It owns only failures raised while a call
    // was in flight; parser, cost, SQL, and engine-contract failures retain their
    // original source.
    async settleProviderFailure(err: unknown, args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts): Promise<EngineTurnResult> {
        if (err instanceof ModelCallPersistenceError || err instanceof ProviderAccountingIntegrityError) throw err;
        if (!attempts.callInFlight) throw err;
        attempts.callInFlight = false;
        if (attempts.attemptId === null || attempts.modelCall === null) {
            throw new Error("provider call failed without durable model-call and attempt identities", { cause: err });
        }
        const { provider, workspaceId, sessionId, loopId } = args;
        const { turnId } = request;
        const failure = ProviderAttemptRunner.providerFailure(err, attempts.signal);
        const capacityFailure = err instanceof ProviderError && err.kind === "capacity_exceeded";
        // {§provider-failure-normalization} — a provider-declared interruption
        // carries response evidence without becoming a completed exchange.
        // Persist it as an unaccepted attempt before settling the failure.
        if (err instanceof ProviderError && err.attempt !== undefined) {
            attempts.response = err.attempt;
            await attempts.modelCall.observeResponse(err.attempt, failure, attempts.wire.nativeInputs);
            attempts.split = EmissionSplit.splitResponse(err.attempt, this.#executors()?.availableRuntimes(workspaceId) ?? [], attempts.wellFormed);
            await this.#classifyProviderAttempt(attempts, attempts.attemptId, attempts.split, attempts.currentEmissionAttempt, false);
        } else {
            await attempts.modelCall.fail(
                failure,
                err instanceof ProviderError ? err.capacity ?? null : null,
            );
            if (!capacityFailure) attempts.emissionAttempts = attempts.currentEmissionAttempt;
        }
        const evidence = this.requestEvidence(provider, request.packet, attempts.split, attempts.response);
        // {§emission-admission} — a ProviderError means no completed exchange exists.
        // Persist its exact RFC 9457 result before propagating it. Grammar transport
        // evidence exists only on completed responses ({§provider-instantiation}).
        // Cancellation is lifecycle truth, not a provider failure. Close the
        // attempted turn without inventing an assistant response, then let
        // runLoop/Daemon settle the exact 504/499 loop result.
        if (attempts.signal?.aborted) {
            const status = attempts.signal.reason === LOOP_TIMEOUT_REASON ? 504 : 499;
            await this.#recordInference({ workspaceId, sessionId, loopId, turnId, evidence });
            await Turn.complete(this.#db, turnId, status);
            throw err;
        }
        const recorded = await this.#problems.record({
            sessionId,
            loopId,
            turnId,
            sequence: request.nextActionIndex,
            origin: "_plurnk",
            source: "provider",
            result: failure,
        });
        // The provider call was attempted, but no completed exchange exists.
        // Persist the exact request half and failure status; omitting assistant
        // is materially different from fabricating an empty model turn.
        await this.#recordInference({ workspaceId, sessionId, loopId, turnId, evidence });
        await Turn.complete(this.#db, turnId, attempts.parked ? 202 : recorded.result.status);
        const { emissionAttempts } = attempts;
        if (attempts.parked) {
            // {§engine-rails} — the recovery budget is spent: the loop parks exactly like a
            // [202] wait and resumes on the next prompt or wake; the failure stays durable.
            const recoverable = await SessionOwners.interactive(this.#db, loopId);
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:provider",
                kind: "provider_unavailable",
                level: "error",
                message: `${recorded.result.problem?.title ?? "Provider failure"}: the ${Math.round(attempts.recoveryBudget / 1000)}s recovery budget is spent; ${recoverable ? "the loop is parked and resumes on the next prompt or wake" : "nobody attends the session's owner, so the loop ends here"}.`,
            });
            return turnResult(request, 202, { providerParked: true, providerFailure: recorded.result, emissionAttempts });
        }
        if (capacityFailure) {
            return turnResult(request, recorded.result.status, { capacityHardStop: true, capacityFailure: recorded.result, emissionAttempts });
        }
        if (err instanceof ProviderError && (err.kind === "invalid_response" || err.kind === "generation_failed")) {
            // {§engine-rails} Contract Strikes: the provider violated its response contract, or
            // ended generation with an error ({§provider-failure-normalization}). The failure is durable
            // and the turn is complete; the strike rail — never an instant loop death — rules whether
            // the streak ends it.
            return turnResult(request, recorded.result.status, {
                outcomes: [{ op: null, status: recorded.result.status, problemType: recorded.result.problem?.type ?? null }],
                fingerprint: `provider-contract-violation:${turnId}`,
                providerFailure: recorded.result,
                emissionAttempts,
            });
        }
        throw new OperationFailureError(recorded.result, { cause: err });
    }

    // Inference evidence for a turn without an admitted exchange: the exact request
    // half, the last attempt's metadata when one exists, the provider's own model otherwise.
    requestEvidence(provider: Provider, packet: RequestPacket, split: SplitProviderResponse | undefined, response: ProviderAttempt | undefined): InferenceEvidence {
        return {
            packet: StoredPacket.stringify(packet),
            sections: StoredPacket.sections(packet),
            usageCurationBudget: this.#packets.curationBudgetFor(packet),
            finishReason: split?.callMetadata.finishReason ?? null,
            model: split?.callMetadata.model ?? provider.model,
            meta: JSON.stringify(response?.meta ?? {}),
        };
    }
}
