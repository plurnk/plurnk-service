import { PlurnkParser, PlurnkParseError, UNKNOWN_POSITION } from "@plurnk/plurnk-contracts";
import Owner from "./Owner.ts";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { BareStatement, PlurnkStatement, EditStatement, ReadStatement, UrlPath, FindStatement, PlanStatement, SendStatement } from "@plurnk/plurnk-contracts";

// Internal-only — collected from PlurnkParser output, then translated to
// Notice envelopes are defined by @plurnk/plurnk-contracts.
// before being pushed to the loop's notices buffer.
type ParseErrorInfo = { message: string; line: number; column: number; source: string };
const TERMINAL_SEND_SIGNALS = new Set([102, 200, 202, 499]);
const comparePosition = (
    a: { line: number; column: number },
    b: { line: number; column: number },
): number => a.line - b.line || a.column - b.column;
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Meta, { type PluginAttributionContext } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import type { EntryData } from "../schemes/_entry-crud.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import GitMembership, { type FsDivergence } from "./git-membership.ts";
import GitState, { type GitStatusSnapshot } from "./git-state.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import type { PlurnkSchemeContext, WriterTier } from "./scheme-types.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { StreamEventNotify, WakeWorkerNotify } from "./ChannelWrite.ts";
import { editedSpan } from "../content/index.ts";
import { promptPathname, promptLoopPrefix, renderTarget } from "./plurnk-uri.ts";
import LiveSubscriptions from "./LiveSubscriptions.ts";
import { readFile } from "node:fs/promises";
// {§grammar-rail-registration} — bare names are the built-in rail namespace;
// everything else is an import specifier resolved through the Node chain.
export const resolveGrammarRailPath = (variant: string): string => variant.startsWith("/") || variant.startsWith(".")
    || variant.includes("/") || variant.includes(":")
    ? (variant.startsWith("/") || variant.startsWith(".")
        ? variant
        : fileURLToPath(import.meta.resolve(variant)))
    : fileURLToPath(import.meta.resolve(`@plurnk/plurnk-contracts/${variant}`));
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";
import Results, { OperationFailureError, type SchemeResult } from "./results.ts";
import BranchReceipt from "./BranchReceipt.ts";
import TerminalResult from "./TerminalResult.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import Turn from "./Turn.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import type ClientInteractions from "./ClientInteractions.ts";

// TurnRunner owns one inference cycle and any initialization or overflow turn
// that precedes provider admission; Engine retains the surrounding loop
// lifecycle and public facade.
import NoticeChannel from "./NoticeChannel.ts";
import ProblemLog from "./ProblemLog.ts";
import StrikeRail, { type StrikeOutcome } from "./StrikeRail.ts";
import PacketBuilder, { type ChatMessage, type CurationOverflow } from "./PacketBuilder.ts";
import StoredPacket, { type PacketAssistant } from "./StoredPacket.ts";
import Dispatcher from "./Dispatcher.ts";
import type { DispatchContext, DispatchResult } from "./Dispatcher.ts";
import { observed, observedSync } from "../observe/spans.ts";
import {
    GEN_AI_REQUEST_SPAN,
    genAiRequestOptions,
    settleGenAiResponse,
} from "../observe/genai.ts";
import { OPS_DISPATCHED, PROVIDER_CALLS, recordCounter } from "../observe/metrics.ts";
import { scheduleTurnOps } from "./turn-scheduler.ts";
import { expandSafeUriTargetGroup } from "./operation-target-groups.ts";
import { readOptimisticSettlementMs } from "./optimistic-settlement.ts";
import ModelCall, {
    ModelCallPersistenceError,
    ProviderAccountingIntegrityError,
} from "./ModelCall.ts";
import OverflowTurn from "./OverflowTurn.ts";
import TurnOps, { type InternalTurnStatement } from "./TurnOps.ts";

const RECORD_STREAM_MIMETYPES = new Set(["application/jsonl", "application/x-ndjson"]);

const baseMimetype = (mimetype: string): string =>
    mimetype.split(";", 1)[0]!.trim().toLowerCase();

// {§exec-stream} Active streams publish only independently meaningful units.
// Atomic documents wait for close; JSONL stops after its last complete record.
const streamPublicationEnd = (
    content: string,
    mimetype: string,
    cursor: number,
    closed: boolean,
): number => {
    const type = baseMimetype(mimetype);
    if (closed || type.startsWith("text/")) return content.length;
    if (!RECORD_STREAM_MIMETYPES.has(type)) return cursor;
    return Math.max(cursor, content.lastIndexOf("\n") + 1);
};

const ENGINE_PROBLEMS = Object.freeze({
    max_commands_exceeded: {
        status: 429,
        code: "max-commands-exceeded",
        detail: "Later operations were not executed because the turn exceeded its operation limit.",
    },
    idle_turn: {
        status: 409,
        code: "idle-turn",
        detail: "`## SEND0 [102]` was emitted without an operation to continue from.",
    },
} as const);
type EngineProblemKind = keyof typeof ENGINE_PROBLEMS;

// The prompt entry target - prompt:///<loop>/<N>, self-only ({§prompt-self-only}):
// the owner rides the owner_id column, the address carries only the loop coordinate.
const promptTarget = (loopSeq: number, promptOrdinal: number): UrlPath => {
    const storage = promptPathname(loopSeq, promptOrdinal);
    return {
        kind: "url", raw: `prompt://${storage}`,
        scheme: "prompt", username: null, password: null,
        hostname: null, port: null,
        pathname: storage, query: null, fragment: null,
    };
};

const assertOpenPaths = (value: unknown, source: string): string[] => {
    if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || path.length === 0)) {
        throw new TypeError(`${source}: expected an array of non-empty strings`);
    }
    return value as string[];
};

const parsePromptAttributes = (encoded: string, source: string): Readonly<Record<string, unknown>> => {
    const attributes = JSON.parse(encoded) as unknown;
    if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
        throw new TypeError(`${source}: expected a JSON object`);
    }
    return attributes as Readonly<Record<string, unknown>>;
};

// Per-emission action ceiling — OFF by default. `-1` (or unset/non-positive) = no cap:
// every generated op dispatches. Runaway degeneration is a sampler concern (repetition penalty),
// not grounds to drop already-generated work. A positive value is an operator ceiling a
// workspace's maxCommands may tighten (min wins), never widen
// ({§operator-config-workspace-max-commands}).
const readMaxCommands = (): number => {
    const raw = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    if (raw === undefined || raw.length === 0) return Number.POSITIVE_INFINITY;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return Number.POSITIVE_INFINITY;
    return n;
};

// PLURNK_SERVICE_FILES_ITEMS — the turn-0 catalog preview. null = off;
// -1 = the ordinary markerless page; positive N explicitly caps file rows. 0 / unset = off.
const normalizeFilesItems = (n: number): number | null => (!Number.isFinite(n) || n === 0 ? null : n < 0 ? -1 : n);
const readFilesItems = (): number | null => {
    const raw = process.env.PLURNK_SERVICE_FILES_ITEMS;
    if (raw === undefined || raw.length === 0) return null;
    return normalizeFilesItems(Number.parseInt(raw, 10));
};

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type {
    GrammarEvidence,
    Provider,
    ProviderAttempt,
    ProviderAttemptFinishReason,
    ProviderEncryptedReasoningItem,
    ProviderResponse,
} from "@plurnk/plurnk-providers";
import {
    ProviderError,
    scopeEnvToAlias,
} from "@plurnk/plurnk-providers";
import { validateGbnf } from "@plurnk/gbnf";
import ProviderInstantiate from "./ProviderInstantiate.ts";

// Split-out call-metadata that travels with the parsed packet but lands in
// Turn columns instead of packet.assistant.
type TurnCallMetadata = {
    finishReason: ProviderAttemptFinishReason;
    model: string;
};

type SplitProviderResponse = {
    packetAssistant: PacketAssistant;
    sourceBacked: boolean;
    callMetadata: TurnCallMetadata;
    parseErrors: ParseErrorInfo[];
    recoverableParseErrors: ParseErrorInfo[];
    parseNotices: Notice[];
    emissionValid: boolean;
};

type GrammarConstraint = {
    transport: string;
    response: string;
};

type ResolvedGrammarConstraint = GrammarConstraint & {
    allowWithheld: boolean;
};

// A generated rail may constrain only the sampled continuation while the chat
// template contributes a prefix that llama-server preserves in its response.
// The artifact names the alternate root that composes those bytes for evidence
// grading; arbitrary grammars without the declaration retain their transport root.
const grammarConstraint = (grammar: string): GrammarConstraint => {
    const declarations = [...grammar.matchAll(/^# @plurnk-response-root ([A-Za-z][A-Za-z0-9-]*)$/gm)];
    if (declarations.length === 0) return { transport: grammar, response: grammar };
    if (declarations.length !== 1) throw new Error("GBNF constraint declares multiple @plurnk-response-root values");
    const responseRoot = declarations[0]![1]!;
    if (!grammar.split("\n").some((line) => line.startsWith(`${responseRoot} ::=`))) {
        throw new Error(`GBNF constraint declares missing response root ${responseRoot}`);
    }
    const roots = [...grammar.matchAll(/^root ::= ([A-Za-z][A-Za-z0-9-]*)$/gm)];
    if (roots.length !== 1) throw new Error("GBNF constraint must declare exactly one simple root");
    return {
        transport: grammar,
        response: grammar.replace(roots[0]![0], `root ::= ${responseRoot}`),
    };
};

type EngineTurnResult = {
    createdTurnIds: number[];
    turnId: number;
    status: number;
    outcomes: StrikeOutcome[];
    fingerprint: string;
    capacityHardStop: boolean;
    steerStruck: boolean;
    emissionAttempts: number;
    emissionExhausted: boolean;
    rejectedModelEntryId?: number;
    capacityFailure?: SchemeResult;
    curationFailure?: SchemeResult;
} & (
    | { producer: "model"; kind: "inference" }
    | { producer: "_plurnk"; kind: "overflow" }
);

type BareBatchResult = {
    readonly statement: BareStatement;
    readonly modelCallId: number;
    readonly result: DispatchResult;
};

type BareExecution = {
    readonly provider: Provider;
    readonly modelCallSequenceStart: number;
    readonly primaryWorkerId: string;
    readonly loopSequence: number;
    readonly turnSequence: number;
    readonly signal: AbortSignal | undefined;
};

type AdmittedTurnResult = {
    readonly status: number;
    readonly outcomes: StrikeOutcome[];
    readonly fingerprint: string;
    readonly steerStruck: boolean;
};

const TOKEN_BUDGET_OVERFLOW_HARD_DETAIL = "Context Token Budget Overflow: tokensActiveTotal exceeded tokensActiveMax, and the causal overflow turn could not make enough room.";

const curationOverflowFailure = (pressure: CurationOverflow): SchemeResult => Results.failure(
    "engine:context",
    "token-budget-overflow",
    413,
    TOKEN_BUDGET_OVERFLOW_HARD_DETAIL,
    {},
    {
        usage: pressure.weight,
        ceiling: pressure.budget,
        deficit: pressure.excess,
    },
);

// Runtime normalization for a disposition the engine refuses or resolves as a
// continue after dispatch ({§send}). Every admitted emission itself ends in an
// explicit disposition SEND ({§emission-admission}).
const TURN_STATUS_IMPLICIT_CONTINUE = 102;
const INVALID_EMISSION_RECOVERY_MESSAGE = "Your previous response contained an unrecoverable syntax error. No operations were performed. Try again.";

const readEmissionAttempts = (): number => {
    const raw = process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
    const value = Number.parseInt(raw ?? "", 10);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`PLURNK_SERVICE_EMISSION_ATTEMPTS must be a positive integer; got ${raw}`);
    }
    return value;
};

