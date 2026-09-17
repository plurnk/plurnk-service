import { TurnDisposition } from "@plurnk/plurnk-contracts";
import type { RequestPacket } from "./StoredPacket.ts";
import NativeContent from "./NativeContent.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { PathSyntax, PlurnkParseError, UNKNOWN_POSITION } from "@plurnk/plurnk-contracts";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderErrorKind, ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { aggregateProviderAccounting } from "@plurnk/plurnk-providers";
import type { CapabilityPolicy, Notice } from "@plurnk/plurnk-contracts";
import type { BareStatement, PlurnkStatement, ReadStatement, UrlPath, FindStatement } from "@plurnk/plurnk-contracts";

// Internal-only — collected from PlurnkParser output, then translated to
// Notice envelopes are defined by @plurnk/plurnk-contracts.
// before being pushed to the loop's notices buffer.
export type ParseErrorInfo = Pick<PlurnkParseError, "message" | "line" | "column" | "code"> & { source: string };
const comparePosition = (
    a: { line: number; column: number },
    b: { line: number; column: number },
): number => a.line - b.line || a.column - b.column;
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Meta, { type PluginAttributionContext } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import GitMembership from "./git-membership.ts";
import { acceptedKinds } from "./attachments.ts";
import GitState, { type GitStatusSnapshot } from "./git-state.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { StreamEventNotify, WakeWorkerNotify } from "./ChannelWrite.ts";
import type { ReasoningEventNotify } from "./ReasoningEvent.ts";
import type { LoopPacketNotify } from "./LoopPacket.ts";
import { generatedPathname } from "./plurnk-uri.ts";
import LiveSubscriptions from "./LiveSubscriptions.ts";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
// {§operator-grammar} — an operator's own GBNF is a file path: absolute, `~`-relative, or
// relative to the daemon's working directory. The service ships no grammar profile, so a bare
// name (no separator) is refused by name rather than resolved against anything.
export const resolveOperatorGrammarPath = (value: string): string => {
    if (value === "~" || value.startsWith("~/")) return resolvePath(homedir(), value.slice(2));
    if (value.startsWith("/") || value.startsWith(".") || value.includes("/")) return resolvePath(value);
    throw new Error(`PLURNK_PROVIDERS_GBNF=${value} names a bundled grammar profile; the service ships none (#588). Give the path of a grammar file you wrote.`);
};
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";
import ReasoningView from "./ReasoningView.ts";
import Results, { OperationFailureError, type SchemeResult } from "./results.ts";
import Turn, { type InferenceEvidence, type TurnRow } from "./Turn.ts";
import type ClientInteractions from "./ClientInteractions.ts";

// TurnRunner owns one inference cycle and any initialization turn
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
import { GEN_AI_REQUEST_SPAN, genAiRequestOptions, settleGenAiResponse } from "../observe/genai.ts";
import { PROVIDER_CALLS, recordCounter } from "../observe/metrics.ts";
import ModelCall, { ModelCallPersistenceError, ProviderAccountingIntegrityError } from "./ModelCall.ts";
import WorkerName from "./WorkerName.ts";
import TurnOps, { type InternalTurnStatement } from "./TurnOps.ts";
import CapabilityPolicies from "./CapabilityPolicies.ts";
import CapabilityResolver from "./CapabilityResolver.ts";

export type EngineProblemKind = keyof typeof ENGINE_PROBLEMS;

const regexLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const workerCatalogTarget = (
    namespace: "plurnk" | "tools",
): UrlPath => {
    const pathname = generatedPathname(`/${namespace}/*.md`);
    return {
        kind: "url",
        raw: `worker://${pathname}`,
        scheme: "worker",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    };
};

const assertOpenPaths = (value: unknown, source: string): string[] => {
    if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || path.length === 0)) {
        throw new TypeError(`${source}: expected an array of non-empty strings`);
    }
    return value as string[];
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
import type { GrammarEvidence, Provider, ProviderAttempt, ProviderAttemptFinishReason, ProviderResponse } from "@plurnk/plurnk-providers";
import { ProviderError, scopeEnvToAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import TurnMaterialization from "./TurnMaterialization.ts";
import BareBatchRunner from "./BareBatchRunner.ts";
import { ENGINE_PROBLEMS, TURN_STATUS_IMPLICIT_CONTINUE } from "./turn-signals.ts";
import AdmittedTurnExecutor from "./AdmittedTurnExecutor.ts";

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
    emptyTurn: boolean;
};

type MaterializedModelRequest = {
    readonly messages: ChatMessage[];
    readonly nativeInputs: readonly string[];
};

type EngineTurnResult = {
    createdTurnIds: number[];
    turnId: number;
    status: number;
    outcomes: StrikeOutcome[];
    fingerprint: string;
    capacityHardStop: boolean;
    // {§provider-recovery} — the recovery budget is spent: the loop parks instead of failing.
    providerParked: boolean;
    providerFailure?: SchemeResult;
    emptyTurn: boolean;
    emissionAttempts: number;
    emissionExhausted: boolean;
    rejectedModelEntryId?: number;
    capacityFailure?: SchemeResult;
    curationFailure?: SchemeResult;
    producer: "model";
    kind: "inference";
};

export type BareBatchResult = {
    readonly statement: BareStatement;
    readonly modelCallId: number | null;
    readonly result: DispatchResult;
};

export type BareExecution = {
    readonly provider: Provider;
    readonly loopSequence: number;
    readonly turnSequence: number;
    readonly signal: AbortSignal | undefined;
};

export type AdmittedTurnResult = {
    readonly status: number;
    readonly outcomes: StrikeOutcome[];
    readonly fingerprint: string;
    readonly emptyTurn: boolean;
};

const TOKEN_BUDGET_OVERFLOW_HARD_DETAIL = "Context Token Budget Overflow: logTokensTotal exceeds logTokensMax; retained context cannot fit.";

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

const INVALID_EMISSION_RECOVERY_MESSAGE = "Response rejected before dispatch; no operations were performed.";

// {§output-allowance-notice} — THE single derivation of a ceiling cut: a
// `length` finish is the engine's own allowance ending the emission, and it
// outranks every other diagnosis (parser symptom, rails verdict) on every
// path. Null means the emission was not cut by the allowance.
const allowanceCutMessage = (
    finishReason: string | null | undefined,
    grant: number | null,
): string | null => finishReason !== "length"
    ? null
    : `emission truncated at the output allowance${grant === null ? "" : ` (${grant} tokens)`}`;

const readEmissionAttempts = (): number => {
    const raw = process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
    const value = Number.parseInt(raw ?? "", 10);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`PLURNK_SERVICE_EMISSION_ATTEMPTS must be a positive integer; got ${raw}`);
    }
    return value;
};

