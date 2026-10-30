import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";
import NativeContent from "./NativeContent.ts";
import { parsePath } from "@plurnk/plurnk-parser";
import { PathSyntax, UNKNOWN_POSITION } from "@plurnk/plurnk-contracts";
import type { Provider } from "@plurnk/plurnk-providers";
import type { ApplicationGauge, BareStatement, CapabilityPolicy, FindStatement, Notice, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";

// {§turn-source-resources} {§turn-source-resources}: source text and its durable turn coordinates.
export type AdmittedTextSource = { readonly content: string; readonly sessionName: string; readonly loopSeq: number; readonly turnSeq: number };
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import GitMembership from "./git-membership.ts";
import { acceptedKinds } from "./attachments.ts";
import GitState, { type GitStatusSnapshot } from "./git-state.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { EngineNotifications } from "./notifications.ts";
import { contentWeight } from "./content-weight.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
// Shared module imported by both Engine and the digest, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";
import { RECEIPT_RESERVE, reserved, type ContextFit } from "./ContextFit.ts";
import Results, { type SchemeResult } from "./results.ts";
import Turn, { type InferenceEvidence, type TurnRow } from "./Turn.ts";
import type ClientInteractions from "./ClientInteractions.ts";

// TurnRunner owns one inference cycle and any initialization turn
// that precedes provider admission; Engine retains the surrounding loop
// lifecycle and public facade.
import type NoticeChannel from "./NoticeChannel.ts";
import type ProblemLog from "./ProblemLog.ts";
import { type StrikeOutcome } from "./StrikeRail.ts";
import type PacketBuilder from "./PacketBuilder.ts";
import { type ChatMessage, type WindowOverflow } from "./PacketBuilder.ts";
import type Dispatcher from "./Dispatcher.ts";
import type { DispatchContext, DispatchResult } from "./Dispatcher.ts";
import SessionName from "./SessionName.ts";
import TurnOps from "./TurnOps.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import EmissionSplit, { DIRECTIVE } from "./EmissionSplit.ts";
import InitializationTurn from "./InitializationTurn.ts";
import ProviderAttemptRunner, {
    LOOP_TIMEOUT_REASON,
    resolveOperatorGrammarPath,
    turnResult,
    type MaterializedModelRequest,
    type ProviderEmission,
} from "./ProviderAttemptRunner.ts";

export { LOOP_TIMEOUT_REASON, resolveOperatorGrammarPath };

export type EngineProblemKind = keyof typeof ENGINE_PROBLEMS;

const assertOpenPaths = (value: unknown, source: string): string[] => {
    if (!Array.isArray(value) || !value.every((path): path is string => typeof path === "string" && path.length > 0)) {
        throw new TypeError(`${source}: expected an array of non-empty strings`);
    }
    return value;
};

// Per-emission action ceiling — OFF by default. `-1` (or unset/non-positive) = no cap:
// every generated op dispatches. Runaway degeneration is a sampler concern (repetition penalty),
// not grounds to drop already-generated work. A positive value is an operator ceiling a
// workspace's maxCommands may tighten (min wins), never widen
// ({§operator-config-workspace-settings}).
const readMaxCommands = (): number => {
    const raw = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    if (raw === undefined || raw.length === 0) return Number.POSITIVE_INFINITY;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return Number.POSITIVE_INFINITY;
    return n;
};

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import TurnMaterialization from "./TurnMaterialization.ts";
import BareBatchRunner from "./BareBatchRunner.ts";
import { TURN_STATUS_IMPLICIT_CONTINUE, outputAllowance, type ENGINE_PROBLEMS, type OutputCut } from "./turn-signals.ts";
import AdmittedTurnExecutor from "./AdmittedTurnExecutor.ts";

// {§tokenomics} — a request through the room: the wire the provider assessed, or the overflow
// that ends the loop.
type AdmittedRequest =
    | { readonly request: TurnRequest; readonly wire: MaterializedModelRequest; readonly overflow: null }
    | { readonly request: TurnRequest; readonly wire: null; readonly overflow: WindowOverflow };

export type EngineTurnResult = {
    createdTurnIds: number[];
    turnId: number;
    status: number;
    outcomes: StrikeOutcome[];
    progressed: boolean;
    fingerprint: string;
    capacityHardStop: boolean;
    // {§engine-rails} — the recovery budget is spent: the loop parks instead of failing.
    providerParked: boolean;
    providerFailure?: SchemeResult;
    emptyTurn: boolean;
    // {§operation-results} — the allowance ended the turn's final emission; null when it did not.
    outputCut: OutputCut | null;
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
    readonly progressed: boolean;
    readonly fingerprint: string;
    readonly emptyTurn: boolean;
};

// {§tokenomics} — the window's one terminal: the packet exceeds the model's window.
const WINDOW_OVERFLOW_DETAIL = "Context window overflow: the packet exceeds the model's window.";

const windowOverflowFailure = (overflow: WindowOverflow): SchemeResult => Results.failure(
    "engine:context",
    "window-overflow",
    413,
    WINDOW_OVERFLOW_DETAIL,
    {},
    { tokens: overflow.tokens, budget: overflow.budget, wall: overflow.wall, excess: overflow.excess },
);

// {§tokenomics} — over budget is a row and a request: the row is how the model hears it.
// {§tokenomics} — the row is the mandate; the gauge is the one home for the numbers
// ({§tokenomics}), which the row's own charge would otherwise put out of agreement.
const OVER_BUDGET_DETAIL = "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn.";
// {§operation-results} — said once, in the next packet, of a continuing turn that carried no NOTE.
const CONTINUED_WITHOUT_NOTE = "The turn continued without a NOTE.";
const overBudgetFailure = (): SchemeResult => Results.failure("engine:context", "packet-exceeds-budget", 413, OVER_BUDGET_DETAIL);

const INVALID_EMISSION_RECOVERY_MESSAGE = "Response rejected before dispatch; no operations were performed.";

// {§operation-results} — THE single derivation of a ceiling cut: a
// `length` finish is the engine's own allowance ending the emission, and it
// outranks every other diagnosis (parser symptom, rails verdict) on every
// path. Null means the emission was not cut by the allowance.
const outputCut = ({ split, response }: ProviderEmission, provider: Provider): OutputCut | null =>
    split.callMetadata.finishReason !== "length"
        ? null
        : { grant: response.capacity.responseMax ?? provider.outputBudget };

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
export type TurnArgs = {
    readonly provider: Provider;
    readonly childProvider: Provider;
    readonly messages: ChatMessage[];
    readonly recap: string;
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly loopId: number;
    readonly signal: AbortSignal | undefined;
    readonly onDispatch: ((logEntryId: number) => void) | undefined;
    readonly onSettled: ((logEntryId: number) => void | Promise<void>) | undefined;
    readonly turnNumber: number;
    readonly invalidEmissionRecoveryEntryId: number | null | undefined;
};

// Phase 1 — the producer-neutral turn container: the turns opened for this cycle
// and the initialization plan the session's first turn executes. The model turn is
// opened here only when no initialization turn precedes it.
type TurnContainer = {
    readonly sessionName: string;
    readonly transientOpenLogEntryId: number | null;
    readonly loopSequence: number;
    readonly createdTurnIds: number[];
    readonly initializationTurn: TurnRow | null;
    readonly initializationPolicies: CapabilityPolicy[];
    readonly initializationStatements: Array<FindStatement | ReadStatement>;
    readonly modelTurn: TurnRow | null;
    readonly systemCtx: PlurnkSchemeContext;
};

// What packet assembly reads from the turn; the fit test rebuilds from the same facts ({§tokenomics}).
type PacketFacts = {
    readonly turnId: number;
    readonly seq: number;
    readonly gitStatus: GitStatusSnapshot | null;
    readonly notices: Notice[];
    readonly transientOpenLogEntryId: number | null;
};

// Phase 3 — the model request: the inference turn's identity, its action cursor and
// the packet, which admission rebuilds ({§tokenomics}) and the attempt loop re-attributes per call.
export type TurnRequest = PacketFacts & {
    // {§tokenomics} — the measure every row this turn lands is tested against.
    readonly fit: ContextFit;
    readonly createdTurnIds: number[];
    readonly sessionName: string;
    readonly loopSeq: number;
    readonly systemCtx: PlurnkSchemeContext;
    nextActionIndex: number;
    packet: RequestPacket;
};
export default class TurnRunner {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #mimetypes: Mimetypes;
    readonly #weighContent: (text: string) => number;
    readonly #notices: NoticeChannel;
    readonly #problems: ProblemLog;
    readonly #packets: PacketBuilder;
    readonly #dispatcher: Dispatcher;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #notify: EngineNotifications;
    readonly #executors: () => ExecutorRegistry | undefined;
    readonly #capabilities: CapabilityResolver;
    readonly #loopSignal: (loopId: number) => AbortSignal | undefined;
    readonly #interactions: ClientInteractions;
    readonly #warmWorkspace: WarmWorkspace;
    readonly #dispatch: TurnDispatch;
    readonly #loopGauge: (loopId: number) => Promise<ApplicationGauge>;
    readonly #materialization: TurnMaterialization;
    readonly #bareBatch: BareBatchRunner;
    readonly #admitted: AdmittedTurnExecutor;
    readonly #providerAttempts: ProviderAttemptRunner;

    constructor({
        db,
        schemes,
        mimetypes,
        weigh,
        notices,
        problems,
        packets,
        dispatcher,
        liveSubscriptions,
        notify,
        executors,
        loopSignal,
        interactions,
        warmWorkspace,
        dispatch,
        resolveSessionProviderIdentity,
        loopGauge,
    }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        weigh: (text: string) => number;
        notices: NoticeChannel;
        problems: ProblemLog;
        packets: PacketBuilder;
        dispatcher: Dispatcher;
        liveSubscriptions: LiveSubscriptions;
        notify: EngineNotifications;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        interactions: ClientInteractions;
        warmWorkspace: WarmWorkspace;
        dispatch: TurnDispatch;
        resolveSessionProviderIdentity: (sessionId: number) => Promise<{ sessionId: string }>;
        loopGauge: (loopId: number) => Promise<ApplicationGauge>;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#mimetypes = mimetypes;
        this.#weighContent = weigh;
        this.#notices = notices;
        this.#problems = problems;
        this.#packets = packets;
        this.#dispatcher = dispatcher;
        this.#liveSubscriptions = liveSubscriptions;
        this.#notify = notify;
        this.#executors = executors;
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
        this.#loopSignal = loopSignal;
        this.#interactions = interactions;
        this.#warmWorkspace = warmWorkspace;
        this.#dispatch = dispatch;
        this.#loopGauge = loopGauge;
        this.#providerAttempts = new ProviderAttemptRunner({
            db: this.#db,
            schemes: this.#schemes,
            mimetypes: this.#mimetypes,
            notices: this.#notices,
            problems: this.#problems,
            packets: this.#packets,
            notify: this.#notify,
            executors: this.#executors,
            loopSignal: this.#loopSignal,
            resolveSessionProviderIdentity,
            recordInference: (inferenceArgs) => this.#recordInference(inferenceArgs),
        });
        this.#materialization = new TurnMaterialization({ db: this.#db, weighContent: this.#weighContent, mimetypes: this.#mimetypes });
        this.#bareBatch = new BareBatchRunner({ db: this.#db, providerAttributions: (p, ctx) => this.#providerAttempts.providerAttributions(p, ctx), providerFailure: ProviderAttemptRunner.providerFailure });
        this.#admitted = new AdmittedTurnExecutor({ db: this.#db, schemes: this.#schemes, notices: this.#notices, problems: this.#problems, dispatcher: this.#dispatcher, bareBatch: this.#bareBatch });
    }

    async #recordInference(args: {
        workspaceId: number;
        sessionId: number;
        loopId: number;
        turnId: number;
        evidence: InferenceEvidence;
    }): Promise<void> {
        await Turn.recordInference(this.#db, args.turnId, args.evidence);
        if (this.#notify.loopPacketNotify === undefined) return;
        const packetCount = await this.#db.engine_loop_packet_count.get<{
            count: number; id: number; sequence: number;
        }>({ loop_id: args.loopId });
        if (packetCount === undefined) throw new Error(`loop ${args.loopId}: packet count row missing`);
        // {§tokenomics} The turn's inference is recorded: its packet and its call are the gauge now.
        const gauge = await this.#loopGauge(args.loopId);
        this.#notify.loopPacketNotify(args.workspaceId, {
            sessionId: args.sessionId,
            loopId: args.loopId,
            loopSeq: packetCount.sequence,
            packetCount: packetCount.count,
            gauge,
        });
    }

    // {§turn-record}: cancellation must be the cause, not merely concurrent.
    static #failureStatus(cause: unknown, signal: AbortSignal | undefined): 499 | 500 | 504 {
        if (signal?.aborted !== true) return 500;
        const seen = new Set<unknown>();
        let current = cause;
        while (!seen.has(current)) {
            if (current === signal.reason) return signal.reason === LOOP_TIMEOUT_REASON ? 504 : 499;
            if (!(current instanceof Error) || current instanceof AggregateError) break;
            seen.add(current);
            current = current.cause;
        }
        return 500;
    }

    // {§log-wire-format}: native parts come from the READ's immutable snapshot,
    // never from a source that may have changed since the observation.
    async #wireMessages(packet: RequestPacket, ctx: PlurnkSchemeContext, provider: Provider): Promise<MaterializedModelRequest> {
        const accepted = acceptedKinds(provider.inputModalities);
        if (accepted.length === 0 || !(packet.attachments ?? []).some((attachment) => accepted.includes(attachment.kind))) {
            return {
                messages: PacketWire.packetToWireMessages(packet),
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
        provider, childProvider = provider, messages, recap = "", workspaceId, sessionId, loopId, signal, onDispatch, onSettled,
        turnNumber = 1, invalidEmissionRecoveryEntryId,
    }: {
        provider: Provider;
        childProvider?: Provider;
        messages: ChatMessage[];
        // Optional Recap override; packet assembly owns default sourcing.
        recap?: string;
        workspaceId: number; sessionId: number; loopId: number;
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
            provider, childProvider, messages, recap, workspaceId, sessionId, loopId, signal, onDispatch, onSettled,
            turnNumber, invalidEmissionRecoveryEntryId,
        };
        const createdTurnIds: number[] = [];
        const turnSignal = this.#loopSignal(loopId) ?? signal;
        try {
            const container = await this.#openTurnContainer(args, createdTurnIds);
            const gitStatus = await this.#deriveWorkspace(args, container.systemCtx);
            if (container.initializationTurn !== null) {
                const { initializationTurn, initializationPolicies, sessionName, transientOpenLogEntryId } = container;
                const initializationStatements = await InitializationTurn.guidanceStatements(this.#db, workspaceId, sessionName);
                await InitializationTurn.run({
                    db: this.#db,
                    schemes: this.#schemes,
                    executors: this.#executors,
                    capabilities: this.#capabilities,
                    dispatcher: this.#dispatcher,
                    executeAdmittedTurn: this.executeAdmittedTurn.bind(this),
                    workspaceId,
                    sessionId,
                    loopId,
                    sessionName,
                    initializationTurn,
                    initializationPolicies,
                    initializationStatements,
                    fit: this.#fitFor(args, { turnId: initializationTurn.id, seq: initializationTurn.sequence, gitStatus, notices: [], transientOpenLogEntryId }),
                    signal: this.#loopSignal(loopId),
                    onDispatch,
                    onSettled,
                });
            }
            const composed = await this.#composeRequest(args, container, gitStatus);
            const admitted = await this.#admitPacket(args, composed);
            // {§tokenomics} — only the window ends a loop.
            if (admitted.overflow !== null) return await this.#failCuration(admitted.request, admitted.overflow);
            const request = admitted.request;
            const attempts = await this.#providerAttempts.prepareProviderAttempts(args, request, admitted.wire);
            let emission: ProviderEmission;
            try {
                emission = await this.#providerAttempts.attemptProvider(args, request, attempts);
            } catch (error) {
                return await this.#providerAttempts.settleProviderFailure(error, args, request, attempts);
            }
            if (!emission.split.emissionValid) return await this.#rejectExhaustedEmission(args, request, emission);
            await this.#recordAdmittedEmission(args, request, emission);
            return await this.#settleAdmittedTurn(args, request, emission);
        } catch (cause) {
            const status = TurnRunner.#failureStatus(cause, turnSignal);
            const completionFailures: unknown[] = [];
            for (const createdTurnId of createdTurnIds) {
                try {
                    await Turn.failOpen(this.#db, createdTurnId, status);
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
        const { workspaceId, sessionId, loopId, invalidEmissionRecoveryEntryId } = args;
        const sessionName = await SessionName.forId(this.#db, sessionId);
        const transientOpenLogEntryId = typeof invalidEmissionRecoveryEntryId === "number"
            ? invalidEmissionRecoveryEntryId
            : null;
        const initialSequence = await this.#db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        if (initialSequence === undefined) throw new Error("Engine.runTurn: next turn sequence is unavailable");
        // Turn-0 foists that belong to the Session (catalog preview, AGENTS) gate
        // on its first inference history, not on loop sequence: honest client or
        // runtime administrative turns may precede the first provider exchange.
        // Per-loop foists such as the initial message's publication
        // ({§message-arrival}) fire once per loop: the inbox row's publication state,
        // rather than the model-turn ordinal, prevents an overflow diversion from
        // replaying a message and its automatic path READs.
        const loopSequence = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId }))?.sequence ?? loopId;
        const priorInference = await this.#db.engine_session_has_inference_history.get<{ present: number }>({
            session_id: sessionId,
        });
        const sessionFirstInference = priorInference?.present === 0;
        // {§session-initialization-entry} — turn zero is an ordinary `_plurnk`
        // operation turn. Its model-facing zero is a phase label; durable turn
        // coordinates remain one-based.
        const initializationTurn = initialSequence.next === 1 && sessionFirstInference
            ? await Turn.open(this.#db, { loopId, producer: "_plurnk", kind: "initialization" })
            : null;
        if (initializationTurn !== null) createdTurnIds.push(initializationTurn.id);
        const initializationPolicies = initializationTurn === null
            ? []
            : (await this.#capabilities.layers(workspaceId, sessionId)).map((layer) => layer.policy);
        const modelTurn = initializationTurn === null
            ? await Turn.open(this.#db, { loopId, producer: "model", kind: "inference" })
            : null;
        if (modelTurn !== null) createdTurnIds.push(modelTurn.id);
        // {§env-delta} — creation atomically owns the ordinary session
        // baseline or fork snapshot. Packet assembly consumes, never invents,
        // that durable observation boundary.
        const ambientCursor = await this.#db.engine_initialize_ambient_cursor.get<{
            ambient_event_cursor: number | null;
        }>({ workspace_id: workspaceId, session_id: sessionId });
        if (ambientCursor?.ambient_event_cursor === null || ambientCursor === undefined) {
            throw new Error(`session ${sessionId} has no durable ambient observation boundary`);
        }
        const systemCtx = this.#schemeContext(args, initializationTurn?.id ?? modelTurn!.id);
        return {
            sessionName, transientOpenLogEntryId, loopSequence, createdTurnIds,
            initializationTurn, initializationPolicies, initializationStatements: [],
            modelTurn, systemCtx,
        };
    }

    // The `_plurnk` scheme context for one turn. Threaded per turn, never engine
    // state, so concurrent loops on different providers each read their own honest
    // tokenizer values.
    #schemeContext({ workspaceId, sessionId, loopId }: TurnArgs, turnId: number): PlurnkSchemeContext {
        return {
            db: this.#db, workspaceId, sessionId, loopId, turnId,
            writer: "_plurnk",
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#notify.streamEventNotify,
            wakeSessionNotify: this.#notify.wakeSessionNotify,
            weigh: this.#weighContent,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s, workspaceId),
            pushNotice: (notice) => this.#notices.push(workspaceId, sessionId, loopId, notice),
            requestInteraction: (request, signal = this.#loopSignal(loopId)) => this.#interactions.request(
                request,
                { workspaceId, sessionId, loopId, turnId },
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
        // {§packet-inject} — one post-reconciliation snapshot supplies both
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

    // Phase 3 — the inference turn and its request: the prompts the model has not
    // seen, their open-path READs, the ambient and stream deltas, then the packet
    // ({§packet}).
    async #composeRequest(args: TurnArgs, container: TurnContainer, gitStatus: GitStatusSnapshot | null): Promise<TurnRequest> {
        const { workspaceId, sessionId, loopId } = args;
        // Initialization is a complete preceding turn, not a set of rows
        // interleaved with the model boundary. The engine may now acquire the
        // inference turn inside the same warmed workspace cycle.
        const modelTurn = container.modelTurn ?? await Turn.open(this.#db, { loopId, producer: "model", kind: "inference" });
        if (container.modelTurn === null) container.createdTurnIds.push(modelTurn.id);
        const { id: turnId, sequence: seq } = modelTurn;
        const systemCtx = this.#schemeContext(args, turnId);
        // {§tokenomics} — one measure for everything this turn lands: the budget less the packet as it
        // would render now. The drained notices join the same facts below.
        const facts: PacketFacts = { turnId, seq, gitStatus, notices: [], transientOpenLogEntryId: container.transientOpenLogEntryId };
        const fit = this.#fitFor(args, facts);
        const messages = await this.#publishMessages(args, turnId, fit);
        let nextActionIndex = await this.#readOpenPaths(args, turnId, messages.openPaths, messages.nextActionIndex, fit);
        nextActionIndex = await this.#readUnreadSessionAgents(args, container.sessionName, turnId, nextActionIndex, fit);
        // {§env-delta} — materialize ambient observations before packet
        // composition and reserve their action indices. {§exec-stream} owns the
        // distinct byte-cursor path for this session's streams.
        // {§exec-lifetime} — a `"turn"` lifetime: reap the session's open turn-scoped streams (necessarily
        // from a prior turn — this runs before the turn's own spawns) so a `<0>` never survives into
        // the subsequent turn. The terminal output then surfaces initially visible via the stream-delta path.
        await this.#reapTurnScopedStreams(sessionId);
        const ambientEntries = await this.#materialization.materializeEnvironmentDeltas({ workspaceId, sessionId, loopId, turnId, fromSequence: nextActionIndex });
        nextActionIndex += ambientEntries.length;
        const streamEntries = await this.#materialization.materializeStreamDeltas({ workspaceId, sessionId, loopId, turnId, fromSequence: nextActionIndex, fit });
        nextActionIndex += streamEntries.length;
        await Turn.observeCompletions(this.#db, turnId);
        // {§notifications}: materialized observations are
        // ordinary committed log rows, not packet-only content.
        for (const id of [...ambientEntries, ...streamEntries]) {
            args.onDispatch?.(id);
            await args.onSettled?.(id);
        }
        // The post-reconciliation Git snapshot above is threaded into the packet
        // and every budget rebuild; overflow never shells again.
        // Notices are non-terminal observations, never operation-failure truth.
        // Drain once and thread the same set through every overflow rebuild.
        facts.notices.push(...this.#notices.drain(loopId)
            .filter((event) => (event as { level?: string }).level !== "info"));
        // Build the model request packet ({§packet}). The log build
        // queries log_entries scoped to the session, including this turn's newly
        // published message arrivals.
        const packet = await this.#buildPacket(args, facts);
        return { ...facts, fit, createdTurnIds: container.createdTurnIds, sessionName: container.sessionName, loopSeq: container.loopSequence, systemCtx, nextActionIndex, packet };
    }

    // Pre-model writes. Each message the model has not seen yet becomes an inbound `SEND`
    // row; model operations continue the same turn sequence after these rows. Returns the
    // next action index and the messages' open paths.
    // {§message-arrival}: the loop contains every message that arrived before this
    // boundary. Publish each unpublished inbox row oldest-first, exactly once, as an inbound
    // SEND row ({§message-arrival}); its selected paths ride along for the READs that follow.
    async #publishMessages(
        { workspaceId, sessionId, loopId, onDispatch, onSettled }: TurnArgs,
        turnId: number,
        fit: ContextFit,
    ): Promise<{ nextActionIndex: number; openPaths: string[] }> {
        let nextActionIndex = 1;
        const openPaths: string[] = [];
        const unpublished = await this.#db.drain_unpublished_messages_for_loop.all<{
            id: number; ordinal: number; source: string | null; body: string; open_paths: string; path: string; durable_path: string;
        }>({ loop_id: loopId });
        const selected = unpublished.map((message) => assertOpenPaths(JSON.parse(message.open_paths) as unknown, `Message ${message.id} open_paths`));
        const pendingPaths = selected.reduce((count, paths) => count + paths.length, 0);
        for (const [index, message] of unpublished.entries()) {
            openPaths.push(...selected[index]);
            const logEntryId = await this.#materialization.writeArrivalLog({
                workspaceId, sessionId, loopId, turnId, sequence: nextActionIndex++, body: message.body, source: message.source, resource: message.path,
                selfAddressed: message.source !== null && message.source === message.durable_path,
                fit: reserved(fit, unpublished.length - index - 1 + pendingPaths),
            });
            const published = await this.#db.drain_publish_message.get<{ id: number }>({ id: message.id, log_entry_id: logEntryId });
            if (published === undefined) throw new Error(`TurnRunner.#publishMessages: message ${message.id} was already published`);
            onDispatch?.(logEntryId);
            await onSettled?.(logEntryId);
        }
        return { nextActionIndex, openPaths };
    }

    // {§methods-workspace-create}: selected resources belong to the message.
    // Publish it, then dispatch ordinary core READs in that same turn;
    // missing/non-member paths retain their normal 4xx. Returns the next action index.
    async #readOpenPaths({ workspaceId, sessionId, loopId, onDispatch, onSettled }: TurnArgs, turnId: number, openPaths: string[], fromSequence: number, fit: ContextFit): Promise<number> {
        let nextActionIndex = fromSequence;
        for (const [index, raw] of openPaths.entries()) {
            const resourceRead: ReadStatement = {
                op: "READ", aside: null, lineMarker: null, matcher: null,
                target: parsePath(PathSyntax.escapeTarget(raw)),
                metadata: null,
                body: null, position: UNKNOWN_POSITION,
            };
            await this.#dispatch({
                statement: resourceRead, workspaceId, sessionId, loopId, turnId,
                sequence: nextActionIndex, origin: "_plurnk", onDispatch, onSettled,
                fit: reserved(fit, openPaths.length - index - 1),
            });
            nextActionIndex++;
        }
        return nextActionIndex;
    }

    // {§session-initialization-entry}: when session://<session>/AGENTS.md is created or updated after
    // Turn 0 (or after a fork), foist one READ of the unread revision before packet assembly.
    async #readUnreadSessionAgents(
        { workspaceId, sessionId, loopId, onDispatch, onSettled }: TurnArgs,
        sessionName: string,
        turnId: number,
        fromSequence: number,
        fit: ContextFit,
    ): Promise<number> {
        const check = await this.#db.engine_session_unread_agents.get<{ unread: number }>({
            workspace_id: workspaceId,
            session_id: sessionId,
            session_name: sessionName,
        });
        if (check?.unread !== 1) return fromSequence;
        const target: UrlPath = {
            kind: "url",
            raw: `session://${sessionName}/AGENTS.md`,
            scheme: "session",
            username: null,
            password: null,
            hostname: sessionName,
            port: null,
            pathname: "/AGENTS.md",
            query: null,
            fragment: null,
        };
        const statement: ReadStatement = {
            op: "READ",
            aside: null,
            target,
            metadata: null,
            lineMarker: null,
            matcher: null,
            body: null,
            position: UNKNOWN_POSITION,
        };
        const policies = (await this.#capabilities.layers(workspaceId, sessionId)).map((layer) => layer.policy);
        if (!this.#capabilities.allowsAcross(statement, workspaceId, policies)) return fromSequence;
        await this.#dispatch({
            statement,
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: fromSequence,
            origin: "_plurnk",
            onDispatch,
            onSettled,
            fit,
        });
        return fromSequence + 1;
    }

    async #buildPacket(args: TurnArgs, facts: PacketFacts): Promise<RequestPacket> {
        const { messages, recap, workspaceId, sessionId, loopId, provider } = args;
        return this.#packets.buildRequestPacket({
            initialMessages: messages,
            recap,
            workspaceId,
            sessionId,
            loopId,
            currentTurnSeq: facts.seq,
            provider,
            gitStatus: facts.gitStatus,
            notices: facts.notices,
            transientOpenLogEntryId: facts.transientOpenLogEntryId,
            turnId: facts.turnId,
        });
    }

    // {§tokenomics} — the budget left for one more row, measured by building the packet as it would
    // render now: every row landed so far, every KILL already honoured. Null without a budget.
    #fitFor(args: TurnArgs, facts: PacketFacts): ContextFit {
        return {
            remaining: async () => {
                const packet = await this.#buildPacket(args, facts);
                const budget = this.#packets.curationBudgetFor(packet);
                return budget === null ? null : Math.max(0, budget - packet.weight - RECEIPT_RESERVE);
            },
        };
    }

    // {§tokenomics} — one `_plurnk` error row at the head of the turn's own rows, then the
    // packet as it renders with it. The row is shown in this packet alone and retired from later ones
    // by the packet query (#1097); a later packet that is over mints its own.
    async #noteOverBudget(args: TurnArgs, request: TurnRequest): Promise<TurnRequest> {
        const { sessionId, loopId, onDispatch, onSettled } = args;
        const minted = await this.#problems.record({
            sessionId, loopId, turnId: request.turnId, sequence: request.nextActionIndex, origin: "_plurnk", source: "context",
            result: overBudgetFailure(),
        });
        onDispatch?.(minted.id);
        await onSettled?.(minted.id);
        const packet = await this.#buildPacket(args, request);
        return { ...request, nextActionIndex: request.nextActionIndex + 1, packet };
    }

    // {§tokenomics} — one request through the room: over the wall by the estimate, it ends the loop;
    // over budget, it carries one row whose own weight takes the same wall ({§tokenomics});
    // then the provider assesses the exact wire request, and an exact refusal ends the loop
    // ({§tokenomics}). The daemon never hides, folds, or strips stored rows.
    async #admitPacket(args: TurnArgs, request: TurnRequest): Promise<AdmittedRequest> {
        const { provider, loopId, signal } = args;
        let current = request;
        const estimated = this.#packets.windowOverflow(current.packet, provider);
        if (estimated !== null) return { request: current, wire: null, overflow: estimated };
        if (this.#packets.curationOverflow(current.packet) !== null) {
            current = await this.#noteOverBudget(args, current);
            const afterNote = this.#packets.windowOverflow(current.packet, provider);
            if (afterNote !== null) return { request: current, wire: null, overflow: afterNote };
        }
        const wire = await this.#wireMessages(current.packet, current.systemCtx, provider);
        const capacity = await provider.assessRequestCapacity(wire.messages, undefined, this.#loopSignal(loopId) ?? signal);
        const refused = this.#packets.exactOverflow(current.packet, capacity);
        if (refused !== null) return { request: current, wire: null, overflow: refused };
        return { request: current, wire, overflow: null };
    }

    // {§tokenomics} — the packet exceeds the model's window: the turn completes on the
    // overflow and the loop rules the terminal; no provider I/O.
    async #failCuration(request: TurnRequest, overflow: WindowOverflow): Promise<EngineTurnResult> {
        const curationFailure = windowOverflowFailure(overflow);
        await Turn.complete(this.#db, request.turnId, curationFailure.status);
        return turnResult(request, curationFailure.status, { curationFailure });
    }

    // Phase 5, refused — {§emission-admission}: every exhaustion publishes the
    // raw final response and its recovery fact; {§engine-rails} Contract Strikes rule
    // how many consecutive frame-contract violations the loop survives.
    async #rejectExhaustedEmission({ provider, workspaceId, sessionId, loopId }: TurnArgs, request: TurnRequest, emission: ProviderEmission): Promise<EngineTurnResult> {
        const { split, response } = emission;
        const { turnId } = request;
        const rejectedModelEntryId = await this.#dispatcher.writeEmissionAttempt({
            verbatim: split.packetAssistant.content,
            sessionId,
            loopId,
            turnId,
            sequence: request.nextActionIndex,
            modelCallId: emission.modelCallId,
        });
        // {§emission-admission} — the informed turn carries the parser's own
        // diagnostic and position: the model sees WHY, not only that it was refused.
        const diagnostic = split.parseErrors[0];
        const cut = outputCut(emission, provider);
        if (cut !== null) {
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:capacity",
                kind: "output_truncated",
                level: "error",
                directive: DIRECTIVE.output,
                message: `Emission truncated at ${outputAllowance(cut)}; no operations were performed.`,
            });
        } else {
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:grammar",
                kind: "invalid_emission",
                level: "error",
                directive: DIRECTIVE.emission,
                message: diagnostic === undefined
                    ? INVALID_EMISSION_RECOVERY_MESSAGE
                    : `${INVALID_EMISSION_RECOVERY_MESSAGE} Parser: ${diagnostic.message}`,
                ...(diagnostic !== undefined && diagnostic.line > 0
                    ? { position: { type: "content-offset", line: diagnostic.line, column: diagnostic.column } }
                    : {}),
            });
        }
        await this.#recordInference({ workspaceId, sessionId, loopId, turnId, evidence: this.#providerAttempts.requestEvidence(provider, request.packet, split, response) });
        await Turn.complete(this.#db, turnId, TURN_STATUS_IMPLICIT_CONTINUE);
        return turnResult(request, TURN_STATUS_IMPLICIT_CONTINUE, {
            outcomes: [{ op: null, status: 500, problemType: "https://problems.plurnk.xyz/engine/invalid-emission-exhausted" }],
            fingerprint: `frame-contract-violation:${turnId}`,
            outputCut: cut,
            emissionAttempts: emission.emissionAttempts,
            emissionExhausted: true,
            rejectedModelEntryId,
        });
    }

    // Phase 5, admitted — the emission's notices, then {§packet}: admitted
    // emission data extends the packet while provider-call metadata remains on the
    // Turn row.
    async #recordAdmittedEmission({ provider, workspaceId, sessionId, loopId }: TurnArgs, request: TurnRequest, emission: ProviderEmission): Promise<void> {
        const { split, response } = emission;
        const { packetAssistant, callMetadata, parseNotices } = split; // raw assistant content is opaque — split, never interpreted — {§provider-surface}
        for (const notice of parseNotices) {
            this.#notices.push(workspaceId, sessionId, loopId, notice);
        }
        const cut = outputCut(emission, provider);
        // {§outside-text} — a response cut at the output allowance with nothing admitted names the
        // cut, so the model reads the ceiling, never a parser symptom (#478).
        if (split.emptyTurn && cut !== null) {
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:turn",
                kind: "output_truncated",
                level: "warn",
                directive: DIRECTIVE.output,
                message: `Emission truncated at ${outputAllowance(cut)}; no authored operations were performed.`,
            });
        }
        // Non-fatal provider transport notices on an accepted turn. Forward each
        // Notice with a content-offset `line:col`;
        // the model resolves it against its own emission — READ ops://<session>/<loop>/<turn> at the
        // cited lines ({§log-history-projection}) — not an embedded snippet that would duplicate the emission.
        for (const notice of response.notices ?? []) {
            const located = typeof notice.position === "number"
                ? EmissionSplit.offsetToLineColumn(packetAssistant.content, notice.position)
                : null;
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: notice.source,
                kind: notice.kind,
                ...(notice.directive === undefined ? {} : { directive: notice.directive }),
                message: notice.message ?? "",
                level: notice.level,
                ...(located !== null
                    ? { position: { type: "content-offset", line: located.line, column: located.column } }
                    : {}),
            });
        }
        if (cut !== null) {
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:capacity",
                kind: "output_truncated",
                directive: DIRECTIVE.output,
                message: `Emission truncated at ${outputAllowance(cut)}.`,
                level: "warn",
            });
        }
        // {§outside-text} — a turn that fenced no operation keeps its text as its outside source: the
        // evidence behind the empty turn's strike and a terminal's citation; no row, notice or NOTE.
        if (split.outside !== null) {
            await Turn.recordSource(this.#db, request.turnId, "outside", split.outside, { modelCallId: emission.modelCallId });
            this.#notify.outsideEventNotify?.(workspaceId, {
                sessionId, loopId, turnId: request.turnId,
                coordinate: `${request.sessionName}-${request.loopSeq}-${request.seq}`,
                text: split.outside, tokens: contentWeight(split.outside),
            });
        }
        // {§provider-instantiation} — transport evidence only: the turn records whether the operator's
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
            workspaceId, sessionId, loopId, turnId: request.turnId,
            evidence: {
                packet: StoredPacket.stringify(packet),
                sections: StoredPacket.sections(packet),
                usageCurationBudget: this.#packets.curationBudgetFor(request.packet), // {§tokenomics}
                finishReason: callMetadata.finishReason,
                model: callMetadata.model,
                // Opaque provider metadata plus the grammar transport key.
                // {§provider-surface}, {§provider-instantiation}
                meta: JSON.stringify({ ...response.meta, ...railKeys }),
            },
        });
    }

    // Phase 6 — the admitted program runs under the workspace's command ceiling and
    // the turn settles on the executor's verdict.
    async #settleAdmittedTurn(args: TurnArgs, request: TurnRequest, emission: ProviderEmission): Promise<EngineTurnResult> {
        const { provider, childProvider, workspaceId, sessionId, loopId, onDispatch, onSettled } = args;
        const { split } = emission;
        const coordinates = { sessionName: request.sessionName, loopSeq: request.loopSeq, turnSeq: request.seq };
        // {§operator-config-workspace-settings} — workspace maxCommands
        // narrows the operator ceiling before the admitted program reaches the
        // shared executor.
        const maxCommands = Math.min(readMaxCommands(), (await WorkspaceSettings.read(this.#db, workspaceId)).maxCommands ?? Number.POSITIVE_INFINITY);
        const executed = await this.executeAdmittedTurn({
            statements: split.packetAssistant.ops,
            source: split.sourceBacked ? split.packetAssistant.content : null,
            emission: split.emissionStatements === null ? null : {
                content: TurnOps.renderEmission(split.emissionStatements),
                statements: split.emissionStatements,
                ...coordinates,
            },
            reasoning: split.packetAssistant.reasoning ? { content: split.packetAssistant.reasoning, ...coordinates } : null,
            sourceModelCallId: emission.modelCallId,
            origin: "model",
            workspaceId,
            sessionId,
            loopId,
            turnId: request.turnId,
            fromSequence: request.nextActionIndex,
            maxCommands,
            fit: request.fit,
            recoverableParseErrors: split.recoverableParseErrors,
            emptyTurn: split.emptyTurn,
            completionAllowed: split.completionAllowed,
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
        // {§operation-results} — a turn the loop continues past or parks on, having carried no NOTE
        // forward in its program or from its reasoning, is told so in the next packet, in the card's own
        // words. An empty turn has its own no-operation row instead.
        const ops = split.packetAssistant.ops;
        if ((executed.status === 102 || executed.status === 202) && ops.length > 0
            && !ops.some((statement) => "op" in statement && statement.op === "NOTE")) {
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "engine:turn", kind: "continued_without_note", level: "warn", directive: DIRECTIVE.note, message: CONTINUED_WITHOUT_NOTE,
            });
        }
        return turnResult(request, executed.status, {
            outcomes: executed.outcomes,
            progressed: executed.progressed,
            fingerprint: executed.fingerprint,
            emptyTurn: executed.emptyTurn,
            outputCut: outputCut(emission, provider),
            emissionAttempts: emission.emissionAttempts,
        });
    }

    // #note12 — extension reference docs are materialized beneath
    // plurnk:/// and mcp:/// by LoopDocs.

    // {§exec-lifetime} — a `"turn"` lifetime: abort the session's open turn-scoped streams via their
    // owning scheme (the same registry-routed abort the total reap uses). Called at each pre-turn
    // before the turn's own spawns, so every open turn-scoped sub here is from a prior turn — it
    // never survives into the subsequent turn. Fire-and-forget: the spawn finalizes async and its
    // terminal output surfaces initially visible through the stream-delta path ({§exec-stream}).
    async #reapTurnScopedStreams(sessionId: number): Promise<void> {
        const open = await this.#db.find_open_turn_scoped_subscriptions_for_session.all<{ id: number }>({ session_id: sessionId });
        await Promise.all(open.map(({ id }) => this.#liveSubscriptions.cancel(id)));
    }



    async executeAdmittedTurn(...args: Parameters<AdmittedTurnExecutor["executeAdmittedTurn"]>): ReturnType<AdmittedTurnExecutor["executeAdmittedTurn"]> {
        return this.#admitted.executeAdmittedTurn(...args);
    }
}