// The wall's abort reason — runLoop branches a mid-turn teardown to the 504 terminal on it.
export const LOOP_TIMEOUT_REASON = "loop_timeout";

type TurnDispatch = (context: DispatchContext) => Promise<DispatchResult>;
type WarmWorkspace = (
    context: PlurnkSchemeContext,
    invalidate?: boolean,
    materialize?: boolean,
) => Promise<void>;

export default class TurnRunner {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #mimetypes: Mimetypes;
    readonly #weighContent: (text: string) => number;
    readonly #notices: NoticeChannel;
    readonly #problems: ProblemLog;
    readonly #strikes: StrikeRail;
    readonly #packets: PacketBuilder;
    readonly #dispatcher: Dispatcher;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #streamEventNotify: StreamEventNotify | undefined;
    readonly #wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly #executors: () => ExecutorRegistry | undefined;
    readonly #loopSignal: (loopId: number) => AbortSignal | undefined;
    readonly #interactions: ClientInteractions;
    readonly #warmWorkspace: WarmWorkspace;
    readonly #dispatch: TurnDispatch;
    readonly #resolveWorkerProviderIdentity: (workerId: number) => Promise<{
        workerId: string;
        primaryWorkerId: string;
    }>;
    #gbnfCache = new Map<string, GrammarConstraint>();

    constructor({
        db,
        schemes,
        mimetypes,
        weigh,
        notices,
        problems,
        strikes,
        packets,
        dispatcher,
        liveSubscriptions,
        streamEventNotify,
        wakeWorkerNotify,
        executors,
        loopSignal,
        interactions,
        warmWorkspace,
        dispatch,
        resolveWorkerProviderIdentity,
    }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        weigh: (text: string) => number;
        notices: NoticeChannel;
        problems: ProblemLog;
        strikes: StrikeRail;
        packets: PacketBuilder;
        dispatcher: Dispatcher;
        liveSubscriptions: LiveSubscriptions;
        streamEventNotify?: StreamEventNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        interactions: ClientInteractions;
        warmWorkspace: WarmWorkspace;
        dispatch: TurnDispatch;
        resolveWorkerProviderIdentity: (workerId: number) => Promise<{
            workerId: string;
            primaryWorkerId: string;
        }>;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#mimetypes = mimetypes;
        this.#weighContent = weigh;
        this.#notices = notices;
        this.#problems = problems;
        this.#strikes = strikes;
        this.#packets = packets;
        this.#dispatcher = dispatcher;
        this.#liveSubscriptions = liveSubscriptions;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#interactions = interactions;
        this.#warmWorkspace = warmWorkspace;
        this.#dispatch = dispatch;
        this.#resolveWorkerProviderIdentity = resolveWorkerProviderIdentity;
    }

    // {§rail-truth-engine-verdict} — the verify GAP (a configured grammar @plurnk/gbnf can't
    // parse): warn once per message, never per turn; the turn records railsVerdict "unverifiable".
    static #railGapWarned = new Set<string>();
    static #warnRailVerdictGapOnce(message: string): void {
        if (TurnRunner.#railGapWarned.has(message)) return;
        TurnRunner.#railGapWarned.add(message);
        process.stderr.write(`plurnk-engine: rail verdict unavailable — the configured grammar did not parse in @plurnk/gbnf (${message})\n`);
    }

    static #requireGrammarEvidence(response: ProviderResponse, allowWithheld: boolean): GrammarEvidence {
        const evidence = response.grammarEvidence;
        if (evidence === undefined) {
            throw new Error("provider contract violation: configured GBNF response omitted grammar evidence");
        }
        const input = [...evidence.input];
        if (!Number.isInteger(evidence.contentStart)
            || evidence.contentStart < 0
            || evidence.contentStart > input.length
            || typeof evidence.transported !== "boolean"
            || input.slice(evidence.contentStart).join("") !== response.assistant.content) {
            throw new Error("provider contract violation: grammar evidence does not map exactly to assistant.content");
        }
        if (!allowWithheld && !evidence.transported) {
            throw new Error("provider contract violation: configured GBNF was not transported outside explicit debug mode");
        }
        return evidence;
    }


    async #grammarConstraint(provider: Provider): Promise<ResolvedGrammarConstraint | undefined> {
        // A real alias scopes its rail; an alias-free direct route uses the
        // global provider configuration. Unrelated alias settings never apply.
        // {§grammar-configuration-admission}
        ProviderInstantiate.assertGrammarConfigurationScope(provider);
        const alias = ProviderInstantiate.configurationAliasOf(provider);
        const scoped = alias === undefined
            ? process.env
            : scopeEnvToAlias(process.env, alias, [
                "PLURNK_PROVIDERS_GBNF",
                "PLURNK_PROVIDERS_GBNF_DEBUG",
            ]);
        const variant = scoped.PLURNK_PROVIDERS_GBNF;
        if (variant === undefined || variant === "" || variant === "0") return undefined;
        const allowWithheld = scoped.PLURNK_PROVIDERS_GBNF_DEBUG !== undefined
            && scoped.PLURNK_PROVIDERS_GBNF_DEBUG !== ""
            && scoped.PLURNK_PROVIDERS_GBNF_DEBUG !== "0";
        const hit = this.#gbnfCache.get(variant);
        if (hit !== undefined) return { ...hit, allowWithheld };
        // {§grammar-rail-registration} — a bare name is a built-in rail subpath
        // under @plurnk/plurnk-contracts; any other form is an import specifier
        // (an operator file path or a package export subpath), so a third-party
        // rail package plugs in with no built-in registry change.
        const path = resolveGrammarRailPath(variant);
        const text = await readFile(path, "utf8");  // unresolvable/unreadable throws — a configured rail never silently degrades
        const constraint = grammarConstraint(text);
        this.#gbnfCache.set(variant, constraint);
        process.stderr.write(`plurnk-engine: GBNF constraint: ${alias || "(bare)"} → ${variant} (${text.length} chars)\n`);
        return { ...constraint, allowWithheld };
    }

    // A lineage's no-parent root; a root worker resolves to itself. Fail hard
    // when corruption leaves a worker without one. {§worker-primary}

    async #attemptAttributions(
        provider: Provider,
        context: PluginAttributionContext,
    ): Promise<string[]> {
        const tags = Meta.composeAttributions(
            this.#schemes.attributions(context),
            this.#executors()?.attributions(context) ?? [],
            await this.#mimetypes.attributions(context),
            provider.attributions?.(context) ?? [],
        );
        return [...tags];
    }

    #providerAttributions(
        provider: Provider,
        context: PluginAttributionContext,
    ): string[] {
        return [...Meta.composeAttributions(provider.attributions?.(context) ?? [])];
    }

    static #providerFailure(error: unknown, signal: AbortSignal | undefined): SchemeResult {
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

    async #runBareBatch({
        statements,
        provider,
        turnId,
        modelCallSequenceStart,
        workspaceId,
        workerId,
        primaryWorkerId,
        loopSequence,
        turnSequence,
        signal,
    }: {
        statements: readonly BareStatement[];
        provider: Provider;
        turnId: number;
        modelCallSequenceStart: number;
        workspaceId: number;
        workerId: number;
        primaryWorkerId: string;
        loopSequence: number;
        turnSequence: number;
        signal: AbortSignal | undefined;
    }): Promise<BareBatchResult[]> {
        const prepared: Array<{
            statement: BareStatement;
            modelCall: ModelCall;
            attributions: string[];
            providerWorkerId: string;
        }> = [];
        for (const [index, statement] of statements.entries()) {
            const providerWorkerId = randomUUID();
            const attributionContext: PluginAttributionContext = Object.freeze({
                workspaceId: String(workspaceId),
                workerId: providerWorkerId,
                primaryWorkerId,
                loop: loopSequence,
                turn: turnSequence,
                attempt: 1,
            });
            const attributions = this.#providerAttributions(provider, attributionContext);
            const modelCall = await ModelCall.open(this.#db, {
                turnId,
                sequence: modelCallSequenceStart + index,
                kind: "bare",
                attributions,
                model: provider.model,
            });
            prepared.push({ statement, modelCall, attributions, providerWorkerId });
        }

        const settlements = await Promise.allSettled(prepared.map(async ({ statement, modelCall, attributions, providerWorkerId }) => {
            try {
                const response = await observed(
                    GEN_AI_REQUEST_SPAN,
                    { model: provider.model, attempt: 1, kind: "bare" },
                    async (span) => {
                        try {
                            const generated = await provider.generate({
                                messages: [{ role: "user", content: statement.body }],
                                workerId: providerWorkerId,
                                primaryWorkerId,
                                signal,
                                attributions: attributions.length > 0 ? attributions : undefined,
                                workspaceId: String(workspaceId),
                                loop: loopSequence,
                                turn: turnSequence,
                                observeRequest: modelCall.observeRequest,
                                callKind: "bare",
                            });
                            modelCall.assertAccounting(generated.accounting);
                            recordCounter(PROVIDER_CALLS, {
                                model: provider.model,
                                attempt: 1,
                                status: "resolved",
                            });
                            span.setAttribute("status", "resolved");
                            settleGenAiResponse(span, generated);
                            return generated;
                        } catch (error) {
                            if (error instanceof ProviderError) {
                                modelCall.assertAccounting(error.accounting);
                            }
                            throw error;
                        }
                    },
                    genAiRequestOptions(
                        ProviderInstantiate.aliasOf(provider) ?? "plurnk",
                        provider.model,
                    ),
                );
                await modelCall.observeResponse(response);
                return {
                    statement,
                    modelCallId: modelCall.id,
                    result: Results.assert({
                        status: 200,
                        content: response.assistant.content,
                        mimetype: "text/plain",
                    }),
                };
            } catch (error) {
                if (error instanceof ModelCallPersistenceError || error instanceof ProviderAccountingIntegrityError) {
                    throw error;
                }
                const failure = TurnRunner.#providerFailure(error, signal);
                if (error instanceof ProviderError && error.attempt !== undefined) {
                    await modelCall.observeResponse(error.attempt, failure);
                } else {
                    await modelCall.fail(failure);
                }
                return { statement, modelCallId: modelCall.id, result: failure };
            }
        }));

        const internalFailure = settlements.find(
            (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
        );
        if (internalFailure !== undefined) throw internalFailure.reason;
        signal?.throwIfAborted();
        return settlements.map((settlement) => (settlement as PromiseFulfilledResult<BareBatchResult>).value);
    }

    // {§attribution} — reporting derives from exact provider-request evidence;
    // malformed durable tags fail here instead of being silently filtered.

    #offsetToLineColumn(content: string, offset: number): { line: number; column: number } {
        const cps = Array.from(content);
        const clamped = Math.max(0, Math.min(offset, cps.length));
        let line = 1;
        let column = 0;
        for (let i = 0; i < clamped; i++) {
            if (cps[i] === "\n") { line++; column = 0; } else { column++; }
        }
        return { line, column };
    }

    // {§turn-ops-admission-path} — source acquisition ends before this seam.
    // Every admitted producer program is scheduled, dispatched, recorded, and
    // completed here; inference is only the model-specific way one program is
    // acquired and supplied with BARE capability.
    async #executeAdmittedTurn({
        statements,
        source,
        sourceFolded,
        sourceModelCallId = null,
        sourceReasoningItems,
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
    }: {
        statements: readonly PlurnkStatement[];
        source: string | null;
        sourceFolded: boolean;
        sourceModelCallId?: number | null;
        sourceReasoningItems?: ReadonlyArray<ProviderEncryptedReasoningItem>;
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
    }): Promise<AdmittedTurnResult> {
        const plan = statements[0];
        const finalOp = statements.at(-1);
        if (finalOp?.op !== "SEND") {
            throw new Error("an admitted operation batch must end in a disposition SEND");
        }
        if (source !== null && plan?.op !== "PLAN") {
            throw new Error("an admitted source-backed turnOps program must begin with PLAN");
        }
        const dispositionSignal = finalOp.signal;
        if (typeof dispositionSignal !== "number" || !TERMINAL_SEND_SIGNALS.has(dispositionSignal)) {
            throw new Error("an admitted turnOps program must end in a terminal disposition SEND");
        }
        const sendOp = finalOp;
        let turnStatus = dispositionSignal;
        let steerStruck = false;
        const pendingEngineErrors: EngineProblemKind[] = [];
        const middleCount = statements.filter((statement) => statement.op !== "PLAN" && statement.op !== "SEND").length
            + recoverableParseErrors.length;
        if (enforceIdle && turnStatus === TURN_STATUS_IMPLICIT_CONTINUE && middleCount === 0) {
            steerStruck = true;
            pendingEngineErrors.push("idle_turn");
        }

        let realCommands = 0;
        const admitted = statements.filter((statement) => statement.op === "PLAN"
            || statement === sendOp
            || realCommands++ < maxCommands);
        const scheduled = scheduleTurnOps(admitted.flatMap(expandSafeUriTargetGroup));
        await this.#dispatcher.prepareEditBatches(
            scheduled.filter((statement): statement is EditStatement => statement.op === "EDIT"),
            { workspaceId, workerId, loopId, turnId, origin, onDispatch },
        );
        const droppedCount = statements.length - admitted.length;
        const bareStatements = scheduled.filter(
            (statement): statement is BareStatement => statement.op === "BARE",
        );
        let bareResults: ReadonlyMap<BareStatement, BareBatchResult> | null = null;
        const outcomes: StrikeOutcome[] = [];
        let rowSequence = fromSequence;
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
                            recovery: "Correct only the failed operation; sibling operations were retained.",
                            retryable: false,
                        },
                    ),
                });
                outcomes.push({ op: null, status: recorded.result.status });
                onDispatch?.(recorded.id);
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
                            const batch = await this.#runBareBatch({
                                statements: bareStatements,
                                provider: bare.provider,
                                turnId,
                                modelCallSequenceStart: bare.modelCallSequenceStart,
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
                            onDispatch,
                        });
                    }
                    span.setAttribute("status", dispatchResult.status);
                    recordCounter(OPS_DISPATCHED, { op: statement.op, status: dispatchResult.status });
                    return dispatchResult;
                },
            );
            outcomes.push({ op: statement.op, status: result.status });
            if (failOnOperationError && result.status >= 400) throw new OperationFailureError(result);
            for (const normalization of result.scopeNormalizations ?? []) {
                this.#notices.push(workspaceId, loopId, {
                    source: "engine:slicer",
                    kind: "scope_normalized",
                    level: "warn",
                    message: `Scope <${normalization.requested.join(",")}> was normalized to <${normalization.canonical.join(",")}>.`,
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
                && sendOp.signal === 202
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
                    recovery: "Perform an operation before continuing with `## SEND0 [102]`.",
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
            fingerprint: StrikeRail.fingerprintTurn(statements),
            steerStruck,
        };
    }


    async runTurn({
        provider, childProvider = provider, messages, requirements = "", workspaceId, workerId, loopId, signal, onDispatch,
        turnNumber = 1, maxTurns = 50, invalidEmissionRecoveryEntryId,
    }: {
        provider: Provider;
        childProvider?: Provider;
        messages: ChatMessage[];
        // Optional Recap override; packet assembly owns default sourcing.
        requirements?: string;
        workspaceId: number; workerId: number; loopId: number;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        // Model-attempt ordinal in the surrounding loop. Attempt 1 admits the
        // initial prompt only while its durable publication is still absent.
        turnNumber?: number;
        maxTurns?: number;
        // Omitted outside loop admission; null grants the first recovery, and
        // an id identifies the rejected row informing this turn.
        invalidEmissionRecoveryEntryId?: number | null;
    }): Promise<EngineTurnResult> {
        const allowInvalidEmissionRecovery = invalidEmissionRecoveryEntryId === null;
        const transientOpenLogEntryId = typeof invalidEmissionRecoveryEntryId === "number"
            ? invalidEmissionRecoveryEntryId
            : null;
        // === Producer-neutral turn container ===
        //
        // Every producer opens the same durable turn and completes it only
        // after its ordered operations settle. Model packets and provider
        // metadata are optional inference evidence, not turn identity.
        const initialSequence = await this.#db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        if (initialSequence === undefined) throw new Error("Engine.runTurn: next turn sequence is unavailable");
        // loops.sequence is the loop's ordinal within the worker. Turn-0 foists that belong to the
        // WORKER (manifest preview, AGENTS, operator docs) gate on the worker's first loop, not every loop's
        // first turn ({§actor-boundary-catalog-preview}); per-loop foists such as
        // {§prompt-entry} still fires once per loop. Durable publication state,
        // rather than the model-turn ordinal, prevents an overflow diversion
        // from replaying the prompt and its automatic path READs.
        const loopRow = await this.#db.engine_get_loop_prompt.get<{
            prompt: string;
            sequence: number;
            open_paths: string;
            prompt_published: number;
        }>({ loop_id: loopId });
        const workerFirstLoop = (loopRow?.sequence ?? 0) === 1;
        const createdTurnIds: number[] = [];
        try {
        // {§worker-initialization-entry} — turn zero is an ordinary `_plurnk`
        // operation turn. Its model-facing zero is a phase label; durable turn
        // coordinates remain one-based.
        const initializationTurn = initialSequence.next === 1 && workerFirstLoop
            ? await Turn.open(this.#db, { loopId, producer: "_plurnk", kind: "initialization" })
            : null;
        if (initializationTurn !== null) createdTurnIds.push(initializationTurn.id);
        let modelTurn = initializationTurn === null
            ? await Turn.open(this.#db, { loopId, producer: "model", kind: "inference" })
            : null;
        if (modelTurn !== null) createdTurnIds.push(modelTurn.id);
        // {§env-delta-log-pull} — establish a fresh worker's observation
        // baseline immediately after its first turn opens. A fork already has
        // its parent's cursor, so the NULL-guarded statement leaves it intact.
        // Events committed after this statement belong to this or a later
        // closed pull window; pre-existing state is read through the ordinary
        // shared-world projections in this first packet.
        await this.#db.engine_initialize_ambient_cursor.get({ workspace_id: workspaceId, worker_id: workerId });
        // Threaded per turn, never engine state, so concurrent loops on
        // different providers each read their own honest tokenizer values.
        const systemContext = (contextTurnId: number): PlurnkSchemeContext => ({
            db: this.#db, workspaceId, workerId, loopId, turnId: contextTurnId,
            writer: "_plurnk",
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            weigh: this.#weighContent,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s, workspaceId),
            pushNotice: (notice) => this.#notices.push(workspaceId, loopId, notice),
            requestInteraction: (request) => this.#interactions.request(
                request,
                { workspaceId, workerId, loopId, turnId: contextTurnId },
                this.#loopSignal(loopId),
            ),
        });
        let systemCtx = systemContext(initializationTurn?.id ?? modelTurn!.id);
        const initializationStatements: InternalTurnStatement[] = [];
        // {§worker-initialization-entry} — the worker's first turn is the worked
        // example itself: an ordinary PLAN, the actual orienting operations,
        // and an ordinary terminal SEND.
        if (initializationTurn !== null) {
            const plan: PlanStatement = {
                op: "PLAN", delimiter: "", annotation: null,
                signal: null, target: null, lineMarker: null,
                body: "* Discover the tooling available and survey the workspace file root.",
                position: UNKNOWN_POSITION,
            };
            initializationStatements.push(plan);
            // {§turn0-agents-stunt} — the project AGENTS.md (materialized by LoopDocs as
            // worker://plurnk/agents.md) gets one foisted READ on the worker's first
            // loop, so local repo guidance is visible turn-0 content. Global policy
            // stays in the system prompt; nothing else is force-read.
            if (workerFirstLoop) {
                const kernelId = await Owner.kernelId(this.#db, workspaceId);
                const agentsEntry = await this.#db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId,
                    owner_id: kernelId,
                    scheme: "worker",
                    pathname: "/agents.md",
                });
                if (agentsEntry !== undefined) {
                    const agentsTarget: UrlPath = {
                        kind: "url", raw: "worker://plurnk/agents.md", scheme: "worker",
                        username: null, password: null, hostname: "plurnk", port: null,
                        pathname: "/agents.md", query: null, fragment: null,
                    };
                    const agentsRead: ReadStatement = {
                        op: "READ", delimiter: "", annotation: null, signal: ["+_plurnk", "+init", "+policy"], target: agentsTarget,
                        lineMarker: null, body: null, position: UNKNOWN_POSITION,
                    };
                    initializationStatements.push(agentsRead);
                }
            }
        }
        // The persistent search-index pass (_search-index.maintain) attaches
        // every readable entry/log projection to complete graph/FTS/vector derivations.
        // NOT an action: no log entry, no sequence slot,
        // not dispatched. There is no materialized manifest entry — the catalog
        // is served on demand by FIND: recursive when asked, shallow-mapped below.
        // {§semantic-embed-dedup} — one pass-wide semantic plan binds every
        // chunk counter to the derivation identity it produces.
        // SPEC {§membership} D4/D5 — git-ls-files workspace membership, resolved at
        // prompt-composition (EMI is eager + exhaustive — git is the only bound). When the
        // workspace's project_root is a git working tree, tracked files are
        // members without a client `add`; active members are materialized
        // (disk → body channel) so they appear in the catalog. No-ops
        // on headless / non-git workspaces. Runs BEFORE the derivation pump so
        // this turn's packet reflects them.
        // Workspace creation starts this eagerly. Joining here is the correctness
        // boundary: the model never runs against partial graph/vector coverage.
        await this.#warmWorkspace(systemCtx, false);
        // The warm materialized membership before deriving. This second pass is the
        // ordinary cheap change detector and captures any drift that landed meanwhile.
        const fsDivergences = await GitMembership.indexGitMembership(systemCtx);
        // {§packet-git-status} — one post-reconciliation snapshot supplies both
        // the compact packet summary and each causal file event's exact XY state.
        const gitStatus = await GitState.status(this.#db, workspaceId, this.#loopSignal(loopId));
        await this.#logFsFictions(workspaceId, fsDivergences, gitStatus);
        // The refresh above may have changed bodies (including model/client edits
        // since the startup warm). Re-derive to completion before packet/model
        // construction. Membership is already current, so this pass does not
        // consume the filesystem divergences a second time.
        await this.#warmWorkspace(systemCtx, true, false);

        // Turn-0 catalog preview (PLURNK_SERVICE_FILES_ITEMS, {§actor-boundary-catalog-preview}):
        // Six bodyless FIND surveys in the worker's packetless initialization turn establish the skills tree
        // (authored and Plurnk-generated families), attached tools tree, project, commons, and private
        // surfaces in that order.
        // Their `init` classification lets the model curate this opening survey as one log set.
        if (initializationTurn !== null) {
            // {§operator-config-workspace-files-items} — workspace filesItems replaces the env default.
            const { filesItems: workspaceMI } = await WorkspaceSettings.read(this.#db, workspaceId);
            const filesItems = workspaceMI !== null ? normalizeFilesItems(workspaceMI) : readFilesItems();
            if (filesItems !== null && workerFirstLoop) { // {§actor-boundary-catalog-preview} — once per worker
                const catalogSchemes = await this.#db.engine_scheme_catalog_summary.all<{ scheme: string; entries: number; shallow_items: number }>({ workspace_id: workspaceId });
                const fileItems = catalogSchemes.find(({ scheme }) => scheme === "file")?.shallow_items ?? 0;
                const fileCap = filesItems > 0 && fileItems > 0 ? Math.min(filesItems, fileItems) : null;
                // {§tools-resource-materialization} — PLURNK_MCP_EXPANDED servers
                // contribute one complete tool-tree survey each, directly after the
                // family survey, so turn 0 names every tool they expose in order.
                const registry = this.#executors();
                const toolExpansions: Array<{ statement: FindStatement }> = [];
                for (const tag of registry?.availableRuntimes(workspaceId) ?? []) {
                    const entry = registry?.entry(tag, workspaceId);
                    if (entry?.resourcesPath !== "/tools" || entry.expandTools !== true) continue;
                    toolExpansions.push({
                        statement: {
                            op: "FIND", delimiter: "", annotation: `enabled tools: ${tag}`, signal: ["+_plurnk", "+init", "+tools"],
                            target: { kind: "url", raw: `worker://plurnk/tools/${tag}/**`, scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: `/tools/${tag}/**`, query: null, fragment: null },
                            body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
                        },
                    });
                }
                const surveys: Array<{ statement: FindStatement }> = [
                    {
                        statement: {
                            op: "FIND", delimiter: "", annotation: null, signal: ["+_plurnk", "+init", "+skills"],
                            target: { kind: "url", raw: "worker://plurnk/skills/*.md", scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: "/skills/*.md", query: null, fragment: null },
                            body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
                        },
                    },
                    {
                        statement: {
                            op: "FIND", delimiter: "", annotation: null, signal: ["+_plurnk", "+init", "+skills"],
                            target: { kind: "url", raw: "worker://plurnk/skills/plurnk/*.md", scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: "/skills/plurnk/*.md", query: null, fragment: null },
                            body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
                        },
                    },
                    {
                        // {§tools-resource-materialization} — enabled tool families
                        // (MCP servers) survey at family level; each row's summary is
                        // the server one-liner or its flagship invocation form, so the
                        // discovery row itself orients. Servers named in
                        // PLURNK_MCP_EXPANDED add a second survey of their complete
                        // tool tree.
                        statement: {
                            op: "FIND", delimiter: "", annotation: "enabled tools", signal: ["+_plurnk", "+init", "+tools"],
                            target: { kind: "url", raw: "worker://plurnk/tools/*.md", scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: "/tools/*.md", query: null, fragment: null },
                            body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
                        },
                    },
                    ...toolExpansions,
                    {
                        statement: {
                            op: "FIND", delimiter: "", annotation: "workspace files", signal: ["+_plurnk", "+init"],
                            target: { kind: "local", raw: "*" },
                            body: null,
                            lineMarker: fileCap === null ? null : { marks: [1, fileCap] },
                            position: UNKNOWN_POSITION,
                        },
                    },
                    {
                        statement: {
                            op: "FIND", delimiter: "", annotation: "workspace entries", signal: ["+_plurnk", "+init"],
                            target: { kind: "url", raw: "worker:///*", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/*", query: null, fragment: null },
                            body: null, lineMarker: null, position: UNKNOWN_POSITION,
                        },
                    },
                    {
                        statement: {
                            op: "FIND", delimiter: "", annotation: "worker entries", signal: ["+_plurnk", "+init"],
                            target: { kind: "url", raw: "worker://~/*", scheme: "worker", username: null, password: null, hostname: "~", port: null, pathname: "/*", query: null, fragment: null },
                            body: null, lineMarker: null, position: UNKNOWN_POSITION,
                        },
                    },
                ];
                initializationStatements.push(...surveys.map(({ statement }) => statement));
            }
            const send: SendStatement = {
                op: "SEND", delimiter: "", annotation: null,
                signal: 102, target: null, lineMarker: null,
                body: { raw: "Next: Address the prompt.", json: null },
                position: UNKNOWN_POSITION,
            };
            initializationStatements.push(send);
            const source = TurnOps.renderInternal(initializationStatements);
            const admitted = TurnOps.parseInternal(source);
            const result = await this.#executeAdmittedTurn({
                statements: admitted,
                source,
                sourceFolded: false,
                origin: "_plurnk",
                workspaceId,
                workerId,
                loopId,
                turnId: initializationTurn.id,
                fromSequence: 1,
                failOnOperationError: true,
                signal: this.#loopSignal(loopId),
                onDispatch,
            });
            if (result.status !== TURN_STATUS_IMPLICIT_CONTINUE) {
                throw new Error(`initialization SEND returned ${result.status}; expected ${TURN_STATUS_IMPLICIT_CONTINUE}`);
            }
        }

        // Initialization is a complete preceding turn, not a set of rows
        // interleaved with the model boundary. The engine may now acquire the
        // inference turn inside the same warmed workspace cycle.
        if (modelTurn === null) {
            modelTurn = await Turn.open(this.#db, { loopId, producer: "model", kind: "inference" });
            createdTurnIds.push(modelTurn.id);
        }
        const seq = modelTurn.sequence;
        const turnId = modelTurn.id;
        systemCtx = systemContext(turnId);

        // Pre-model writes. Each prompt the model has not seen yet becomes a
        // `prompt` operation row whose target is its durable prompt:// entry.
        // Model operations continue the same turn sequence after these rows.
        let nextActionIndex = 1;
        const turnOpenPaths: string[] = [];
        if (turnNumber === 1 && loopRow?.prompt_published === 0) {
            const promptRow = loopRow; // {§prompt-entry} — one durable publication per loop
            if (promptRow !== undefined && typeof promptRow.prompt === "string" && promptRow.prompt.length > 0) {
                const openPaths = assertOpenPaths(JSON.parse(promptRow.open_paths) as unknown, `Loop ${loopId} open_paths`);
                const promptLoopSeq = promptRow.sequence;
                const promptPath = promptTarget(promptLoopSeq, 1);
                const entry: EntryData = {
                    channels: { body: { content: promptRow.prompt, mimetype: "text/markdown" } },
                    attributes: { openPaths },
                };
                await EntryCrud.writeEntry(promptPath.pathname, entry, systemCtx, "prompt", workerId);
                turnOpenPaths.push(...openPaths);
                const promptLogId = await this.#writePromptLog({
                    workerId,
                    loopId,
                    turnId,
                    sequence: nextActionIndex++,
                    target: promptPath,
                    content: promptRow.prompt,
                });
                onDispatch?.(promptLogId);
            }
        }

        // {§prompt-loop-containment}: the loop contains every prompt that arrived
        // while it ran. Publish each undelivered frame oldest-first exactly once.
        {
            const loopSeqRow = await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId });
            const loopSeq = loopSeqRow?.sequence ?? loopId;
            const prefix = promptLoopPrefix(loopSeq);
            const undelivered = (await this.#db.drain_undelivered_prompts_for_loop.all<{ content: string; pathname: string; attributes: string }>({
                owner_id: workerId,
                pattern: `${prefix}%`,
                prefix_len: prefix.length,
                loop_id: loopId,
            }))
                .filter((row) => typeof row.content === "string" && row.content.length > 0);
            for (const injectedRow of undelivered) {
                const attributes = parsePromptAttributes(injectedRow.attributes, `Prompt ${injectedRow.pathname} attributes`);
                if (attributes.openPaths !== undefined) {
                    turnOpenPaths.push(...assertOpenPaths(attributes.openPaths, `Prompt ${injectedRow.pathname} openPaths`));
                }
                const ordinal = Number(injectedRow.pathname.split("/").filter(Boolean).at(-1));
                const promptLogId = await this.#writePromptLog({
                    workerId,
                    loopId,
                    turnId,
                    sequence: nextActionIndex++,
                    target: promptTarget(loopSeq, ordinal),
                    content: injectedRow.content,
                });
                onDispatch?.(promptLogId);
            }
        }

        // {§methods-loop-run-open-paths}: selected workspace paths belong to
        // the prompt frame. Publish the frame, then dispatch ordinary core READs
        // in that same turn; missing/non-member paths retain their normal 4xx.
        for (const raw of turnOpenPaths) {
            const pathname = raw.startsWith("/") ? raw : `/${raw}`;
            const fileRead: ReadStatement = {
                op: "READ", delimiter: "", annotation: null, signal: null, lineMarker: null,
                target: {
                    kind: "url", raw: `file://${pathname}`, scheme: "file",
                    username: null, password: null, hostname: null, port: null,
                    pathname, query: null, fragment: null,
                },
                body: null, position: UNKNOWN_POSITION,
            };
            await this.#dispatch({
                statement: fileRead, workspaceId, workerId, loopId, turnId,
                sequence: nextActionIndex, origin: "_plurnk", onDispatch,
            });
            nextActionIndex++;
        }

        // {§env-delta-log-pull} — materialize ambient observations before packet
        // composition and reserve their action indices. {§exec-stream} owns the
        // distinct byte-cursor path for this worker's streams.
        // {§exec-poll} — EXEC `<0>` is turn-scoped: reap the worker's open turn-scoped streams (necessarily
        // from a prior turn — this runs before the turn's own spawns) so a `<0>` never survives into
        // the subsequent turn. The terminal output then surfaces born-OPEN via the stream-delta path.
        await this.#reapTurnScopedStreams(workerId);
        nextActionIndex += await this.#materializeEnvironmentDeltas({ workspaceId, workerId, loopId, turnId, fromSequence: nextActionIndex });
        nextActionIndex += await this.#materializeStreamDeltas({ workspaceId, workerId, loopId, turnId, fromSequence: nextActionIndex });

        // The post-reconciliation Git snapshot above is threaded into the packet
        // and every budget rebuild; overflow never shells again.
        // Notices are non-terminal observations, never operation-failure truth.
        // Drain once and thread the same set through every overflow rebuild.
        const notices = this.#notices.drain(loopId)
            .filter((event) => (event as { level?: string }).level !== "info") as Notice[];

        // Build the model request packet ({§packet-stored-shape}). The log build
        // queries log_entries scoped to the worker — the prompt entry just
        // written (if turn 1) is part of that query result.
        let promptProjection: "automatic" | "withheld" = "automatic";
        const buildPacket = (): Promise<Awaited<ReturnType<PacketBuilder["buildRequestPacket"]>>> =>
            this.#packets.buildRequestPacket({
                initialMessages: messages,
                requirements,
                workspaceId,
                workerId,
                loopId,
                currentTurnSeq: seq,
                provider,
                gitStatus,
                notices,
                transientOpenLogEntryId,
                promptProjection,
            });
        let requestPacket = await buildPacket();
        // {§overflow-turn} — measured overflow diverts this would-be model
        // turn into an ordinary packetless `_plurnk` operation batch. Every
        // visibility effect goes through Dispatcher FOLD; provider I/O is
        // structurally unreachable on this branch.
        const pressure = this.#packets.curationOverflow(requestPacket, provider);
        if (pressure !== null) {
            const folds = await OverflowTurn.plan(this.#db, loopId, turnId);
            await Turn.becomeOverflow(this.#db, turnId);
            const internalStatements: InternalTurnStatement[] = [
                OverflowTurn.planStatement(),
                ...folds.map(({ statement }) => statement),
                OverflowTurn.sendStatement(),
            ];
            const source = TurnOps.renderInternal(internalStatements);
            const admitted = TurnOps.parseInternal(source);
            const executed = await this.#executeAdmittedTurn({
                statements: admitted,
                source,
                sourceFolded: true,
                origin: "_plurnk",
                workspaceId,
                workerId,
                loopId,
                turnId,
                fromSequence: nextActionIndex,
                failOnOperationError: true,
                signal: this.#loopSignal(loopId),
                onDispatch,
            });
            if (executed.status !== TURN_STATUS_IMPLICIT_CONTINUE) {
                throw new Error(`overflow SEND returned ${executed.status}; expected ${TURN_STATUS_IMPLICIT_CONTINUE}`);
            }
            const rebuilt = await buildPacket();
            const remaining = this.#packets.curationOverflow(rebuilt, provider);
            const curationFailure = folds.length === 0 || remaining !== null
                ? curationOverflowFailure(remaining ?? pressure)
                : undefined;
            return {
                createdTurnIds,
                turnId,
                producer: "_plurnk",
                kind: "overflow",
                status: curationFailure?.status ?? TURN_STATUS_IMPLICIT_CONTINUE,
                outcomes: [],
                fingerprint: "",
                capacityHardStop: false,
                steerStruck: false,
                emissionAttempts: 0,
                emissionExhausted: false,
                ...(curationFailure === undefined ? {} : { curationFailure }),
            };
        }
        let modelMessages = PacketWire.packetToWireMessages(requestPacket) as ChatMessage[];
        // Curation pressure and provider generation are independent. The
        // provider owns its configured total output envelope.
        let response: ProviderAttempt | undefined;
        let splitResponse: SplitProviderResponse | undefined;
        let railGrammar: string | undefined;
        let railResponseGrammar: string | undefined;
        let railAllowWithheld = false;
        let railEvidence: GrammarEvidence | undefined;
        let emissionAttempts = 0;
        let providerCallInFlight = false;
        let modelCallSequence = 0;
        let currentEmissionAttempt = 0;
        let providerAttemptId: number | null = null;
        let providerModelCall: ModelCall | null = null;
        let providerAttemptAttributions: string[] = [];
        const providerSignal = this.#loopSignal(loopId) ?? signal;
        // {§client-metadata}
        const { client } = await WorkspaceSettings.read(this.#db, workspaceId);
        const loopSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId }))?.sequence ?? loopId;
        const providerIdentity = await this.#resolveWorkerProviderIdentity(workerId);
        const { workerId: providerWorkerId, primaryWorkerId } = providerIdentity;
        const classifyProviderAttempt = async (
            id: number,
            attemptSplit: SplitProviderResponse,
            emissionAttempt: number,
            accepted: boolean,
        ): Promise<void> => {
            const result = await this.#db.engine_classify_turn_attempt_response.run({
                id,
                accepted: accepted ? 1 : 0,
                parse_errors: JSON.stringify(attemptSplit.parseErrors),
            });
            if (result.changes !== 1) {
                throw new Error(`emission attempt ${id} was not awaiting classification`);
            }
            emissionAttempts = emissionAttempt;
        };
        const recoverCapacityPacket = async (): Promise<boolean> => {
            let baselineMessages = modelMessages;
            if (promptProjection === "automatic") {
                promptProjection = "withheld";
                const candidate = await buildPacket();
                const candidateMessages = PacketWire.packetToWireMessages(candidate) as ChatMessage[];
                if (JSON.stringify(candidateMessages) !== JSON.stringify(baselineMessages)) {
                    requestPacket = candidate;
                    modelMessages = candidateMessages;
                    return true;
                }
                baselineMessages = candidateMessages;
            }
            return false;
        };
        try {
            // {§turn-lifecycle}: bracket the complete provider-attempt window with liveness notices.
            if (!signal?.aborted) this.#notices.push(workspaceId, loopId, { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" });
            const railConstraint = await this.#grammarConstraint(provider);
            railGrammar = railConstraint?.transport;
            railResponseGrammar = railConstraint?.response;
            railAllowWithheld = railConstraint?.allowWithheld ?? false;
            const attemptLimit = readEmissionAttempts();
            const strikeStreak = this.#strikes.streak(loopId);
            for (let attempt = 1; attempt <= attemptLimit;) {
                // Capacity recovery may rebuild and resend the request without
                // consuming a grammar-emission attempt. Every logical provider
                // call still receives its own durable sequence and accounting.
                currentEmissionAttempt = attempt;
                modelCallSequence++;
                const attributionContext: PluginAttributionContext = Object.freeze({
                    workspaceId: String(workspaceId),
                    workerId: providerWorkerId,
                    primaryWorkerId,
                    loop: loopSeq,
                    turn: seq,
                    attempt: modelCallSequence,
                });
                providerAttemptAttributions = await this.#attemptAttributions(provider, attributionContext);
                requestPacket = { ...requestPacket, attributions: providerAttemptAttributions };
                providerModelCall = await ModelCall.open(this.#db, {
                    turnId,
                    sequence: modelCallSequence,
                    kind: "emission",
                    attributions: providerAttemptAttributions,
                    model: provider.model,
                });
                const attemptRow = await this.#db.engine_open_turn_attempt.get<{ id: number }>({
                    model_call_id: providerModelCall.id,
                });
                if (attemptRow === undefined) {
                    throw new Error(`Engine.runTurn: provider call ${modelCallSequence} did not open`);
                }
                providerAttemptId = attemptRow.id;
                providerCallInFlight = true;
                const currentModelCall = providerModelCall;
                let completedResponse: ProviderResponse;
                try {
                    completedResponse = await observed( // {§observability-boundary}
                        GEN_AI_REQUEST_SPAN,
                        { model: provider.model, attempt: modelCallSequence },
                        async (span) => {
                            try {
                                const generated = await provider.generate({
                                    messages: modelMessages,
                                    workerId: providerWorkerId,
                                    primaryWorkerId,
                                    signal: providerSignal,
                                    grammar: railGrammar,
                                    strikes: strikeStreak,
                                    attributions: providerAttemptAttributions.length > 0
                                        ? providerAttemptAttributions
                                        : undefined,
                                    client: client ?? undefined,
                                    workspaceId: String(workspaceId),
                                    loop: loopSeq,
                                    turn: seq,
                                    observeRequest: currentModelCall.observeRequest,
                                    callKind: "emission",
                                }); // {§provider-surface-generate} {§provider-guarantees-signal-wired} {§provider-guarantees-serial-attempts} {§attribution} {§client-metadata}
                                currentModelCall.assertAccounting(generated.accounting);
                                providerCallInFlight = false;
                                recordCounter(PROVIDER_CALLS, {
                                    model: provider.model,
                                    attempt: modelCallSequence,
                                    status: "resolved",
                                });
                                span.setAttribute("status", "resolved");
                                settleGenAiResponse(span, generated);
                                return generated;
                            } catch (error) {
                                if (error instanceof ProviderError) {
                                    currentModelCall.assertAccounting(error.accounting);
                                }
                                throw error;
                            }
                        },
                        genAiRequestOptions(
                            ProviderInstantiate.aliasOf(provider) ?? "plurnk",
                            provider.model,
                        ),
                    );
                } catch (error) {
                    if (!(error instanceof ProviderError)
                        || error.kind !== "capacity_exceeded"
                        || providerSignal?.aborted === true
                        || !await recoverCapacityPacket()) {
                        throw error;
                    }
                    const failure = TurnRunner.#providerFailure(error, providerSignal);
                    await currentModelCall.fail(failure, error.capacity ?? null);
                    providerCallInFlight = false;
                    await this.#problems.record({
                        workerId,
                        loopId,
                        turnId,
                        sequence: nextActionIndex++,
                        origin: "_plurnk",
                        source: "provider",
                        result: failure,
                    });
                    // Include the durable recovery signal in the replacement
                    // request while preserving the selected recovery posture.
                    requestPacket = await buildPacket();
                    modelMessages = PacketWire.packetToWireMessages(requestPacket) as ChatMessage[];
                    continue;
                }
                response = completedResponse;
                await currentModelCall.observeResponse(completedResponse);
                railEvidence = railGrammar === undefined
                    ? undefined
                    : TurnRunner.#requireGrammarEvidence(completedResponse, railAllowWithheld);
                splitResponse = this.#splitResponse(completedResponse);
                await classifyProviderAttempt(
                    attemptRow.id,
                    splitResponse,
                    attempt,
                    splitResponse.emissionValid,
                );
                if (splitResponse.emissionValid) break;
                attempt++;
            }
            if (!signal?.aborted) this.#notices.push(workspaceId, loopId, { source: "engine:turn", kind: "turn_generated", level: "info", message: "parsing model response" });
        } catch (err) {
            // This handler owns only provider-call failures. Parser, cost, SQL,
            // and engine-contract failures retain their original source.
            if (err instanceof ModelCallPersistenceError || err instanceof ProviderAccountingIntegrityError) throw err;
            if (!providerCallInFlight) throw err;
            providerCallInFlight = false;
            if (providerAttemptId === null || providerModelCall === null) {
                throw new Error("provider call failed without durable model-call and attempt identities", { cause: err });
            }
            const failure = TurnRunner.#providerFailure(err, providerSignal);
            const capacityFailure = err instanceof ProviderError && err.kind === "capacity_exceeded";
            // {§provider-interrupted-attempt} — a provider-declared interruption
            // carries response evidence without becoming a completed exchange.
            // Persist it as an unaccepted attempt before settling the failure.
            if (err instanceof ProviderError && err.attempt !== undefined) {
                response = err.attempt;
                await providerModelCall.observeResponse(response, failure);
                splitResponse = this.#splitResponse(response);
                await classifyProviderAttempt(
                    providerAttemptId,
                    splitResponse,
                    currentEmissionAttempt,
                    false,
                );
            } else {
                await providerModelCall.fail(
                    failure,
                    err instanceof ProviderError ? err.capacity ?? null : null,
                );
                if (!capacityFailure) emissionAttempts = currentEmissionAttempt;
            }
            // {§turn-never-blank} — a ProviderError means no completed exchange exists.
            // Persist its exact RFC 9457 result before propagating it. Grammar evidence
            // and its engine-owned verdict exist only on completed responses
            // ({§rail-truth-engine-verdict}). Cancellation is lifecycle truth, not a
            // provider failure. Close the
            // attempted turn without inventing an assistant response, then let
            // runLoop/Daemon settle the exact 504/499 loop result.
            if (providerSignal?.aborted) {
                const status = providerSignal.reason === LOOP_TIMEOUT_REASON ? 504 : 499;
                await Turn.recordInference(this.#db, turnId, {
                    packet: StoredPacket.stringify(requestPacket),
                    usageCurationBudget: this.#packets.curationBudgetFor(provider),
                    finishReason: splitResponse?.callMetadata.finishReason ?? null,
                    model: splitResponse?.callMetadata.model ?? provider.model,
                    meta: JSON.stringify(response?.meta ?? {}),
                });
                await Turn.complete(this.#db, turnId, status);
                throw err;
            }
            const recorded = await this.#problems.record({
                workerId,
                loopId,
                turnId,
                sequence: nextActionIndex,
                origin: "_plurnk",
                source: "provider",
                result: failure,
            });
            // The provider call was attempted, but no completed exchange exists.
            // Persist the exact request half and failure status; omitting assistant
            // is materially different from fabricating an empty model turn.
            await Turn.recordInference(this.#db, turnId, {
                packet: StoredPacket.stringify(requestPacket),
                usageCurationBudget: this.#packets.curationBudgetFor(provider),
                finishReason: splitResponse?.callMetadata.finishReason ?? null,
                model: splitResponse?.callMetadata.model ?? provider.model,
                meta: JSON.stringify(response?.meta ?? {}),
            });
            await Turn.complete(this.#db, turnId, recorded.result.status);
            if (capacityFailure) {
                return {
                    createdTurnIds,
                    turnId,
                    producer: "model",
                    kind: "inference",
                    status: recorded.result.status,
                    outcomes: [],
                    fingerprint: "",
                    capacityHardStop: true,
                    capacityFailure: recorded.result,
                    steerStruck: false,
                    emissionAttempts,
                    emissionExhausted: false,
                };
            }
            throw new OperationFailureError(recorded.result, { cause: err });
        }

        if (response === undefined || splitResponse === undefined || providerModelCall === null) {
            throw new Error("provider attempt loop completed without a response");
        }
        const emissionModelCallId = providerModelCall.id;
        if (!splitResponse.emissionValid) {
            // {§invalid-emission-attempts} The first consecutive exhaustion
            // publishes only the raw final response and generic recovery fact.
            let rejectedModelEntryId: number | undefined;
            if (allowInvalidEmissionRecovery) {
                rejectedModelEntryId = await this.#dispatcher.writeEmissionAttempt({
                    verbatim: splitResponse.packetAssistant.content,
                    workerId,
                    loopId,
                    turnId,
                    sequence: nextActionIndex,
                    modelCallId: emissionModelCallId,
                    ...(response.assistant.reasoningEncrypted?.length
                        ? { reasoningItems: response.assistant.reasoningEncrypted }
                        : {}),
                });
                this.#notices.push(workspaceId, loopId, {
                    source: "engine:grammar",
                    kind: "invalid_emission",
                    level: "error",
                    message: INVALID_EMISSION_RECOVERY_MESSAGE,
                });
            }
            const status = allowInvalidEmissionRecovery ? TURN_STATUS_IMPLICIT_CONTINUE : 500;
            await Turn.recordInference(this.#db, turnId, {
                packet: StoredPacket.stringify(requestPacket),
                usageCurationBudget: this.#packets.curationBudgetFor(provider),
                finishReason: splitResponse.callMetadata.finishReason,
                model: splitResponse.callMetadata.model,
                meta: JSON.stringify(response.meta ?? {}),
            });
            await Turn.complete(this.#db, turnId, status);
            return {
                createdTurnIds,
                turnId,
                producer: "model",
                kind: "inference",
                status: allowInvalidEmissionRecovery ? TURN_STATUS_IMPLICIT_CONTINUE : 500,
                outcomes: [],
                fingerprint: "",
                capacityHardStop: false,
                steerStruck: false,
                emissionAttempts,
                emissionExhausted: true,
                ...(rejectedModelEntryId === undefined ? {} : { rejectedModelEntryId }),
            };
        }

        // {§packet-stored-shape} — admitted emission data extends the packet;
        // provider-call metadata remains on the Turn row.
        const {
            packetAssistant,
            callMetadata,
            parseNotices,
            recoverableParseErrors,
        } = splitResponse; // raw assistant content is opaque — split, never interpreted — {§provider-guarantees-assistantraw-opaque}
        for (const notice of parseNotices) {
            this.#notices.push(workspaceId, loopId, notice);
        }

        // Non-fatal provider transport notices on an accepted turn. Forward each
        // Notice with a content-offset `line:col`;
        // the model resolves it against its own emission — READ the folded turnOps row at the
        // cited lines ({§turn-ops-entry}) — not an embedded snippet that would duplicate the emission.
        for (const notice of response.notices ?? []) {
            const located = typeof notice.position === "number"
                ? this.#offsetToLineColumn(packetAssistant.content, notice.position)
                : null;
            this.#notices.push(workspaceId, loopId, {
                source: notice.source,
                kind: notice.kind,
                message: notice.message ?? "",
                level: notice.level,
                ...(located !== null
                    ? { position: { type: "content-offset", line: located.line, column: located.column } }
                    : {}),
            });
        }
        // Grade configured local evidence independently. Endpoint-owned
        // constraints remain provider observations. {§rail-truth-engine-verdict}
        let railKeys: { railsAttached: "client" | "withheld"; railsVerdict: string } | undefined;
        if (railGrammar !== undefined) {
            if (railEvidence === undefined) throw new Error("configured GBNF response has no final grammar evidence");
            if (railResponseGrammar === undefined) throw new Error("configured GBNF has no response grammar");
            let verdict: ReturnType<typeof validateGbnf> | null = null;
            try { verdict = validateGbnf(railResponseGrammar, railEvidence.input); }
            catch (cause) { TurnRunner.#warnRailVerdictGapOnce((cause as Error).message); }
            railKeys = {
                railsAttached: railEvidence.transported ? "client" : "withheld",
                railsVerdict: verdict?.status ?? "unverifiable",
            };
            if (verdict !== null && verdict.status !== "accept") {
                const contentPosition = verdict.pos >= railEvidence.contentStart
                    ? verdict.pos - railEvidence.contentStart
                    : null;
                const located = contentPosition === null
                    ? null
                    : this.#offsetToLineColumn(packetAssistant.content, contentPosition);
                this.#notices.push(workspaceId, loopId, {
                    source: "engine:rails",
                    kind: "grammar_unenforced",
                    message: verdict.status === "reject"
                        ? `emission rejects the grammar at raw code point ${verdict.pos}`
                        : `emission is an incomplete grammar sentence (ends at raw code point ${verdict.pos})`,
                    level: "warn",
                    ...(located === null
                        ? {}
                        : { position: { type: "content-offset" as const, line: located.line, column: located.column } }),
                });
            }
        }
        // Attach the admitted inference evidence. The turn remains open until
        // the producer-neutral admitted-turn executor settles every operation
        // and its exact source artifact.
        const packet = StoredPacket.admit(requestPacket, packetAssistant, response.assistantRaw);
        await Turn.recordInference(this.#db, turnId, {
            packet: StoredPacket.stringify(packet),
            usageCurationBudget: this.#packets.curationBudgetFor(provider), // {§tokenomics-client-gauge}
            finishReason: callMetadata.finishReason,
            model: callMetadata.model,
            // Opaque provider metadata plus engine-authored rail keys.
            // {§meta-passthrough}, {§rail-truth-engine-verdict}
            meta: JSON.stringify({ ...(response.meta ?? {}), ...(railKeys ?? {}) }),
        });

        // {§operator-config-workspace-max-commands} — workspace maxCommands
        // narrows the operator ceiling before the admitted program reaches the
        // shared executor.
        const maxCommands = Math.min(readMaxCommands(), (await WorkspaceSettings.read(this.#db, workspaceId)).maxCommands ?? Number.POSITIVE_INFINITY);
        const reasoningItems = response.assistant.reasoningEncrypted?.length
            ? response.assistant.reasoningEncrypted
            : undefined;
        const executed = await this.#executeAdmittedTurn({
            statements: packetAssistant.ops,
            source: splitResponse.sourceBacked ? packetAssistant.content : null,
            sourceFolded: true,
            sourceModelCallId: emissionModelCallId,
            ...(reasoningItems !== undefined ? { sourceReasoningItems: reasoningItems } : {}),
            origin: "model",
            workspaceId,
            workerId,
            loopId,
            turnId,
            fromSequence: nextActionIndex,
            maxCommands,
            enforceIdle: true,
            recoverableParseErrors,
            bare: {
                provider: childProvider,
                modelCallSequenceStart: modelCallSequence + 1,
                primaryWorkerId,
                loopSequence: loopSeq,
                turnSequence: seq,
                signal: providerSignal,
            },
            signal: providerSignal,
            onDispatch,
        });
        return {
            createdTurnIds,
            turnId,
            producer: "model",
            kind: "inference",
            status: executed.status,
            outcomes: executed.outcomes,
            fingerprint: executed.fingerprint,
            capacityHardStop: false,
            steerStruck: executed.steerStruck,
            emissionAttempts,
            emissionExhausted: false,
        };
        } catch (cause) {
            const completionFailures: unknown[] = [];
            for (const createdTurnId of createdTurnIds) {
                try {
                    await Turn.failOpen(this.#db, createdTurnId);
                } catch (completionCause) {
                    completionFailures.push(completionCause);
                }
            }
            if (completionFailures.length > 0) {
                throw new AggregateError(
                    [cause, ...completionFailures],
                    "turn execution failed and its open turn containers could not all be completed",
                );
            }
            throw cause;
        }
    }

    // Split the wire-level ProviderResponse into the two destinations:
    // packet.assistant gets the model's emission (content, ops, reasoning);
    // Turn columns get accepted-call metadata (finishReason, model). Physical
    // request usage and cost have their own cardinal persistence path.
    // {§provider-surface} Text-fragment scraping policy lives
    // here — engine owns the parse and the scraping rule, providers stay
    // grammar-unaware.
    //
    // Test-fixture escape hatch: the Mock provider may pre-supply `ops` on
    // its assistant payload to skip the parse roundtrip. The wire Provider
    // contract has no `ops` field; only Mock exposes one. Real providers
    // always take the parse path because their `assistant.ops` is undefined.
    #splitResponse(response: ProviderAttempt): SplitProviderResponse {
        const { assistant } = response;
        const preParsedOps = (assistant as { ops?: PlurnkStatement[] }).ops;
        const ops: PlurnkStatement[] = [];
        // PLAN is an ordinary op — emitted by the model, dispatched, and passed to the
        // client as a log entry. No special hoisting into the reasoning field. Only
        // structured operations are executable; interstitial text is not an operation.
        // Full PlurnkParseError context is preserved on rejected attempt evidence;
        // warnings remain admissible Notices. {§parse-diagnostics}
        const parseErrors: ParseErrorInfo[] = [];
        let hasUnparsedTail = false;
        const parseNotices: Notice[] = [];
        if (preParsedOps !== undefined) {
            ops.push(...preParsedOps);
        } else {
            // {§observability-boundary} — the parse is observed without its input;
            // only the resulting statement count is attributable.
            const parsed = observedSync("contracts.parse", {}, (span) => {
                const result = PlurnkParser.parse(assistant.content);
                span.setAttribute("statements", result.items.filter((item) => item.kind === "statement").length);
                return result;
            });
            for (const item of parsed.items) {
                if (item.kind === "statement") {
                    ops.push(item.statement);
                }
                else if (item.kind === "error") {
                    const err = (item as { error?: PlurnkParseError }).error;
                    if (err instanceof PlurnkParseError) {
                        if (err.severity === "warning") {
                            parseNotices.push({
                                source: "grammar",
                                kind: "parse_advisory",
                                level: "warn",
                                message: err.message,
                                position: {
                                    type: "content-offset",
                                    line: err.line,
                                    column: err.column,
                                },
                                parserSource: err.source,
                            });
                        } else {
                            parseErrors.push({ message: err.message, line: err.line, column: err.column, source: err.source });
                        }
                    } else {
                        const msg = (err as { message?: string } | undefined)?.message ?? "parse error";
                        parseErrors.push({ message: msg, line: 0, column: 0, source: "parser" });
                    }
                }
            }
            // Boundary loss is the parser's one public fact from `unparsedTail.from` onward;
            // preserve it with the rejected forensic attempt. {§unparsed-tail-boundary}
            const tail = parsed.unparsedTail;
            if (tail !== undefined) {
                hasUnparsedTail = true;
                parseErrors.push({ message: tail.reason, line: tail.from.line, column: tail.from.column, source: "grammar" });
            }
        }
        const plan = ops[0]?.op === "PLAN" ? ops[0] : undefined;
        const finalOp = ops.at(-1);
        const terminalSend = finalOp?.op === "SEND"
            && typeof finalOp.signal === "number"
            && TERMINAL_SEND_SIGNALS.has(finalOp.signal)
            ? finalOp
            : undefined;
        const recoverableParseErrors = plan !== undefined && terminalSend !== undefined && !hasUnparsedTail
            ? parseErrors.filter(
                (error) =>
                    comparePosition(error, plan.position) > 0
                    && comparePosition(error, terminalSend.position) < 0,
            ).toSorted(comparePosition)
            : [];
        const emissionValid = preParsedOps !== undefined
            || (
                plan !== undefined
                && terminalSend !== undefined
                && !hasUnparsedTail
                && recoverableParseErrors.length === parseErrors.length
            );
        const reasoning = assistant.reasoning ?? null;
        return {
            packetAssistant: { content: assistant.content, ops, reasoning },
            sourceBacked: preParsedOps === undefined,
            callMetadata: { finishReason: assistant.finishReason, model: assistant.model },
            parseErrors,
            recoverableParseErrors: emissionValid ? recoverableParseErrors : [],
            parseNotices,
            // The ANTLR model-turn parser is authoritative. A trustworthy
            // PLAN...SEND frame admits bounded interior statement failures so
            // they become durable operation results. Missing boundaries,
            // errors outside the frame, and an unparsed tail reject wholesale.
            // Pre-parsed ops are Mock's trusted test seam.
            emissionValid,
        };
    }

    // #note12 — plugin reference docs are materialized beneath
    // worker://plurnk/skills/plurnk/ by LoopDocs.

    async #materializeEnvironmentDeltas(args: {
        workspaceId: number; workerId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number> {
        const { workspaceId, workerId, loopId, turnId, fromSequence } = args;
        const rows = await this.#db.engine_pull_ambient_events.all<{
            cursor: number;
            boundary: number;
            event_id: number | null;
            producer_worker_id: number | null;
            producer_worker_name: string | null;
            kind: "edit" | "loop_termination" | null;
            source: string | null;
            op: "EDIT" | "SEND" | null;
            scheme: string | null;
            hostname: string | null;
            pathname: string | null;
            rx: string | null;
            attrs: string | null;
            tags: string | null;
            status_rx: number | null;
            terminated_by: string | null;
        }>({ workspace_id: workspaceId, worker_id: workerId });
        const window = rows[0];
        if (window === undefined) throw new Error(`ambient pull: worker ${workerId} has no observation window`);
        let written = 0;
        for (const r of rows) {
            if (r.event_id === null || r.producer_worker_id === null || r.producer_worker_name === null || r.kind === null
                || r.op === null || r.status_rx === null) continue;
            const termination = r.kind === "loop_termination";
            if (r.rx === null) throw new Error(`ambient event ${r.event_id} has no materializable result`);
            const terminal = termination
                ? TerminalResult.parse(r.rx, `ambient loop-termination event ${r.event_id}`)
                : null;
            if (terminal !== null && terminal.status !== r.status_rx) {
                throw new Error(`ambient loop-termination event ${r.event_id} status ${r.status_rx} does not match its terminal result status ${terminal.status}`);
            }
            let attrs = r.attrs ?? "{}";
            const parsedTags = JSON.parse(r.tags ?? "[]") as unknown;
            if (!Array.isArray(parsedTags) || !parsedTags.every((tag) => typeof tag === "string" && tag.length > 0)) {
                throw new TypeError(`ambient event ${r.event_id} tags must be an array of nonempty strings`);
            }
            const tags = [...new Set(parsedTags)].toSorted();
            if (tags.length !== parsedTags.length || tags.some((tag, index) => tag !== parsedTags[index])) {
                throw new TypeError(`ambient event ${r.event_id} tags must be unique and sorted`);
            }
            if (terminal !== null) {
                const inherited = JSON.parse(attrs) as unknown;
                if (inherited === null || typeof inherited !== "object" || Array.isArray(inherited)) {
                    throw new TypeError(`ambient loop-termination event ${r.event_id} attrs must be an object`);
                }
                const receipt = await BranchReceipt.render(this.#db, r.producer_worker_id);
                attrs = JSON.stringify({
                    ...inherited,
                    kind: "loop_termination",
                    ...(r.terminated_by === null ? {} : { terminatedBy: r.terminated_by }),
                    ...(receipt === null ? {} : { receipt }),
                });
            }
            const inserted = await this.#db.engine_insert_ambient_delta.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: fromSequence + written,
                event_id: r.event_id,
                source: r.source ?? WorkerControlAddress.render(r.producer_worker_name),
                op: r.op,
                scheme: r.scheme,
                hostname: r.hostname,
                pathname: r.pathname,
                rx: r.rx,
                mimetype_rx: "application/json",
                status: r.status_rx,
                weight: LogBody.weight({
                    op: r.op,
                    attrs,
                    tx: "",
                    rx: r.rx,
                    mimetypeTx: "text/plain",
                    mimetypeRx: "application/json",
                }, this.#weighContent),
                folded: LogVisibility.serialize(
                    terminal !== null && terminal.status >= 200 && terminal.status < 300
                        ? LogVisibility.OPEN
                        : LogVisibility.FOLDED,
                ),
                attrs,
            });
            const materialized = inserted ?? await this.#db.engine_ambient_delta_id.get<{ id: number }>({
                worker_id: workerId,
                event_id: r.event_id,
            });
            if (materialized === undefined) throw new Error(`ambient event ${r.event_id} has no observer log row after materialization`);
            for (const tag of tags) {
                await this.#db.log_write_tag.run({ log_entry_id: materialized.id, tag });
            }
            if (inserted !== undefined) written++;
        }
        await this.#db.engine_advance_ambient_cursor.get({
            workspace_id: workspaceId,
            worker_id: workerId,
            cursor: window.cursor,
            boundary: window.boundary,
        });
        return written;
    }

    // {§exec-poll} — EXEC `<0>` is turn-scoped: abort the worker's open turn-scoped streams via their
    // owning scheme (the same registry-routed abort the total reap uses). Called at each pre-turn
    // before the turn's own spawns, so every open turn-scoped sub here is from a prior turn — it
    // never survives into the subsequent turn. Fire-and-forget: the spawn finalizes async and its
    // terminal output surfaces born-OPEN through the stream-delta path ({§exec-stream}).
    async #reapTurnScopedStreams(workerId: number): Promise<void> {
        const open = await this.#db.find_open_turn_scoped_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        await Promise.all(open.map(({ id }) => this.#liveSubscriptions.cancel(id)));
    }


    async #materializeStreamDeltas(args: {
        workspaceId: number; workerId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number> {
        const { workspaceId, workerId, loopId, turnId, fromSequence } = args;
        const channels = await this.#db.engine_worker_stream_channels.all<{
            subscription_id: number; runtime: string; coord: string; channel: string; content: string;
            mimetype: string; state: string; close_status: number | null; close_result: string | null; published_channel: string | null;
        }>({ worker_id: workerId });
        let written = 0;
        for (const ch of channels) {
            // Default channels are an implementation detail. Preserve the
            // channel internally on the entry/subscription, but present the
            // ordinary address to the model; only an explicitly non-default
            // channel earns a fragment in the log.
            const visibleFragment = ch.published_channel !== null
                && ch.channel === this.#schemes.defaultChannelFor(ch.runtime, workspaceId)
                ? null
                : ch.channel;
            const prior = await this.#db.engine_stream_cursor.get<{ attrs: string }>({
                worker_id: workerId, scheme: ch.runtime, pathname: ch.coord, fragment: visibleFragment,
            });
            const priorAttrs = prior !== undefined ? (JSON.parse(prior.attrs) as { streamEnd?: number; terminal?: boolean }) : {};
            const cursor = priorAttrs.streamEnd ?? 0;
            const closed = ch.state === "closed" || ch.state === "errored";
            const terminal = closed
                ? Results.assert(JSON.parse(ch.close_result ?? "null") as SchemeResult)
                : null;
            const terminalResult = async (fields: Readonly<Record<string, unknown>>, sequence: number): Promise<SchemeResult> => {
                if (terminal === null) throw new Error(`closed subscription ${ch.subscription_id} has no terminal result`);
                const result = Results.assert({
                    ...terminal,
                    ...(terminal.problem === undefined ? {} : { problem: { ...terminal.problem } }),
                    ...fields,
                });
                if (result.problem !== undefined) {
                    const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                        loop_id: loopId,
                        turn_id: turnId,
                    });
                    if (seqs === undefined) throw new Error(`stream delta has no log coordinate for loop=${loopId} turn=${turnId}`);
                    Results.attachInstance(result, `log:///${seqs.loop_seq}/${seqs.turn_seq}/${sequence}/READ`);
                }
                return result;
            };
            const publishEnd = streamPublicationEnd(ch.content, ch.mimetype, cursor, closed);
            if (publishEnd <= cursor) {
                // The cursor-terminal race: a channel written in one final
                // burst gets fully shown FOLDED while still active; the close then has zero new
                // content and the auto-OPEN terminal observation never fired — the model was never shown
                // the conclusion of a stream whose result it already holds folded. The same
                // observation is required when the channel produced no publishable content:
                // completion is information independently of payload. A text stream that delivered
                // content retains its terse revisit marker; an empty text stream and every structured
                // channel emit a bodyless typed conclusion.
                if (closed && priorAttrs.terminal !== true) {
                    const streamTarget = renderTarget({
                        scheme: ch.runtime,
                        pathname: ch.coord,
                        fragment: visibleFragment,
                    });
                    if (streamTarget === null) throw new Error(`stream ${ch.subscription_id} has no renderable address`);
                    const sequence = fromSequence + written;
                    const content = cursor > 0 && baseMimetype(ch.mimetype).startsWith("text/")
                        ? `[ stream closed (${ch.close_status ?? 200}) - full output already delivered above; READ ${streamTarget} to revisit ]`
                        : "";
                    const rx = JSON.stringify(await terminalResult({
                        content,
                        mimetype: ch.mimetype,
                    }, sequence));
                    await this.#db.engine_insert_stream_delta.run({
                        worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                        scheme: ch.runtime, pathname: ch.coord, fragment: visibleFragment,
                        rx,
                        weight: LogBody.weight({
                            op: "READ",
                            attrs: {},
                            tx: "",
                            rx,
                            mimetypeTx: "text/plain",
                            mimetypeRx: "application/json",
                        }, this.#weighContent),
                        status: terminal?.status ?? 200,
                        attrs: JSON.stringify({ streamEnd: ch.content.length, terminal: true }),
                        folded: LogVisibility.serialize(LogVisibility.OPEN),
                    });
                    written++;
                }
                continue;
            }
            // startLine continues the line count across turns: a multi-turn stream's deltas number
            // into one sequence (lines N..M, then M+1..), not N independent "1:" restarts. {§exec-stream}
            const startLine = (ch.content.slice(0, cursor).match(/\n/g)?.length ?? 0) + 1;
            const sequence = fromSequence + written;
            const content = ch.content.slice(cursor, publishEnd);
            const terminalDelivery = closed && publishEnd === ch.content.length;
            const fields = { content, mimetype: ch.mimetype, startLine };
            const result = terminalDelivery
                ? await terminalResult(fields, sequence)
                : { status: 200, ...fields };
            const rx = JSON.stringify(result);
            await this.#db.engine_insert_stream_delta.run({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                scheme: ch.runtime, pathname: ch.coord, fragment: visibleFragment,
                rx,
                weight: LogBody.weight({
                    op: "READ",
                    attrs: {},
                    tx: "",
                    rx,
                    mimetypeTx: "text/plain",
                    mimetypeRx: "application/json",
                }, this.#weighContent),
                status: result.status,
                attrs: JSON.stringify({ streamEnd: publishEnd, terminal: terminalDelivery }),
                folded: LogVisibility.serialize(
                    terminalDelivery ? LogVisibility.OPEN : LogVisibility.FOLDED,
                ), // {§exec-stream} — terminal observation auto-OPENs; ongoing folds
            });
            written++;
        }
        return written;
    }

    // {§env-delta-filesystem-narration} {§membership-emi-divergence-signal}
    // — record project-file divergence once through the reserved actor.
    async #logFsFictions(
        workspaceId: number,
        divergences: FsDivergence[],
        gitStatus: GitStatusSnapshot | null,
    ): Promise<void> {
        if (divergences.length === 0) return;
        const gitByPath = new Map(gitStatus?.files.map(({ path, status }) => [path, status] as const) ?? []);
        const worker = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" })
            ?? await this.#db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "_plurnk" });
        if (worker === undefined) throw new Error("logFsFictions: plurnk worker resolution returned no row");
        const loop = await this.#db.envelope_insert_client_loop.get<{ id: number }>({ worker_id: worker.id });
        if (loop === undefined) throw new Error("logFsFictions: loop insert returned no row");
        const turn = await Turn.open(this.#db, { loopId: loop.id, producer: "_plurnk", kind: "operation" });
        let turnOpen = true;
        try {
            let sequence = 1;
            for (const d of divergences) {
                const span = editedSpan(d.before, d.after);
                const rx = JSON.stringify({ status: 200, entryId: d.entryId, channel: d.channel, span });
                const attrs = gitByPath.has(d.pathname)
                    ? JSON.stringify({ git: gitByPath.get(d.pathname) })
                    : "{}";
                await this.#db.engine_insert_log_entry.get({
                    worker_id: worker.id, loop_id: loop.id, turn_id: turn.id, sequence: sequence++,
                    origin: "_plurnk", source: "file", model_call_id: null,
                    op: "EDIT", delimiter: "", signal: null,
                    // Match Dispatcher.#extractTarget: a bare file address has NULL scheme
                    // only in log target metadata; its entry identity remains `file`.
                    scheme: null, username: null, password: null, hostname: null, port: null,
                    pathname: d.pathname, query: null, fragment: null, lineMarker: null,
                    tx: "", mimetype_tx: "text/plain",
                    rx, mimetype_rx: "application/json",
                    status_rx: 200,
                    weight: LogBody.weight({
                        op: "EDIT",
                        attrs,
                        tx: "",
                        rx,
                        mimetypeTx: "text/plain",
                        mimetypeRx: "application/json",
                    }, this.#weighContent),
                    state: "resolved", outcome: null,
                    attrs,
                });
            }
            await Turn.complete(this.#db, turn.id, 200);
            turnOpen = false;
            const closed = await new LoopLifecycle(this.#db).finish(loop.id, { status: 200 });
            if (closed === null) throw new Error(`logFsFictions: narration loop ${loop.id} was not open at completion`);
        } catch (cause) {
            const settlementFailures: unknown[] = [];
            const failure = Results.failure(
                "engine:filesystem-narration",
                "narration-failed",
                500,
                "Filesystem divergence narration failed before its operation turn settled.",
                {},
                { stage: "filesystem-narration", retryable: false },
            );
            if (turnOpen) {
                try { await Turn.complete(this.#db, turn.id, failure.status); }
                catch (turnCause) { settlementFailures.push(turnCause); }
            }
            try { await new LoopLifecycle(this.#db).finish(loop.id, failure); }
            catch (loopCause) { settlementFailures.push(loopCause); }
            if (settlementFailures.length > 0) {
                throw new AggregateError([cause, ...settlementFailures], `filesystem narration ${turn.id} failed to settle`);
            }
            throw cause;
        }
    }


    async #writePromptLog({
        workerId,
        loopId,
        turnId,
        sequence,
        target,
        content,
    }: {
        workerId: number;
        loopId: number;
        turnId: number;
        sequence: number;
        target: UrlPath;
        content: string;
    }): Promise<number> {
        const rx = JSON.stringify({ content, mimetype: "text/markdown" });
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence,
            origin: "_plurnk",
            source: null,
            model_call_id: null,
            op: "prompt",
            delimiter: "",
            signal: null,
            scheme: target.scheme,
            username: target.username,
            password: target.password,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            query: target.query,
            fragment: target.fragment,
            lineMarker: null,
            tx: "",
            mimetype_tx: "text/plain",
            rx,
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: LogBody.weight({
                op: "prompt",
                attrs: {},
                tx: "",
                rx,
                mimetypeTx: "text/plain",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "resolved",
            outcome: null,
            attrs: "{}",
        });
        if (row === undefined) throw new Error("TurnRunner.#writePromptLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // External API to feed a resolution into a pending proposal — the client-interface
    // seam, core-owned disposition, or the timeout watcher.
    // {§worker-lifecycle-total-reap}: release every stopped-world waiter before joining drains.
}