const readMilliseconds = (key: string): number => {
    const raw = process.env[key];
    const value = Number.parseInt(raw ?? "", 10);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer of milliseconds; got ${raw}`);
    return value;
};
// {§provider-recovery} — how long one turn keeps re-issuing its provider call after a
// recoverable failure before the loop parks (0 parks at once), and the first backoff delay,
// which doubles per failure and is capped at twelve times itself.
const readProviderRecovery = (): number => readMilliseconds("PLURNK_SERVICE_PROVIDER_RECOVERY");
const readProviderRecoveryBackoff = (): number => readMilliseconds("PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF");
const RECOVERABLE_PROVIDER_FAILURES: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "network_failure", "deadline_exceeded", "resource_interrupted"]);

// The wall's abort reason — runLoop branches a mid-turn teardown to the 504 terminal on it.
export const LOOP_TIMEOUT_REASON = "loop_timeout";

type TurnDispatch = (context: DispatchContext) => Promise<DispatchResult>;
type WarmWorkspace = (
    context: PlurnkSchemeContext,
    invalidate?: boolean,
    materialize?: boolean,
) => Promise<void>;

// runTurn is six phases over four records. The turn container (phase 1) is what
// derivation (2) and the initialization turn read; the request (3) is what the
// provider attempt loop (4) sends and may rebuild, over its own bookkeeping; the
// emission (4) is what admission (5) and settlement (6) consume. Each record names
// exactly the locals that cross its phase boundary.

// runTurn's arguments with their defaults applied.
type TurnArgs = {
    readonly provider: Provider;
    readonly childProvider: Provider;
    readonly messages: ChatMessage[];
    readonly recap: string;
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly signal: AbortSignal | undefined;
    readonly onDispatch: ((logEntryId: number) => void) | undefined;
    readonly onSettled: ((logEntryId: number) => void | Promise<void>) | undefined;
    readonly turnNumber: number;
    readonly invalidEmissionRecoveryEntryId: number | null | undefined;
};

// Phase 1 — the producer-neutral turn container: the turns opened for this cycle
// and the initialization plan the worker's first turn executes. The model turn is
// opened here only when no initialization turn precedes it.
type TurnContainer = {
    readonly workerName: string;
    readonly transientOpenLogEntryId: number | null;
    readonly loopSequence: number;
    readonly createdTurnIds: number[];
    readonly initializationTurn: TurnRow | null;
    readonly initializationPolicies: CapabilityPolicy[];
    readonly initializationStatements: InternalTurnStatement[];
    readonly modelTurn: TurnRow | null;
    readonly systemCtx: PlurnkSchemeContext;
};

// What packet assembly reads from the turn; capacity recovery rebuilds from the same facts.
type PacketFacts = {
    readonly turnId: number;
    readonly seq: number;
    readonly gitStatus: GitStatusSnapshot | null;
    readonly notices: Notice[];
    readonly transientOpenLogEntryId: number | null;
    promptProjection: "automatic" | "withheld";
};

// Phase 3 — the model request: the inference turn's identity, its action cursor and
// the packet, which the attempt loop re-attributes per call and capacity recovery rebuilds.
type TurnRequest = PacketFacts & {
    readonly createdTurnIds: number[];
    readonly loopSeq: number;
    readonly systemCtx: PlurnkSchemeContext;
    nextActionIndex: number;
    packet: RequestPacket;
};

// Phase 4 — the attempt loop's bookkeeping: every logical provider call's durable
// identities, the recovery clock ({§provider-recovery}) and the wire spend, shared
// with the failure handler.
type ProviderAttempts = {
    wire: MaterializedModelRequest;
    response: ProviderAttempt | undefined;
    split: SplitProviderResponse | undefined;
    railGrammar: string | undefined;
    railEvidence: GrammarEvidence | undefined;
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
    readonly providerWorkerId: string;
    // {§turn-accounting-notice} (#465) — every physical exchange this turn pays
    // for, successes and failed calls alike, so the completion notice carries
    // the exact settled wire spend.
    readonly turnWireAccounting: ProviderRequestAccounting[];
};

// The completed exchange the attempt loop settled on, as admission and settlement read it.
type ProviderEmission = {
    readonly response: ProviderAttempt;
    readonly split: SplitProviderResponse;
    readonly modelCallId: number;
    readonly railGrammar: string | undefined;
    readonly railEvidence: GrammarEvidence | undefined;
    readonly emissionAttempts: number;
    readonly signal: AbortSignal | undefined;
};

// {§notifications-reasoning-event} — the per-call observer a provider streams reasoning through.
type ReasoningObserver = {
    readonly observeRequest: (...args: Parameters<ModelCall["observeRequest"]>) => ReturnType<ModelCall["observeRequest"]>;
    readonly observeReasoning: ((delta: string) => void) | undefined;
    readonly end: () => void;
};

// Every turn result carries the same shape; a diversion names only what differs.
const turnResult = (
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
    fingerprint: "",
    capacityHardStop: false,
    providerParked: false,
    emptyTurn: false,
    emissionAttempts: 0,
    emissionExhausted: false,
    ...facts,
});
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
    readonly #reasoningEventNotify: ReasoningEventNotify | undefined;
    readonly #loopPacketNotify: LoopPacketNotify | undefined;
    readonly #wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly #executors: () => ExecutorRegistry | undefined;
    readonly #capabilities: CapabilityResolver;
    readonly #loopSignal: (loopId: number) => AbortSignal | undefined;
    readonly #interactions: ClientInteractions;
    readonly #warmWorkspace: WarmWorkspace;
    readonly #dispatch: TurnDispatch;
    readonly #resolveWorkerProviderIdentity: (workerId: number) => Promise<{ workerId: string }>;
    // {§operator-grammar} — one read per path per daemon; the file is the operator's and static.
    #grammarCache = new Map<string, string>();
    readonly #materialization: TurnMaterialization;
    readonly #bareBatch: BareBatchRunner;
    readonly #admitted: AdmittedTurnExecutor;

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
        reasoningEventNotify,
        loopPacketNotify,
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
        reasoningEventNotify?: ReasoningEventNotify;
        loopPacketNotify?: LoopPacketNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        interactions: ClientInteractions;
        warmWorkspace: WarmWorkspace;
        dispatch: TurnDispatch;
        resolveWorkerProviderIdentity: (workerId: number) => Promise<{ workerId: string }>;
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
        this.#reasoningEventNotify = reasoningEventNotify;
        this.#loopPacketNotify = loopPacketNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#executors = executors;
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
        this.#loopSignal = loopSignal;
        this.#interactions = interactions;
        this.#warmWorkspace = warmWorkspace;
        this.#dispatch = dispatch;
        this.#resolveWorkerProviderIdentity = resolveWorkerProviderIdentity;
        this.#materialization = new TurnMaterialization({ db: this.#db, weighContent: this.#weighContent });
        this.#bareBatch = new BareBatchRunner({ db: this.#db, providerAttributions: this.#providerAttributions.bind(this), providerFailure: TurnRunner.#providerFailure });
        this.#admitted = new AdmittedTurnExecutor({ db: this.#db, schemes: this.#schemes, notices: this.#notices, problems: this.#problems, dispatcher: this.#dispatcher, bareBatch: this.#bareBatch });
    }

    async #recordInference(args: {
        workspaceId: number;
        workerId: number;
        loopId: number;
        turnId: number;
        evidence: InferenceEvidence;
    }): Promise<void> {
        await Turn.recordInference(this.#db, args.turnId, args.evidence);
        if (this.#loopPacketNotify === undefined) return;
        const packetCount = await this.#db.engine_loop_packet_count.get<{
            count: number; id: number;
        }>({ loop_id: args.loopId });
        if (packetCount === undefined) throw new Error(`loop ${args.loopId}: packet count row missing`);
        this.#loopPacketNotify(args.workspaceId, {
            workerId: args.workerId,
            loopId: args.loopId,
            packetCount: packetCount.count,
        });
    }

    // {§operator-grammar} — the operator's grammar text for this provider, or undefined when
    // none is configured. A real alias scopes its knob; an alias-free direct route uses the
    // global provider configuration. Unrelated alias settings never apply
    // ({§grammar-configuration-admission}). An unreadable file throws: a configured grammar
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

    // {§packet-attachment-parts}: native parts come from the READ's immutable snapshot,
    // never from a source that may have changed since the observation.
    async #wireMessages(packet: RequestPacket, ctx: PlurnkSchemeContext, provider: Provider): Promise<MaterializedModelRequest> {
        const accepted = acceptedKinds(provider.inputModalities);
        if (accepted.length === 0 || !(packet.attachments ?? []).some((attachment) => accepted.includes(attachment.kind))) {
            return {
                messages: PacketWire.packetToWireMessages(packet) as ChatMessage[],
                nativeInputs: [],
            };
        }
        const nativeInputs = new Set<string>();
        const messages = await PacketWire.wireMessages(packet, async (attachment) => {
            const bytes = await NativeContent.read(ctx.db, attachment.contentHash);
            nativeInputs.add(attachment.coordinate);
            return bytes;
        }, (kind) => accepted.includes(kind));
        return { messages, nativeInputs: [...nativeInputs] };
    }

    // One inference cycle: the six phases in order, over the records declared above.
    // A diversion (curation overflow, a provider failure, an exhausted emission)
    // completes the turn and returns; anything else that throws fails every turn
    // this cycle opened.
    async runTurn({
        provider, childProvider = provider, messages, recap = "", workspaceId, workerId, loopId, signal, onDispatch, onSettled,
        turnNumber = 1, invalidEmissionRecoveryEntryId,
    }: {
        provider: Provider;
        childProvider?: Provider;
        messages: ChatMessage[];
        // Optional Recap override; packet assembly owns default sourcing.
        recap?: string;
        workspaceId: number; workerId: number; loopId: number;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        onSettled?: (logEntryId: number) => void | Promise<void>;
        // Model-attempt ordinal in the surrounding loop. Attempt 1 admits the
        // initial prompt only while its durable publication is still absent.
        turnNumber?: number;
        // An id identifies the rejected row informing this turn ({§engine-rails}
        // Contract Strikes: recovery is informed when the rail permits continuation).
        invalidEmissionRecoveryEntryId?: number | null;
    }): Promise<EngineTurnResult> {
        const args: TurnArgs = {
            provider, childProvider, messages, recap, workspaceId, workerId, loopId, signal, onDispatch, onSettled,
            turnNumber, invalidEmissionRecoveryEntryId,
        };
        const createdTurnIds: number[] = [];
        try {
            const container = await this.#openTurnContainer(args, createdTurnIds);
            const gitStatus = await this.#deriveWorkspace(args, container.systemCtx);
            if (container.initializationTurn !== null) await this.#runInitializationTurn(args, container, container.initializationTurn);
            const request = await this.#composeRequest(args, container, gitStatus);
            const overflow = this.#packets.curationOverflow(request.packet);
            if (overflow !== null) return await this.#failCuration(request, overflow);
            const attempts = await this.#prepareProviderAttempts(args, request);
            let emission: ProviderEmission;
            try {
                emission = await this.#attemptProvider(args, request, attempts);
            } catch (error) {
                return await this.#settleProviderFailure(error, args, request, attempts);
            }
            if (!emission.split.emissionValid) return await this.#rejectExhaustedEmission(args, request, emission);
            await this.#recordAdmittedEmission(args, request, emission);
            return await this.#settleAdmittedTurn(args, request, emission);
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

    // Phase 1 — the producer-neutral turn container. Every producer opens the same
    // durable turn and completes it only after its ordered operations settle; model
    // packets and provider metadata are optional inference evidence, not turn identity.
    async #openTurnContainer(args: TurnArgs, createdTurnIds: number[]): Promise<TurnContainer> {
        const { workspaceId, workerId, loopId, invalidEmissionRecoveryEntryId } = args;
        const workerName = await WorkerName.forId(this.#db, workerId);
        const transientOpenLogEntryId = typeof invalidEmissionRecoveryEntryId === "number"
            ? invalidEmissionRecoveryEntryId
            : null;
        const initialSequence = await this.#db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        if (initialSequence === undefined) throw new Error("Engine.runTurn: next turn sequence is unavailable");
        // Turn-0 foists that belong to the Worker (catalog preview, AGENTS) gate
        // on its first inference history, not on loop sequence: honest client or
        // runtime administrative turns may precede the first provider exchange.
        // Per-loop foists such as the initial message's publication
        // ({§message-arrival}) fire once per loop: the inbox row's publication state,
        // rather than the model-turn ordinal, prevents an overflow diversion from
        // replaying a message and its automatic path READs.
        const loopSequence = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId }))?.sequence ?? loopId;
        const priorInference = await this.#db.engine_worker_has_inference_history.get<{ present: number }>({
            worker_id: workerId,
        });
        const workerFirstInference = priorInference?.present === 0;
        // {§worker-initialization-entry} — turn zero is an ordinary `_plurnk`
        // operation turn. Its model-facing zero is a phase label; durable turn
        // coordinates remain one-based.
        const initializationTurn = initialSequence.next === 1 && workerFirstInference
            ? await Turn.open(this.#db, { loopId, producer: "_plurnk", kind: "initialization" })
            : null;
        if (initializationTurn !== null) createdTurnIds.push(initializationTurn.id);
        const initializationPolicies = initializationTurn === null
            ? []
            : (await CapabilityPolicies.layers(this.#db, workspaceId)).map((layer) => layer.policy);
        const modelTurn = initializationTurn === null
            ? await Turn.open(this.#db, { loopId, producer: "model", kind: "inference" })
            : null;
        if (modelTurn !== null) createdTurnIds.push(modelTurn.id);
        // {§env-delta-log-pull} — creation atomically owns the ordinary worker
        // baseline or fork snapshot. Packet assembly consumes, never invents,
        // that durable observation boundary.
        const ambientCursor = await this.#db.engine_initialize_ambient_cursor.get<{
            ambient_event_cursor: number | null;
        }>({ workspace_id: workspaceId, worker_id: workerId });
        if (ambientCursor?.ambient_event_cursor === null || ambientCursor === undefined) {
            throw new Error(`worker ${workerId} has no durable ambient observation boundary`);
        }
        const systemCtx = this.#schemeContext(args, initializationTurn?.id ?? modelTurn!.id);
        const initializationStatements: InternalTurnStatement[] = [];
        // {§worker-initialization-entry} — the worker's first turn is the worked
        // example itself: the actual orienting operations and ordinary NOTEs.
        // {§turn0-agents-stunt} — the project AGENTS.md (materialized by LoopDocs as
        // worker:///_plurnk/agents.md) gets one foisted READ on the worker's first
        // loop, so local repo guidance is visible turn-0 content. Global policy
        // stays in the system prompt; nothing else is force-read.
        if (initializationTurn !== null) {
            initializationStatements.push({
                op: "NOTE", aside: null, metadata: null, target: null, lineMarker: null,
                body: `This turn surveys tooling and environment. The log records results; ops:///${loopSequence}/${initializationTurn.sequence} contains the submitted OPs.`, position: UNKNOWN_POSITION,
            });
            const agentsEntry = await this.#db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: workspaceId,
                scheme: "worker",
                authority: "",
                pathname: generatedPathname("/agents.md"),
            });
            if (agentsEntry !== undefined) {
                const agentsTarget: UrlPath = {
                    kind: "url", raw: "worker:///_plurnk/agents.md", scheme: "worker",
                    username: null, password: null, hostname: null, port: null,
                    pathname: generatedPathname("/agents.md"), query: null, fragment: null,
                };
                const agentsRead: ReadStatement = {
                    op: "READ", aside: null, target: agentsTarget,
                    metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION,
                };
                initializationStatements.push(agentsRead);
            }
        }
        return {
            workerName, transientOpenLogEntryId, loopSequence, createdTurnIds,
            initializationTurn, initializationPolicies, initializationStatements,
            modelTurn, systemCtx,
        };
    }

    // The `_plurnk` scheme context for one turn. Threaded per turn, never engine
    // state, so concurrent loops on different providers each read their own honest
    // tokenizer values.
    #schemeContext({ workspaceId, workerId, loopId }: TurnArgs, turnId: number): PlurnkSchemeContext {
        return {
            db: this.#db, workspaceId, workerId, loopId, turnId,
            writer: "_plurnk",
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            weigh: this.#weighContent,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s, workspaceId),
            pushNotice: (notice) => this.#notices.push(workspaceId, workerId, loopId, notice),
            requestInteraction: (request, signal = this.#loopSignal(loopId)) => this.#interactions.request(
                request,
                { workspaceId, workerId, loopId, turnId },
                signal,
            ),
        };
    }

    // Phase 2 — membership and derivation to completion, then the one git snapshot
    // every packet rebuild reads.
    async #deriveWorkspace({ workspaceId, loopId }: TurnArgs, systemCtx: PlurnkSchemeContext): Promise<GitStatusSnapshot | null> {
        // The persistent search-index pass (_search-index.maintain) attaches
        // every readable entry/log projection to complete graph/FTS derivations.
        // NOT an action: no log entry, no sequence slot,
        // not dispatched. There is no materialized manifest entry — the catalog
        // is served on demand by FIND: recursive when asked, shallow-mapped below.
        // SPEC {§membership} D4/D5 — git-ls-files workspace membership, resolved at
        // prompt-composition (EMI is eager + exhaustive — git is the only bound). When the
        // workspace's project_root is a git working tree, tracked files are
        // members without a client `add`; active members are materialized
        // (disk → body channel) so they appear in the catalog. No-ops
        // on headless / non-git workspaces. Runs BEFORE the derivation pump so
        // this turn's packet reflects them.
        // Joining here is the correctness boundary: passive workspace creation and
        // attachment spend nothing, while the model never runs against partial
        // graph/vector coverage.
        await this.#warmWorkspace(systemCtx, false);
        // The warm materialized membership before deriving. This second pass is the
        // ordinary cheap change detector and captures any drift that landed meanwhile.
        const fsDivergences = await GitMembership.indexGitMembership(systemCtx);
        // {§packet-git-status} — one post-reconciliation snapshot supplies both
        // the compact packet summary and each causal file event's exact XY state.
        const gitStatus = await GitState.status(this.#db, workspaceId, this.#loopSignal(loopId));
        await this.#materialization.logFsFictions(workspaceId, fsDivergences, gitStatus);
        // The refresh above may have changed bodies (including model/client edits
        // since the startup warm). Re-derive to completion before packet/model
        // construction. Membership is already current, so this pass does not
        // consume the filesystem divergences a second time.
        await this.#warmWorkspace(systemCtx, true, false);
        return gitStatus;
    }

    // {§worker-initialization-entry} — the worker's first turn is the worked example
    // itself: the actual orienting operations and ordinary NOTEs, executed as a
    // complete turn before the model boundary.
    async #runInitializationTurn(args: TurnArgs, container: TurnContainer, initializationTurn: TurnRow): Promise<void> {
        const { provider, workspaceId, workerId, loopId, onDispatch, onSettled } = args;
        const { loopSequence, initializationStatements, initializationPolicies } = container;
        // Turn-0 catalog preview (PLURNK_SERVICE_FILES_ITEMS, {§actor-boundary-catalog-preview}):
        // Eight bodyless FIND surveys in the worker's packetless initialization turn establish the Agent
        // Skills, the plurnk references, the enabled tools, agents, and members, then the project, commons,
        // and named scratch, in that order.
        // Their `init` classification lets the model curate this opening survey as one log set.
        // {§operator-config-workspace-files-items} — workspace filesItems replaces the env default.
        const { filesItems: workspaceMI } = await WorkspaceSettings.read(this.#db, workspaceId);
        const filesItems = workspaceMI !== null ? normalizeFilesItems(workspaceMI) : readFilesItems();
        if (filesItems !== null) { // {§actor-boundary-catalog-preview} — once per worker
            initializationStatements.push(...await this.#catalogSurveys(args, container, filesItems));
        }
        const pathname = `/${loopSequence}/${initializationTurn.sequence}`;
        const reasoning = ReasoningView.initialSource();
        await Turn.recordSource(this.#db, initializationTurn.id, "reasoning", reasoning);
        const reasoningRead = ReasoningView.initialRead(provider, loopSequence, initializationTurn.sequence);
        if (reasoningRead !== null) initializationStatements.push(reasoningRead);
        initializationStatements.push({
            op: "READ", aside: "inspect this turn's emission", matcher: null, body: null, metadata: null,
            target: {
                kind: "url", raw: `ops://${pathname}`, scheme: "ops", pathname,
                username: null, password: null, hostname: null, port: null, query: null, fragment: null,
            },
            lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
        });
        // {§message-arrival} — the message reaches the model as an inbound SEND in the first
        // model turn; initialization does not READ it a second time.
        const admittedInitializationStatements = initializationStatements.filter((statement) =>
            this.#capabilities.allowsAcross(statement, workspaceId, initializationPolicies));
        const source = admittedInitializationStatements.length === 0 ? "" : TurnOps.renderInternal(admittedInitializationStatements);
        const admitted = [...PlurnkParser.parseReasoningNotes(reasoning), ...(source.length === 0 ? [] : TurnOps.parseInternal(source))];
        const result = await this.executeAdmittedTurn({
            statements: admitted,
            source,
            origin: "_plurnk",
            workspaceId,
            workerId,
            loopId,
            turnId: initializationTurn.id,
            fromSequence: 1,
            failOnOperationError: true,
            signal: this.#loopSignal(loopId),
            onDispatch,
            onSettled,
        });
        if (result.status !== 200) {
            throw new Error(`initialization returned ${result.status}; expected 200`);
        }
    }

    // {§actor-boundary-catalog-preview} — the opening surveys, each admitted only when
    // its scheme is registered for the workspace. A positive filesItems caps the
    // project rows.
    async #catalogSurveys({ workspaceId }: TurnArgs, { workerName, initializationPolicies }: TurnContainer, filesItems: number): Promise<InternalTurnStatement[]> {
        const catalogSchemes = await this.#db.engine_scheme_catalog_summary.all<{ scheme: string; entries: number; shallow_items: number }>({ workspace_id: workspaceId });
        const fileItems = catalogSchemes.find(({ scheme }) => scheme === "file")?.shallow_items ?? 0;
        const fileCap = filesItems > 0 && fileItems > 0 ? Math.min(filesItems, fileItems) : null;
        const surveys: Array<FindStatement | ReadStatement> = [
            {
                op: "FIND", aside: null,
                target: { kind: "url", raw: "skill://*/SKILL.md", scheme: "skill", username: null, password: null, hostname: "*", port: null, pathname: "/SKILL.md", query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: null,
                target: workerCatalogTarget("plurnk"),
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                // {§tools-resource-materialization} — enabled tool families
                // (MCP servers) survey at family level; each row's summary is
                // the server one-liner or its flagship invocation form, so the
                // discovery row itself orients. Servers named in
                // PLURNK_MCP_EXPANDED add a second survey of their complete
                // tool tree.
                op: "FIND", aside: null,
                target: workerCatalogTarget("tools"),
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            ...this.#toolExpansions(workspaceId, initializationPolicies),
            {
                // {§a2a-agents-catalog} — enabled outbound agents survey at
                // alias level; each row's summary is the agent's identity line,
                // the exact card stays pullable through READ a2a://<alias>.
                op: "FIND", aside: null,
                target: { kind: "url", raw: "worker:///_plurnk/agents/*.md", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: generatedPathname("/agents/*.md"), query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                // {§members-projection} — enabled members definitions survey at alias
                // level; each row's summary is what its glob resolved to.
                op: "FIND", aside: null,
                target: { kind: "url", raw: "worker:///_plurnk/members/*.md", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: generatedPathname("/members/*.md"), query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: "project root member files",
                target: { kind: "local", raw: "*" },
                metadata: null,
                matcher: null,
                body: null,
                lineMarker: fileCap === null ? null : { marks: [1, fileCap] },
                position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: "workspace knowledgebase entries",
                target: { kind: "url", raw: "worker:///*", scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/*", query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: "worker knowledgebase entries",
                target: { kind: "url", raw: `worker://${workerName}/*`, scheme: "worker", username: null, password: null, hostname: workerName, port: null, pathname: "/*", query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
        ];
        return surveys.filter(({ target }) =>
            this.#schemes.get(target?.kind === "url" ? target.scheme : "file", workspaceId) !== undefined);
    }

    // {§tools-resource-materialization} — expanded families project complete
    // invocation blocks, paged through ordinary FIND result ranges: one pattern FIND
    // per family, naming the admitted tools when the policy narrows them.
    #toolExpansions(workspaceId: number, policies: CapabilityPolicy[]): FindStatement[] {
        const registry = this.#executors();
        const expansions: FindStatement[] = [];
        for (const tag of registry?.availableRuntimes(workspaceId) ?? []) {
            const entry = registry?.entry(tag, workspaceId);
            if (entry?.resourcesPath !== "/tools" || entry.expandTools !== true) continue;
            const tools = registry?.toolRegistry(tag, workspaceId);
            const admittedTools = tools?.tools.filter((tool) =>
                this.#capabilities.allowsRuntimeAcross(tag, tool.target, workspaceId, policies)) ?? [];
            if (admittedTools.length === 0) continue;
            const targetFilter = tools !== null && tools !== undefined && admittedTools.length !== tools.tools.length
                ? " \\((?:" + admittedTools.map((tool) => regexLiteral(PathSyntax.escapeTarget(tool.target))).join("|") + ")\\)"
                : " ";
            const pattern = "^(\x60{3,})" + regexLiteral(tag) + targetFilter + "[^\\n]*?(?:\\1|\\n[\\s\\S]*?\\n\\1)$";
            expansions.push({
                op: "FIND", aside: null,
                target: { kind: "url", raw: `worker:///_plurnk/tools/${tag}.md`, scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: generatedPathname(`/tools/${tag}.md`), query: null, fragment: null },
                metadata: null,
                matcher: { dialect: "regex", raw: `/${pattern.replaceAll("/", "\\/")}/m`, pattern, flags: "m" },
                body: null, lineMarker: null, position: UNKNOWN_POSITION,
            });
        }
        return expansions;
    }

    // Phase 3 — the inference turn and its request: the prompts the model has not
    // seen, their open-path READs, the ambient and stream deltas, then the packet
    // ({§packet-stored-shape}).
    async #composeRequest(args: TurnArgs, container: TurnContainer, gitStatus: GitStatusSnapshot | null): Promise<TurnRequest> {
        const { workspaceId, workerId, loopId } = args;
        // Initialization is a complete preceding turn, not a set of rows
        // interleaved with the model boundary. The engine may now acquire the
        // inference turn inside the same warmed workspace cycle.
        const modelTurn = container.modelTurn ?? await Turn.open(this.#db, { loopId, producer: "model", kind: "inference" });
        if (container.modelTurn === null) container.createdTurnIds.push(modelTurn.id);
        const { id: turnId, sequence: seq } = modelTurn;
        const systemCtx = this.#schemeContext(args, turnId);
        const messages = await this.#publishMessages(args, turnId);
        let nextActionIndex = await this.#readOpenPaths(args, turnId, messages.openPaths, messages.nextActionIndex);
        // {§env-delta-log-pull} — materialize ambient observations before packet
        // composition and reserve their action indices. {§exec-stream} owns the
        // distinct byte-cursor path for this worker's streams.
        // {§exec-poll} — an execution `<0>` is turn-scoped: reap the worker's open turn-scoped streams (necessarily
        // from a prior turn — this runs before the turn's own spawns) so a `<0>` never survives into
        // the subsequent turn. The terminal output then surfaces initially visible via the stream-delta path.
        await this.#reapTurnScopedStreams(workerId);
        const ambientEntries = await this.#materialization.materializeEnvironmentDeltas({ workspaceId, workerId, loopId, turnId, fromSequence: nextActionIndex });
        nextActionIndex += ambientEntries.length;
        const streamEntries = await this.#materialization.materializeStreamDeltas({ workspaceId, workerId, loopId, turnId, fromSequence: nextActionIndex });
        nextActionIndex += streamEntries.length;
        await Turn.observeCompletions(this.#db, turnId);
        // {§notifications-log-entry-notify}: materialized observations are
        // ordinary committed log rows, not packet-only content.
        for (const id of [...ambientEntries, ...streamEntries]) {
            args.onDispatch?.(id);
            await args.onSettled?.(id);
        }
        // The post-reconciliation Git snapshot above is threaded into the packet
        // and every budget rebuild; overflow never shells again.
        // Notices are non-terminal observations, never operation-failure truth.
        // Drain once and thread the same set through every overflow rebuild.
        const notices = this.#notices.drain(loopId)
            .filter((event) => (event as { level?: string }).level !== "info") as Notice[];
        // Build the model request packet ({§packet-stored-shape}). The log build
        // queries log_entries scoped to the worker, including this turn's newly
        // published message arrivals.
        const facts: PacketFacts = { turnId, seq, gitStatus, notices, transientOpenLogEntryId: container.transientOpenLogEntryId, promptProjection: "automatic" };
        let packet = await this.#buildPacket(args, facts);
        // {§context-output-admission} — output admission changes no operation
        // outcome, authored memory, or turn identity.
        if (await this.#packets.admitOutput(packet, turnId)) packet = await this.#buildPacket(args, facts);
        return { ...facts, createdTurnIds: container.createdTurnIds, loopSeq: container.loopSequence, systemCtx, nextActionIndex, packet };
    }

    // Pre-model writes. Each message the model has not seen yet becomes an inbound `SEND`
    // row; model operations continue the same turn sequence after these rows. Returns the
    // next action index and the messages' open paths.
    // {§message-loop-containment}: the loop contains every message that arrived before this
    // boundary. Publish each unpublished inbox row oldest-first, exactly once, as an inbound
    // SEND row ({§message-arrival}); its selected paths ride along for the READs that follow.
    async #publishMessages(
        { workerId, loopId, onDispatch, onSettled }: TurnArgs,
        turnId: number,
    ): Promise<{ nextActionIndex: number; openPaths: string[] }> {
        let nextActionIndex = 1;
        const openPaths: string[] = [];
        const unpublished = await this.#db.drain_unpublished_messages_for_loop.all<{
            id: number; ordinal: number; source: string | null; body: string; open_paths: string; path: string;
        }>({ loop_id: loopId });
        for (const message of unpublished) {
            openPaths.push(...assertOpenPaths(JSON.parse(message.open_paths) as unknown, `Message ${message.id} open_paths`));
            const logEntryId = await this.#materialization.writeArrivalLog({
                workerId, loopId, turnId, sequence: nextActionIndex++, body: message.body, source: message.source, resource: message.path,
            });
            const published = await this.#db.drain_publish_message.get<{ id: number }>({ id: message.id, log_entry_id: logEntryId });
            if (published === undefined) throw new Error(`TurnRunner.#publishMessages: message ${message.id} was already published`);
            onDispatch?.(logEntryId);
            await onSettled?.(logEntryId);
        }
        return { nextActionIndex, openPaths };
    }

    // {§methods-loop-run-open-paths}: selected workspace paths belong to the message.
    // Publish it, then dispatch ordinary core READs in that same turn;
    // missing/non-member paths retain their normal 4xx. Returns the next action index.
    async #readOpenPaths({ workspaceId, workerId, loopId, onDispatch, onSettled }: TurnArgs, turnId: number, openPaths: string[], fromSequence: number): Promise<number> {
        let nextActionIndex = fromSequence;
        for (const raw of openPaths) {
            const pathname = raw.startsWith("/") ? raw : `/${raw}`;
            const fileRead: ReadStatement = {
                op: "READ", aside: null, lineMarker: null, matcher: null,
                target: {
                    kind: "url", raw: `file://${pathname}`, scheme: "file",
                    username: null, password: null, hostname: null, port: null,
                    pathname, query: null, fragment: null,
                },
                metadata: null,
                body: null, position: UNKNOWN_POSITION,
            };
            await this.#dispatch({
                statement: fileRead, workspaceId, workerId, loopId, turnId,
                sequence: nextActionIndex, origin: "_plurnk", onDispatch, onSettled,
            });
            nextActionIndex++;
        }
        return nextActionIndex;
    }

    #buildPacket({ messages, recap, workspaceId, workerId, loopId, provider }: TurnArgs, facts: PacketFacts): Promise<RequestPacket> {
        return this.#packets.buildRequestPacket({
            initialMessages: messages,
            recap,
            workspaceId,
            workerId,
            loopId,
            currentTurnSeq: facts.seq,
            provider,
            gitStatus: facts.gitStatus,
            notices: facts.notices,
            transientOpenLogEntryId: facts.transientOpenLogEntryId,
            promptProjection: facts.promptProjection,
            turnId: facts.turnId,
        });
    }

    // Retained context cannot fit: the turn completes on the curation failure and
    // the loop rules the terminal.
    async #failCuration(request: TurnRequest, overflow: CurationOverflow): Promise<EngineTurnResult> {
        const curationFailure = curationOverflowFailure(overflow);
        await Turn.complete(this.#db, request.turnId, curationFailure.status);
        return turnResult(request, curationFailure.status, { curationFailure });
    }

    // Phase 4's bookkeeping: the wire request, the recovery knobs, the signal the
    // provider sees, the client id and the worker's provider identity.
    async #prepareProviderAttempts({ provider, workspaceId, workerId, loopId, signal }: TurnArgs, request: TurnRequest): Promise<ProviderAttempts> {
        const wire = await this.#wireMessages(request.packet, request.systemCtx, provider);
        // {§provider-recovery} — this turn's recovery clock: the first recoverable provider
        // failure starts it; the budget and backoff are the operator's.
        const recoveryBudget = readProviderRecovery();
        const recoveryBackoff = readProviderRecoveryBackoff();
        const providerSignal = this.#loopSignal(loopId) ?? signal;
        const { workerId: providerWorkerId } = await this.#resolveWorkerProviderIdentity(workerId);
        return {
            wire,
            response: undefined,
            split: undefined,
            railGrammar: undefined,
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
            providerWorkerId,
            turnWireAccounting: [],
        };
    }

    // Phase 4 — the provider attempt loop. Each iteration is one logical call: a
    // recoverable failure or a capacity rebuild re-issues the same emission attempt,
    // an invalid emission spends one, and a valid emission ends the loop
    // ({§invalid-emission-attempts}).
    async #attemptProvider(args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts): Promise<ProviderEmission> {
        const { provider, workspaceId, workerId, loopId, signal } = args;
        // {§turn-lifecycle}: bracket the complete provider-attempt window with liveness notices.
        if (!signal?.aborted) this.#notices.push(workspaceId, workerId, loopId, { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" });
        attempts.railGrammar = await this.#operatorGrammar(provider);
        const attemptLimit = readEmissionAttempts();
        const strikeStreak = await this.#strikes.streak(loopId);
        for (let attempt = 1; attempt <= attemptLimit;) {
            const verdict = await this.#issueProviderCall(args, request, attempts, attempt, strikeStreak);
            if (verdict === "admitted") break;
            if (verdict === "rejected") attempt++;
        }
        if (!signal?.aborted) {
            const wire = aggregateProviderAccounting(attempts.turnWireAccounting);
            this.#notices.push(workspaceId, workerId, loopId, {
                source: "engine:turn",
                kind: "turn_generated",
                level: "info",
                message: "parsing model response",
                // {§turn-accounting-notice} (#465) — the exact settled derivation,
                // never a second stored fact: a live watcher accrues loop cost per turn.
                accounting: {
                    requests: attempts.turnWireAccounting.length,
                    costUsd: wire.costUsd,
                    inputTokens: wire.usage?.inputTokens ?? null,
                    outputTokens: wire.usage?.outputTokens ?? null,
                    reasoningTokens: wire.usage?.outputTokenDetails?.reasoningTokens ?? null,
                    cacheReadTokens: wire.usage?.inputTokenDetails?.cacheReadTokens ?? null,
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
    // under the reasoning observer, and its classification. Capacity recovery and
    // {§provider-recovery} re-issue the same emission attempt; the parser's admission
    // is the one verdict on a completed exchange.
    async #issueProviderCall(
        args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts, attempt: number, strikeStreak: number,
    ): Promise<"admitted" | "rejected" | "reissued"> {
        const { provider, workspaceId, workerId, loopId } = args;
        // Capacity recovery may rebuild and resend the request without
        // consuming a grammar-emission attempt. Every logical provider
        // call still receives its own durable sequence and accounting.
        attempts.currentEmissionAttempt = attempt;
        attempts.modelCallSequence++;
        const attributionContext: PluginAttributionContext = Object.freeze({
            workspaceId: String(workspaceId),
            workerId: attempts.providerWorkerId,
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
        const reasoning = this.#reasoningObserver(args, request.turnId, modelCall);
        let completedResponse: ProviderResponse;
        try {
            completedResponse = await this.#generate(args, request, attempts, modelCall, reasoning, strikeStreak);
        } catch (error) {
            if (error instanceof ProviderError
                && RECOVERABLE_PROVIDER_FAILURES.has(error.kind)
                && attempts.signal?.aborted !== true) {
                await this.#recoverProviderFailure(args, request, attempts, modelCall, attemptRow.id, error);
                return "reissued";
            }
            if (!(error instanceof ProviderError)
                || error.kind !== "capacity_exceeded"
                || attempts.signal?.aborted === true
                || !await this.#recoverCapacityPacket(args, request, attempts)) {
                throw error;
            }
            await this.#resendForCapacity(args, request, attempts, modelCall, error);
            return "reissued";
        } finally {
            reasoning.end();
        }
        if (attempts.recoveryFailures > 0) {
            this.#notices.push(workspaceId, workerId, loopId, {
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
        const split = this.#splitResponse(completedResponse, this.#executors()?.availableRuntimes(workspaceId) ?? []);
        attempts.split = split;
        await this.#classifyProviderAttempt(attempts, attemptRow.id, split, attempt, split.emissionValid);
        return split.emissionValid ? "admitted" : "rejected";
    }

    // {§notifications-reasoning-event} — only the parent emission is conversational;
    // BARE has no observer on its isolated calls. Reasoning deltas cite the physical
    // request they stream in; a new request or the call's end closes the open span.
    #reasoningObserver({ workspaceId, workerId, loopId }: TurnArgs, turnId: number, modelCall: ModelCall): ReasoningObserver {
        let reasoningStarted = false;
        let reasoningRequestSequence = 0;
        const end = (): void => {
            if (!reasoningStarted) return;
            this.#reasoningEventNotify!(workspaceId, {
                workerId,
                loopId,
                turnId,
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
        const observeReasoning = this.#reasoningEventNotify === undefined
            ? undefined
            : (delta: string): void => {
                if (reasoningRequestSequence === 0) {
                    throw new Error("provider emitted reasoning before opening its physical request");
                }
                if (!reasoningStarted) {
                    reasoningStarted = true;
                    this.#reasoningEventNotify!(workspaceId, {
                        workerId,
                        loopId,
                        turnId,
                        modelCallId: modelCall.id,
                        requestSequence: reasoningRequestSequence,
                        phase: "start",
                    });
                }
                this.#reasoningEventNotify!(workspaceId, {
                    workerId,
                    loopId,
                    turnId,
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
        modelCall: ModelCall, reasoning: ReasoningObserver, strikeStreak: number,
    ): Promise<ProviderResponse> {
        return await observed( // {§observability-boundary}
            GEN_AI_REQUEST_SPAN,
            { model: provider.model, attempt: attempts.modelCallSequence },
            async (span) => {
                try {
                    await this.#packets.recordObservations(request.packet);
                    const generated = await provider.generate({
                        messages: attempts.wire.messages,
                        workerId: attempts.providerWorkerId,
                        workspaceId: String(workspaceId),
                        signal: attempts.signal,
                        grammar: attempts.railGrammar,
                        observeRequest: reasoning.observeRequest,
                        observeReasoning: reasoning.observeReasoning,
                        callKind: "emission",
                    }); // {§provider-surface-generate} {§provider-guarantees-signal-wired} {§provider-guarantees-serial-attempts} {§attribution}
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
                ProviderInstantiate.aliasOf(provider) ?? "plurnk",
                provider.model,
            ),
        );
    }

    // {§provider-recovery} — a transient provider failure never ends the loop: record
    // it, wait, and re-issue the same turn; once the budget is spent the failure
    // handler parks the loop instead of failing it.
    async #recoverProviderFailure(
        { workspaceId, workerId, loopId }: TurnArgs, request: TurnRequest, attempts: ProviderAttempts,
        modelCall: ModelCall, attemptId: number, error: ProviderError,
    ): Promise<void> {
        attempts.recoveryStartedAt ??= Date.now();
        const elapsed = Date.now() - attempts.recoveryStartedAt;
        if (elapsed >= attempts.recoveryBudget) {
            attempts.parked = true;
            throw error;
        }
        attempts.recoveryFailures += 1;
        const failure = TurnRunner.#providerFailure(error, attempts.signal);
        if (error.attempt !== undefined) {
            // {§provider-interrupted-attempt} — the interrupted response stays durable
            // as an unaccepted attempt; it is never admitted or replayed.
            await modelCall.observeResponse(error.attempt, failure, attempts.wire.nativeInputs);
            await this.#classifyProviderAttempt(attempts, attemptId, this.#splitResponse(error.attempt, this.#executors()?.availableRuntimes(workspaceId) ?? []), attempts.currentEmissionAttempt, false);
        } else {
            await modelCall.fail(failure, error.capacity ?? null);
        }
        attempts.callInFlight = false;
        await this.#problems.record({
            workerId,
            loopId,
            turnId: request.turnId,
            sequence: request.nextActionIndex++,
            origin: "_plurnk",
            source: "provider",
            result: failure,
        });
        const wait = Math.min(attempts.recoveryBackoff * 2 ** (attempts.recoveryFailures - 1), attempts.recoveryBackoff * 12);
        this.#notices.push(workspaceId, workerId, loopId, {
            source: "engine:provider",
            kind: "provider_unavailable",
            level: "warn",
            message: `${failure.problem?.title ?? "Provider failure"}: retrying in ${Math.round(wait / 1000)}s (${Math.round(elapsed / 1000)}s of the ${Math.round(attempts.recoveryBudget / 1000)}s recovery budget spent).`,
        });
        // An abort during the wait re-enters generate, which refuses on the aborted signal.
        await delay(wait, undefined, { signal: attempts.signal }).catch(() => undefined);
        // The response is still owed for this exact input. Failure rows remain
        // durable, but recursively materializing them would mutate and cache-bust
        // the request being recovered. {§provider-recovery}
    }

    // The first capacity rejection withholds the automatic prompt projection; the
    // rebuilt request is resent only when it actually changed the wire messages.
    async #recoverCapacityPacket(args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts): Promise<boolean> {
        if (request.promptProjection !== "automatic") return false;
        request.promptProjection = "withheld";
        const candidate = await this.#buildPacket(args, request);
        const candidateRequest = await this.#wireMessages(candidate, request.systemCtx, args.provider);
        if (JSON.stringify(candidateRequest.messages) === JSON.stringify(attempts.wire.messages)) return false;
        request.packet = candidate;
        attempts.wire = candidateRequest;
        return true;
    }

    // The capacity rejection is durable as a failed call and a problem row; the
    // replacement request is rebuilt to include that recovery signal while keeping
    // the selected projection.
    async #resendForCapacity(
        args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts, modelCall: ModelCall, error: ProviderError,
    ): Promise<void> {
        const { workerId, loopId, provider } = args;
        const failure = TurnRunner.#providerFailure(error, attempts.signal);
        await modelCall.fail(failure, error.capacity ?? null);
        attempts.callInFlight = false;
        await this.#problems.record({
            workerId,
            loopId,
            turnId: request.turnId,
            sequence: request.nextActionIndex++,
            origin: "_plurnk",
            source: "provider",
            result: failure,
        });
        // Include the durable recovery signal in the replacement
        // request while preserving the selected recovery posture.
        request.packet = await this.#buildPacket(args, request);
        attempts.wire = await this.#wireMessages(request.packet, request.systemCtx, provider);
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
    async #settleProviderFailure(err: unknown, args: TurnArgs, request: TurnRequest, attempts: ProviderAttempts): Promise<EngineTurnResult> {
        if (err instanceof ModelCallPersistenceError || err instanceof ProviderAccountingIntegrityError) throw err;
        if (!attempts.callInFlight) throw err;
        attempts.callInFlight = false;
        if (attempts.attemptId === null || attempts.modelCall === null) {
            throw new Error("provider call failed without durable model-call and attempt identities", { cause: err });
        }
        const { provider, workspaceId, workerId, loopId } = args;
        const { turnId } = request;
        const failure = TurnRunner.#providerFailure(err, attempts.signal);
        const capacityFailure = err instanceof ProviderError && err.kind === "capacity_exceeded";
        // {§provider-interrupted-attempt} — a provider-declared interruption
        // carries response evidence without becoming a completed exchange.
        // Persist it as an unaccepted attempt before settling the failure.
        if (err instanceof ProviderError && err.attempt !== undefined) {
            attempts.response = err.attempt;
            await attempts.modelCall.observeResponse(err.attempt, failure, attempts.wire.nativeInputs);
            attempts.split = this.#splitResponse(err.attempt, this.#executors()?.availableRuntimes(workspaceId) ?? []);
            await this.#classifyProviderAttempt(attempts, attempts.attemptId, attempts.split, attempts.currentEmissionAttempt, false);
        } else {
            await attempts.modelCall.fail(
                failure,
                err instanceof ProviderError ? err.capacity ?? null : null,
            );
            if (!capacityFailure) attempts.emissionAttempts = attempts.currentEmissionAttempt;
        }
        const evidence = this.#requestEvidence(provider, request.packet, attempts.split, attempts.response);
        // {§turn-never-blank} — a ProviderError means no completed exchange exists.
        // Persist its exact RFC 9457 result before propagating it. Grammar transport
        // evidence exists only on completed responses ({§operator-grammar}).
        // Cancellation is lifecycle truth, not a provider failure. Close the
        // attempted turn without inventing an assistant response, then let
        // runLoop/Daemon settle the exact 504/499 loop result.
        if (attempts.signal?.aborted) {
            const status = attempts.signal.reason === LOOP_TIMEOUT_REASON ? 504 : 499;
            await this.#recordInference({ workspaceId, workerId, loopId, turnId, evidence });
            await Turn.complete(this.#db, turnId, status);
            throw err;
        }
        const recorded = await this.#problems.record({
            workerId,
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
        await this.#recordInference({ workspaceId, workerId, loopId, turnId, evidence });
        await Turn.complete(this.#db, turnId, attempts.parked ? 202 : recorded.result.status);
        const { emissionAttempts } = attempts;
        if (attempts.parked) {
            // {§provider-recovery} — the recovery budget is spent: the loop parks exactly like a
            // [202] wait and resumes on the next prompt or wake; the failure stays durable.
            this.#notices.push(workspaceId, workerId, loopId, {
                source: "engine:provider",
                kind: "provider_unavailable",
                level: "error",
                message: `${recorded.result.problem?.title ?? "Provider failure"}: the ${Math.round(attempts.recoveryBudget / 1000)}s recovery budget is spent; the loop is parked and resumes on the next prompt or wake.`,
            });
            return turnResult(request, 202, { providerParked: true, providerFailure: recorded.result, emissionAttempts });
        }
        if (capacityFailure) {
            return turnResult(request, recorded.result.status, { capacityHardStop: true, capacityFailure: recorded.result, emissionAttempts });
        }
        if (err instanceof ProviderError && err.kind === "invalid_response") {
            // {§engine-rails} Contract Strikes: the provider violated its response
            // contract. The failure is durable and the turn is complete; the strike
            // rail — never an instant loop death — rules whether the streak ends it.
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
    #requestEvidence(provider: Provider, packet: RequestPacket, split: SplitProviderResponse | undefined, response: ProviderAttempt | undefined): InferenceEvidence {
        return {
            packet: StoredPacket.stringify(packet),
            sections: StoredPacket.sections(packet),
            usageCurationBudget: this.#packets.curationBudgetFor(packet),
            finishReason: split?.callMetadata.finishReason ?? null,
            model: split?.callMetadata.model ?? provider.model,
            meta: JSON.stringify(response?.meta ?? {}),
        };
    }

    // Phase 5, refused — {§invalid-emission-attempts}: every exhaustion publishes the
    // raw final response and its recovery fact; {§engine-rails} Contract Strikes rule
    // how many consecutive frame-contract violations the loop survives.
    async #rejectExhaustedEmission({ provider, workspaceId, workerId, loopId }: TurnArgs, request: TurnRequest, emission: ProviderEmission): Promise<EngineTurnResult> {
        const { split, response } = emission;
        const { turnId } = request;
        const rejectedModelEntryId = await this.#dispatcher.writeEmissionAttempt({
            verbatim: split.packetAssistant.content,
            workerId,
            loopId,
            turnId,
            sequence: request.nextActionIndex,
            modelCallId: emission.modelCallId,
        });
        // {§invalid-emission-attempts} — the informed turn carries the parser's own
        // diagnostic and position: the model sees WHY, not only that it was refused.
        const diagnostic = split.parseErrors[0];
        const cut = allowanceCutMessage(split.callMetadata.finishReason, response.capacity.responseMax ?? provider.outputBudget);
        if (cut !== null) {
            this.#notices.push(workspaceId, workerId, loopId, {
                source: "engine:capacity",
                kind: "output_truncated",
                level: "error",
                message: `${cut}; no operations were performed`,
            });
        } else {
            this.#notices.push(workspaceId, workerId, loopId, {
                source: "engine:grammar",
                kind: "invalid_emission",
                level: "error",
                message: diagnostic === undefined
                    ? INVALID_EMISSION_RECOVERY_MESSAGE
                    : `${INVALID_EMISSION_RECOVERY_MESSAGE} Parser: ${diagnostic.message}`,
                ...(diagnostic !== undefined && diagnostic.line > 0
                    ? { position: { type: "content-offset", line: diagnostic.line, column: diagnostic.column } }
                    : {}),
            });
        }
        await this.#recordInference({ workspaceId, workerId, loopId, turnId, evidence: this.#requestEvidence(provider, request.packet, split, response) });
        await Turn.complete(this.#db, turnId, TURN_STATUS_IMPLICIT_CONTINUE);
        return turnResult(request, TURN_STATUS_IMPLICIT_CONTINUE, {
            outcomes: [{ op: null, status: 500, problemType: "https://problems.plurnk.xyz/engine/invalid-emission-exhausted" }],
            fingerprint: `frame-contract-violation:${turnId}`,
            emissionAttempts: emission.emissionAttempts,
            emissionExhausted: true,
            rejectedModelEntryId,
        });
    }

    // Phase 5, admitted — the emission's notices, then {§packet-stored-shape}: admitted
    // emission data extends the packet while provider-call metadata remains on the
    // Turn row.
    async #recordAdmittedEmission({ provider, workspaceId, workerId, loopId }: TurnArgs, request: TurnRequest, emission: ProviderEmission): Promise<void> {
        const { split, response } = emission;
        const { packetAssistant, callMetadata, parseNotices } = split; // raw assistant content is opaque — split, never interpreted — {§provider-guarantees-assistantraw-opaque}
        for (const notice of parseNotices) {
            this.#notices.push(workspaceId, workerId, loopId, notice);
        }
        const allowanceCut = allowanceCutMessage(callMetadata.finishReason, response.capacity.responseMax ?? provider.outputBudget);
        // {§empty-turn} — a response cut at the output allowance with nothing admitted names the
        // cut, so the model reads the ceiling, never a parser symptom (#478).
        if (split.emptyTurn && allowanceCut !== null) {
            this.#notices.push(workspaceId, workerId, loopId, {
                source: "engine:turn",
                kind: "output_truncated",
                level: "warn",
                message: `${allowanceCut}; no operations were performed`,
            });
        }
        // Non-fatal provider transport notices on an accepted turn. Forward each
        // Notice with a content-offset `line:col`;
        // the model resolves it against its own emission — READ ops:///<loop>/<turn> at the
        // cited lines ({§turn-ops-entry}) — not an embedded snippet that would duplicate the emission.
        for (const notice of response.notices ?? []) {
            const located = typeof notice.position === "number"
                ? this.#offsetToLineColumn(packetAssistant.content, notice.position)
                : null;
            this.#notices.push(workspaceId, workerId, loopId, {
                source: notice.source,
                kind: notice.kind,
                message: notice.message ?? "",
                level: notice.level,
                ...(located !== null
                    ? { position: { type: "content-offset", line: located.line, column: located.column } }
                    : {}),
            });
        }
        if (allowanceCut !== null) {
            this.#notices.push(workspaceId, workerId, loopId, {
                source: "engine:capacity",
                kind: "output_truncated",
                message: allowanceCut,
                level: "warn",
            });
        }
        // {§operator-grammar} — transport evidence only: the turn records whether the operator's
        // grammar reached the wire. Nothing grades the response against it; the parser's
        // admission is the one verdict (#588).
        const railKeys = emission.railGrammar === undefined
            ? undefined
            : { railsAttached: emission.railEvidence?.transported === true ? "client" : "withheld" };
        // Attach the admitted inference evidence. The turn remains open until
        // the producer-neutral admitted-turn executor settles every operation
        // and its exact source artifact.
        const packet = StoredPacket.admit(request.packet, packetAssistant, response.assistantRaw);
        await this.#recordInference({
            workspaceId, workerId, loopId, turnId: request.turnId,
            evidence: {
                packet: StoredPacket.stringify(packet),
                sections: StoredPacket.sections(packet),
                usageCurationBudget: this.#packets.curationBudgetFor(request.packet), // {§tokenomics-client-gauge}
                finishReason: callMetadata.finishReason,
                model: callMetadata.model,
                // Opaque provider metadata plus the grammar transport key.
                // {§meta-passthrough}, {§operator-grammar}
                meta: JSON.stringify({ ...(response.meta ?? {}), ...(railKeys ?? {}) }),
            },
        });
    }

    // Phase 6 — the admitted program runs under the workspace's command ceiling and
    // the turn settles on the executor's verdict.
    async #settleAdmittedTurn(args: TurnArgs, request: TurnRequest, emission: ProviderEmission): Promise<EngineTurnResult> {
        const { childProvider, workspaceId, workerId, loopId, onDispatch, onSettled } = args;
        const { split } = emission;
        // {§operator-config-workspace-max-commands} — workspace maxCommands
        // narrows the operator ceiling before the admitted program reaches the
        // shared executor.
        const maxCommands = Math.min(readMaxCommands(), (await WorkspaceSettings.read(this.#db, workspaceId)).maxCommands ?? Number.POSITIVE_INFINITY);
        const executed = await this.executeAdmittedTurn({
            statements: split.packetAssistant.ops,
            source: split.sourceBacked ? split.packetAssistant.content : null,
            sourceModelCallId: emission.modelCallId,
            origin: "model",
            workspaceId,
            workerId,
            loopId,
            turnId: request.turnId,
            fromSequence: request.nextActionIndex,
            maxCommands,
            recoverableParseErrors: split.recoverableParseErrors,
            emptyTurn: split.emptyTurn,
            bare: {
                provider: childProvider,
                loopSequence: request.loopSeq,
                turnSequence: request.seq,
                signal: emission.signal,
            },
            signal: emission.signal,
            onDispatch,
            onSettled,
        });
        return turnResult(request, executed.status, {
            outcomes: executed.outcomes,
            fingerprint: executed.fingerprint,
            emptyTurn: executed.emptyTurn,
            emissionAttempts: emission.emissionAttempts,
        });
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
    #splitResponse(response: ProviderAttempt, executors: readonly string[] = []): SplitProviderResponse {
        const { assistant } = response;
        const preParsedOps = (assistant as { ops?: PlurnkStatement[] }).ops;
        const ops: PlurnkStatement[] = [];
        // Only structured operations are executable; interstitial text is not an operation.
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
                // {§fence-heading-in-body} {§interstitial-fence} — the executors this workspace can run
                // are heading tags to the parser; anything else tagged is a code block.
                const result = PlurnkParser.parse(assistant.content, { executors });
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
                            parseErrors.push({ message: err.message, line: err.line, column: err.column, source: err.source, ...(err.code === undefined ? {} : { code: err.code }) });
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
        const reasoning = assistant.reasoning ?? null;
        const notes = reasoning === null ? [] : PlurnkParser.parseReasoningNotes(reasoning);
        ops.unshift(...notes);
        if (notes.length > 0) {
            // A reasoned NOTE is an operation even when the content contains no program.
            for (let index = parseErrors.length - 1; index >= 0; index--) {
                if (parseErrors[index]!.message === PlurnkParser.NO_VALID_OPERATION) parseErrors.splice(index, 1);
            }
        }
        const sourceStatementCount = ops.filter(({ position }) => position.line > 0).length;
        const dispositions = ops.filter(TurnDisposition.is);
        const trustworthyBoundary = dispositions.length <= 1 && !hasUnparsedTail;
        // {§turn-shape} — bounded operation errors are recoverable and ride with the
        // admitted program; document-boundary failures still reject it.
        const recoverableParseErrors = trustworthyBoundary
            ? parseErrors.filter(
                (error) =>
                    error.code !== "invalid-turn-structure",
            ).toSorted(comparePosition)
            : [];
        // {§empty-turn} — no operation and no other hard error: admitted as an empty turn, never
        // resampled; its advisories ({§bare-heading-advisory}) ride as notices.
        const emptyTurn = preParsedOps === undefined
            && trustworthyBoundary
            && sourceStatementCount === 0
            && parseErrors.every((error) => error.message === PlurnkParser.NO_VALID_OPERATION);
        const emissionValid = preParsedOps !== undefined
            || emptyTurn
            || (
                trustworthyBoundary
                && sourceStatementCount > 0
                && recoverableParseErrors.length === parseErrors.length
            );
        return {
            packetAssistant: { content: assistant.content, ops, reasoning },
            sourceBacked: preParsedOps === undefined,
            callMetadata: { finishReason: assistant.finishReason, model: assistant.model },
            parseErrors,
            recoverableParseErrors: emissionValid && !emptyTurn ? recoverableParseErrors : [],
            emptyTurn,
            parseNotices,
            // The ANTLR model-turn parser is authoritative. At least one source
            // operation is required; lifecycle omission continues silently. Bounded
            // statement failures become durable operation results.
            // Boundary loss and an unparsed tail still reject
            // wholesale. Pre-parsed ops are Mock's trusted test seam.
            emissionValid,
        };
    }

    // #note12 — plugin reference docs are materialized beneath
    // worker:///_plurnk/plurnk/ by LoopDocs.

    // {§exec-poll} — an execution `<0>` is turn-scoped: abort the worker's open turn-scoped streams via their
    // owning scheme (the same registry-routed abort the total reap uses). Called at each pre-turn
    // before the turn's own spawns, so every open turn-scoped sub here is from a prior turn — it
    // never survives into the subsequent turn. Fire-and-forget: the spawn finalizes async and its
    // terminal output surfaces initially visible through the stream-delta path ({§exec-stream}).
    async #reapTurnScopedStreams(workerId: number): Promise<void> {
        const open = await this.#db.find_open_turn_scoped_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        await Promise.all(open.map(({ id }) => this.#liveSubscriptions.cancel(id)));
    }



    async executeAdmittedTurn(...args: Parameters<AdmittedTurnExecutor["executeAdmittedTurn"]>): ReturnType<AdmittedTurnExecutor["executeAdmittedTurn"]> {
        return this.#admitted.executeAdmittedTurn(...args);
    }
}
