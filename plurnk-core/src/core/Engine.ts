import { PlurnkParser, PlurnkParseError, UNKNOWN_POSITION } from "@plurnk/plurnk-contracts";
import { RuntimeTag } from "@plurnk/plurnk-execs";
import Owner from "./Owner.ts";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement, EditStatement, ReadStatement, UrlPath, FindStatement, ParsedPath } from "@plurnk/plurnk-contracts";

// Internal-only — collected from PlurnkParser output, then translated to
// Notice envelopes are defined by @plurnk/plurnk-contracts.
// before being pushed to the loop's notices buffer.
type ParseErrorInfo = { message: string; line: number; column: number; source: string };
const TERMINAL_SEND_SIGNALS = new Set([102, 200, 202, 300, 499]);
const comparePosition = (
    a: { line: number; column: number },
    b: { line: number; column: number },
): number => a.line - b.line || a.column - b.column;
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import Meta, { type PluginAttributionContext } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import type { EntryData } from "../schemes/_entry-crud.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import SearchIndex from "../schemes/_search-index.ts";
import { markTerminal } from "../schemes/Worker.ts";
import GitMembership, { type FsDivergence } from "./git-membership.ts";
import GitState, { type GitStatusSnapshot } from "./git-state.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import type { WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { RegistryEntry } from "./ExecutorRegistry.ts";
import type { StreamEventNotify, NoticeNotify, WakeWorkerNotify, InjectWorkerNotify, BranchWorkerNotify, BranchCompletionGate, CancelWorkerNotify, CancelDescendantsNotify } from "./ChannelWrite.ts";
import { editedSpan } from "../content/index.ts";
import { promptPathname, promptLoopPrefix, renderTarget } from "./plurnk-uri.ts";
import { rulerCount } from "./token-ruler.ts";
import SearchGate from "./search-gate.ts";
import LiveSubscriptions from "./LiveSubscriptions.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";
import Results, { OperationFailureError, type SchemeResult } from "./results.ts";
import BranchReceipt from "./BranchReceipt.ts";
import BudgetOverflow, { type BudgetOverflowMeasurement } from "./BudgetOverflow.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import JournalTurn from "./JournalTurn.ts";

// The engine's collaborators — each owns one machine; Engine owns the loop/turn
// lifecycle and wires them together as the public facade.
import NoticeChannel from "./NoticeChannel.ts";
import ProblemLog from "./ProblemLog.ts";
import StrikeRail from "./StrikeRail.ts";
import PacketBuilder, { type ChatMessage } from "./PacketBuilder.ts";
import StoredPacket, { type PacketAssistant } from "./StoredPacket.ts";
import ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalResolution, ProposalPendingEvent } from "./ProposalLifecycle.ts";
import type { ProposalProjection } from "@plurnk/plurnk-contracts";
import Dispatcher from "./Dispatcher.ts";
import type { DispatchContext, DispatchResult, ResolvedClientEntryAddress } from "./Dispatcher.ts";
import { observed, observedSync } from "../observe/spans.ts";
import { OPS_DISPATCHED, PROVIDER_CALLS, recordCounter } from "../observe/metrics.ts";
import { scheduleTurnOps } from "./turn-scheduler.ts";
import { readExecSettlementMs } from "./exec-settlement.ts";

// Proposal types are part of Engine's public API (resolveProposal/onProposalPending);
// their definitions live with the lifecycle.
export type { ProposalDecision, ProposalResolution, ProposalPendingEvent } from "./ProposalLifecycle.ts";
export type WorkspaceDerivationStatus = {
    phase: "preparing" | "indexing" | "complete" | "failed";
    completed: number;
    total: number;
    percent: number;
    message: string;
    level: "info" | "error";
};
export type AcquireWorkspaceTurn = (workspaceId: number, workerId: number) => Promise<() => void>;
export type WorkspaceTurnCompleted = (args: {
    workspaceId: number;
    workerId: number;
    loopId: number;
    turnId: number;
}) => Promise<void>;

const DEFAULT_MAX_STRIKES = 3;

const ENGINE_PROBLEMS = Object.freeze({
    max_commands_exceeded: {
        status: 429,
        code: "max-commands-exceeded",
        detail: "Later operations were not executed because the turn exceeded its operation limit.",
    },
    idle_turn: {
        status: 409,
        code: "idle-turn",
        detail: "SEND[102] was emitted without an operation to continue from.",
    },
} as const);
type EngineProblemKind = keyof typeof ENGINE_PROBLEMS;

// The prompt entry target - prompt:///<loop>/<N>, self-only ({§prompt-self-only}):
// the owner rides the owner_id column, the address carries only the loop coordinate.
const promptTarget = (loopSeq: number, turnSeq: number): UrlPath => {
    const storage = promptPathname(loopSeq, turnSeq);
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

const readMaxStrikes = (): number => {
    const raw = process.env.PLURNK_SERVICE_MAX_STRIKES;
    if (raw === undefined || raw.length === 0) return DEFAULT_MAX_STRIKES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STRIKES;
    return n;
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
// -1 = the complete one-level map; positive N caps its file rows. 0 / unset = off.
const normalizeFilesItems = (n: number): number | null => (!Number.isFinite(n) || n === 0 ? null : n < 0 ? -1 : n);
const readFilesItems = (): number | null => {
    const raw = process.env.PLURNK_SERVICE_FILES_ITEMS;
    if (raw === undefined || raw.length === 0) return null;
    return normalizeFilesItems(Number.parseInt(raw, 10));
};

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { AuthoritativeCharge, GrammarEvidence, Provider, ProviderAccountingResult, ProviderAttempt, ProviderAttemptFinishReason, ProviderCost, ProviderResponse, ProviderUsage } from "@plurnk/plurnk-providers";
import { ProviderError, providerCostFor, providerCostUsd, providerProjectedCostUsd, validateAuthoritativeCharge, validateProviderAccountingResult, validateProviderCost, scopeEnvToAlias, resolveActiveAlias } from "@plurnk/plurnk-providers";
import { validateGbnf } from "@plurnk/gbnf";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import type { RuntimeSchemeFacet } from "../server/DaemonModule.ts";

// Split-out call-metadata that travels with the parsed packet but lands in
// Turn columns instead of packet.assistant.
type TurnCallMetadata = {
    usage: ProviderUsage;
    finishReason: ProviderAttemptFinishReason;
    model: string;
};

type SplitProviderResponse = {
    packetAssistant: PacketAssistant;
    callMetadata: TurnCallMetadata;
    parseErrors: ParseErrorInfo[];
    recoverableParseErrors: ParseErrorInfo[];
    parseNotices: Notice[];
    emissionValid: boolean;
};

type EngineTurnResult = {
    turnId: number;
    status: number;
    statuses: number[];
    fingerprint: string;
    budgetStruck: boolean;
    budgetHardStop: boolean;
    steerStruck: boolean;
    emissionAttempts: number;
    emissionExhausted: boolean;
    rejectedModelEntryId?: number;
    budget?: BudgetOverflowMeasurement;
};

export type LoopScopeAccounting =
    | {
        scopeId: string;
        status: "open";
    }
    | {
        scopeId: string;
        status: "pending";
        reason: string;
        evaluatedAt?: string;
    }
    | {
        scopeId: string;
        status: "settled";
        charge: AuthoritativeCharge;
        evaluatedAt: string;
    };

export type LoopUsage = {
    promptTokens: number;
    completionTokens: number;
    costUsd: number | null;
    projectedCostUsd: number | null;
    costs: ProviderCost[];
    accounting: LoopScopeAccounting | null;
    contextTokens: number;
    promptBudget: number | null;
    meta: Record<string, unknown>;
};

// Runtime normalization for a disposition the engine refuses or resolves as a
// continue after dispatch ({§send}). Every admitted emission itself ends in an
// explicit disposition SEND ({§emission-admission}).
const TURN_STATUS_IMPLICIT_CONTINUE = 102;
const INVALID_EMISSION_RECOVERY_MESSAGE = "Your previous response contained an unrecoverable syntax error. No operations were performed. Try again.";

const DEFAULT_MIN_CYCLES = 3;
const DEFAULT_MAX_CYCLE_PERIOD = 4;

const readPositiveInt = (envVar: string, fallback: number): number => {
    const raw = process.env[envVar];
    if (raw === undefined || raw.length === 0) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return n;
};

const readEmissionAttempts = (): number => {
    const raw = process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS;
    const value = Number.parseInt(raw ?? "", 10);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`PLURNK_SERVICE_EMISSION_ATTEMPTS must be a positive integer; got ${raw}`);
    }
    return value;
};

// {§operator-config-loop-timeout} — the loop's wall-clock budget (PLURNK_SERVICE_LOOP_TIMEOUT).
const DEFAULT_LOOP_TIMEOUT_MS = 86400000;
const readLoopTimeoutMs = (): number => readPositiveInt("PLURNK_SERVICE_LOOP_TIMEOUT", DEFAULT_LOOP_TIMEOUT_MS);
// The wall's abort reason — runLoop branches a mid-turn teardown to the 504 terminal on it.
const LOOP_TIMEOUT_REASON = "loop_timeout";

export default class Engine {
    static fingerprintTurn(ops: ReadonlyArray<PlurnkStatement>): string {
        return StrikeRail.fingerprintTurn(ops);
    }

    static detectCycle(
        history: ReadonlyArray<string>,
        minCycles: number,
        maxCyclePeriod: number,
    ): { detected: false } | { detected: true; period: number; cycles: number } {
        return StrikeRail.detectCycle(history, minCycles, maxCyclePeriod);
    }

    #db: Db;
    #lifecycle: LoopLifecycle;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    // {§tokenomics-agnostic-ruler} — the stable model-independent ruler used
    // for write-time, catalog, receipt, and packet weights.
    #tokenize: (text: string) => number;
    // Boot-discovered runtime executors. Daemon builds + sets via
    // setExecutors at start(); undefined until then (and in bare tests).
    #executors: ExecutorRegistry | undefined;
    // {§send-premature-terminate}/SEND[202]<T> — park deadlines by loopId, written at dispatch (the
    // marker's seconds; -1 = indefinite), consumed by the daemon's drain park-exit to schedule
    // the deadline wake. In-memory: a daemon restart drops pending deadlines (documented).
    readonly parkDeadlines: Map<number, number> = new Map();
    // Per-turn running-worker READ obligations. {§join-blocking-collect}
    readonly joinTargets: Set<number> = new Set();

    // The collaborators. Engine constructs them (they share its deps via
    // thunks where the value is late-injected — executors, loop signals)
    // and fronts their public surface.
    #notices: NoticeChannel;
    #problems: ProblemLog;
    #strikes: StrikeRail;
    // {§grinder-hard-413-recovery} - loops granted their one over-ceiling recovery turn. Cleared on a
    // fitting turn so a later independent overflow can earn a fresh recovery, and at loop cleanup.
    #hardOverflowRecovery = new Set<number>();
    #packets: PacketBuilder;
    readonly searchGate = new SearchGate();
    #proposals: ProposalLifecycle;
    #dispatcher: Dispatcher;
    readonly #liveSubscriptions = new LiveSubscriptions();

    // Per-loop AbortController for cancellation propagation into scheme
    // ctx.signal. runLoop creates one at entry, cleans up at end. Engine
    // cancellation paths (strikes, max_turns, external) abort it.
    // Streaming schemes (exec) chain their per-spawn controllers off
    // ctx.signal so cancelled loops tear down their background spawns.
    #loopAborts = new Map<number, AbortController>();
    // {§prompt-loop-containment}: one worker's prompt-frame allocation and
    // persistence is a serial critical section. A completed later frame can
    // therefore never overtake or replace an earlier concurrent arrival.
    #promptWriteLocks = new Map<number, Promise<unknown>>();
    // One coalesced warm per workspace. Creation/membership changes start it as soon
    // as content exists; the first model turn joins it, so no operation observes
    // partial graph/vector coverage. A request arriving mid-pass marks the workspace
    // dirty and guarantees one final exhaustive rescan.
    #workspaceWarms = new Map<number, {
        dirty: boolean;
        materialize: boolean;
        ctx: PlurnkSchemeContext;
        abort: AbortController;
        promise: Promise<void>;
    }>();
    #workspaceWarmStatus = new Map<number, WorkspaceDerivationStatus>();

    #queueWorkspaceWarm(ctx: PlurnkSchemeContext, invalidate = true, materialize = true): Promise<void> {
        const workspaceId = ctx.workspaceId;
        const existing = this.#workspaceWarms.get(workspaceId);
        if (existing !== undefined) {
            if (invalidate) existing.dirty = true;
            if (materialize) existing.materialize = true;
            existing.ctx = ctx;
            return existing.promise;
        }
        if (!invalidate && this.#workspaceWarmStatus.get(workspaceId)?.phase === "complete") {
            return Promise.resolve();
        }

        const state = {
            dirty: false,
            materialize,
            ctx,
            abort: new AbortController(),
            promise: Promise.resolve(),
        };
        // Register before publishing the first synchronous Notice. A
        // listener may request another warm from that callback; it must join
        // this state rather than opening a second pump in the re-entrant gap.
        this.#workspaceWarms.set(workspaceId, state);
        const publish = (current: PlurnkSchemeContext, status: WorkspaceDerivationStatus): void => {
            this.#workspaceWarmStatus.set(workspaceId, status);
            current.pushNotice?.({
                source: "engine:derivation", kind: "embed_progress", ...status,
            });
        };
        const promise = (async () => {
            do {
                state.dirty = false;
                const shouldMaterialize = state.materialize;
                state.materialize = false;
                const current = state.ctx;
                publish(current, {
                    phase: "preparing",
                    message: "Preparing repository content for semantic indexing",
                    completed: 0, total: 1, percent: 0, level: "info",
                });
                try {
                    const signal = current.signal === undefined
                        ? state.abort.signal
                        : AbortSignal.any([current.signal, state.abort.signal]);
                    const cancellable = { ...current, signal };
                    if (shouldMaterialize) await GitMembership.indexGitMembership(cancellable);
                    await SearchIndex.maintain({
                        ...cancellable,
                        pushNotice: (notice) => {
                            if (notice.kind === "embed_progress"
                                && typeof notice.completed === "number"
                                && typeof notice.total === "number"
                                && typeof notice.percent === "number") {
                                this.#workspaceWarmStatus.set(workspaceId, {
                                    phase: "indexing",
                                    completed: notice.completed,
                                    total: notice.total,
                                    percent: notice.percent,
                                    message: notice.message ?? "Indexing repository semantics",
                                    level: notice.level === "error" ? "error" : "info",
                                });
                            }
                            current.pushNotice?.(notice);
                        },
                    });
                } catch (error) {
                    publish(current, {
                        phase: "failed",
                        message: `Semantic indexing failed: ${error instanceof Error ? error.message : String(error)}`,
                        completed: 0, total: 1, percent: 0, level: "error",
                    });
                    throw error;
                }
            } while (state.dirty);

            publish(state.ctx, {
                phase: "complete",
                message: "Repository semantic index is ready",
                completed: 1, total: 1, percent: 100, level: "info",
            });
        })().finally(() => {
            if (this.#workspaceWarms.get(workspaceId) === state) this.#workspaceWarms.delete(workspaceId);
        });
        state.promise = promise;
        return promise;
    }

    workspaceDerivationStatus(workspaceId: number): WorkspaceDerivationStatus | null {
        return this.#workspaceWarmStatus.get(workspaceId) ?? null;
    }

    cancelDerivations(reason: unknown = new DOMException("derivations cancelled", "AbortError")): void {
        for (const state of this.#workspaceWarms.values()) {
            if (!state.abort.signal.aborted) state.abort.abort(reason);
        }
    }

    // Awaited by Daemon.stop before the db closes. Shutdown supplies the exact
    // cancellation reason it owns; every unrelated failure remains visible.
    async drainDerivations(ignoredReason?: unknown): Promise<void> {
        const results = await Promise.allSettled(
            [...this.#workspaceWarms.values()].map((state) => state.promise),
        );
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason])
            .filter((error) => error !== ignoredReason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "derivation drain failed");
    }

    async drainWorkspaceDerivations(workspaceId: number): Promise<void> {
        await this.#workspaceWarms.get(workspaceId)?.promise;
    }

    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly #acquireWorkspaceTurn: AcquireWorkspaceTurn;
    readonly #workspaceTurnCompleted: WorkspaceTurnCompleted | undefined;

    // Configured grammar text is cached by variant after its first load.
    #gbnfCache = new Map<string, string>();

    // {§rail-truth-engine-verdict} — the verify GAP (a configured grammar @plurnk/gbnf can't
    // parse): warn once per message, never per turn; the turn records railsVerdict "unverifiable".
    static #railGapWarned = new Set<string>();
    static #warnRailVerdictGapOnce(message: string): void {
        if (Engine.#railGapWarned.has(message)) return;
        Engine.#railGapWarned.add(message);
        process.stderr.write(`plurnk-engine: rail verdict unavailable — the configured grammar did not parse in @plurnk/gbnf (${message})\n`);
    }

    static #requireGrammarEvidence(response: ProviderResponse): GrammarEvidence {
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
        return evidence;
    }

    constructor({ db, schemes, mimetypes, streamEventNotify, wakeWorkerNotify, injectWorker, branchWorker, branchCompletionGate, cancelWorker, cancelDescendants, acquireWorkspaceTurn, workspaceTurnCompleted, noticeNotify, tokenize }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes?: Mimetypes;
        streamEventNotify?: StreamEventNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        injectWorker?: InjectWorkerNotify;
        branchWorker?: BranchWorkerNotify;
        branchCompletionGate?: BranchCompletionGate;
        cancelWorker?: CancelWorkerNotify;
        cancelDescendants?: CancelDescendantsNotify;
        acquireWorkspaceTurn?: AcquireWorkspaceTurn;
        workspaceTurnCompleted?: WorkspaceTurnCompleted;
        noticeNotify?: NoticeNotify;
        tokenize?: (text: string) => number;
    }) {
        this.#db = db;
        this.#lifecycle = new LoopLifecycle(db);
        this.#schemes = schemes;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#acquireWorkspaceTurn = acquireWorkspaceTurn ?? (async () => () => {});
        this.#workspaceTurnCompleted = workspaceTurnCompleted;
        // Default to empty discovery — standalone Engine construction (in
        // tests) gets no handlers, and content flows through the framework's
        // raw-content fitContent fallback. Daemon-managed Engine receives a
        // production-configured Mimetypes via the constructor arg.
        this.#mimetypes = mimetypes ?? new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map(), skipped: [] },
        });
        // {§tokenomics-agnostic-ruler} — standalone construction and the daemon
        // use the same default; provider counting is confined to physical admission.
        this.#tokenize = tokenize ?? rulerCount;

        const executors = (): ExecutorRegistry | undefined => this.#executors;
        const loopSignal = (loopId: number): AbortSignal | undefined => this.#loopAborts.get(loopId)?.signal;
        this.#notices = new NoticeChannel({ notify: noticeNotify });
        this.#problems = new ProblemLog(db);
        this.#strikes = new StrikeRail();
        this.#packets = new PacketBuilder({
            db,
            schemes,
            problems: this.#problems,
            executors,
        });
        this.#proposals = new ProposalLifecycle({
            db, schemes, notices: this.#notices,
            streamEventNotify, wakeWorkerNotify,
            tokenize: this.#tokenize, mimetypes: this.#mimetypes, executors, loopSignal,
            liveSubscriptions: this.#liveSubscriptions,
        });
        this.#dispatcher = new Dispatcher({ searchGate: this.searchGate,
            db, schemes, mimetypes: this.#mimetypes,
            tokenize: this.#tokenize,
            notices: this.#notices, proposals: this.#proposals,
            executors, loopSignal,
            streamEventNotify, wakeWorkerNotify, injectWorker, branchWorker, branchCompletionGate, cancelWorker, cancelDescendants,
            parkDeadlines: this.parkDeadlines,
            joinTargets: this.joinTargets,
            liveSubscriptions: this.#liveSubscriptions,
        });
        schemes.bindCore({
            db,
            mimetypes: this.#mimetypes,
            executors,
            tokenize: this.#tokenize,
            streamEventNotify,
            wakeWorkerNotify,
            injectWorker,
            pushNotice: (workspaceId, loopId, notice) => this.#notices.push(workspaceId, loopId, notice),
            defaultChannelFor: (scheme) => schemes.defaultChannelFor(scheme),
            readExecSource: (statement, ctx) => this.#dispatcher.readExecSource(statement, ctx),
            liveSubscriptions: this.#liveSubscriptions,
        });
    }

    // Late injection: the executor registry is async-built at daemon start()
    // (discover + probe), after Engine construction.
    setExecutors(executors: ExecutorRegistry): void {
        this.#executors = executors;
    }

    // Register a module-owned runtime on the same two registries as boot discovery.
    // An optional same-name scheme handler lets one capability own both execution
    // and addressable state without teaching core its protocol.
    registerRuntime(tag: string, entry: RegistryEntry, scheme?: RuntimeSchemeFacet): void {
        if (this.#executors === undefined) throw new Error("registerRuntime: executor registry not wired yet");
        RuntimeTag.assert(tag, "module runtime");
        // Preflight both owners before either write; synchronous registration
        // then cannot leave a half-claimed namespace. {§plugin-namespace-arbitration}
        this.#executors.assertCanRegister(tag, entry.namespaceOwner);
        this.#schemes.assertRuntimeClaim(tag, entry.namespaceOwner);
        this.#schemes.registerRuntimeScheme(tag, entry.executor, entry.namespaceOwner, scheme);
        this.#executors.register(tag, entry);
    }

    // Supply an explicitly configured local constraint; ANTLR remains the
    // language authority. {§grammar-enforcement-verified-at-boot}
    async #grammarConstraint(provider: Provider): Promise<string | undefined> {
        // Resolve through the registered or active alias; ambiguity and load
        // failures never degrade to unconstrained generation.
        // {§grammar-enforcement-verified-at-boot}
        const registered = ProviderInstantiate.aliasOf(provider);
        const fallback = registered === undefined ? resolveActiveAlias(process.env)?.alias : undefined;
        if (registered === undefined && fallback === undefined && Object.keys(process.env).some((k) => k.startsWith("PLURNK_PROVIDERS_GBNF_"))) {
            throw new Error("GBNF constraint: provider has no registered alias and no active alias resolves, while per-alias PLURNK_PROVIDERS_GBNF_* constraints are configured");
        }
        const alias = registered ?? fallback ?? "";
        const variant = scopeEnvToAlias(process.env, alias, ["PLURNK_PROVIDERS_GBNF"]).PLURNK_PROVIDERS_GBNF;
        if (variant === undefined || variant === "" || variant === "0") return undefined;
        const hit = this.#gbnfCache.get(variant);
        if (hit !== undefined) return hit;
        const path = variant.startsWith("/") || variant.startsWith(".")
            ? variant
            : fileURLToPath(import.meta.resolve(`@plurnk/plurnk-contracts/${variant}`));
        const text = await readFile(path, "utf8");  // unresolvable/unreadable throws — a configured rail never silently degrades
        this.#gbnfCache.set(variant, text);
        process.stderr.write(`plurnk-engine: GBNF constraint: ${alias || "(bare)"} → ${variant} (${text.length} chars)\n`);
        return text;
    }

    // A lineage's no-parent root; a root worker resolves to itself. Fail hard
    // when corruption leaves a worker without one. {§worker-primary}
    async resolveWorkerPrimary(workerId: number): Promise<number> {
        const root = await this.#db.engine_worker_lineage_root.get<{ id: number }>({ worker_id: workerId });
        if (root === undefined) throw new Error(`resolveWorkerPrimary: worker ${workerId} has no lineage root — corrupt parent chain`);
        return root.id;
    }

    promptBudgetFor(provider: Provider): number | null {
        return this.#packets.promptBudgetFor(provider);
    }

    async #attemptAttributions(
        provider: Provider,
        context: PluginAttributionContext,
    ): Promise<string[]> {
        const tags = Meta.composeAttributions(
            this.#schemes.attributions(context),
            this.#executors?.attributions(context) ?? [],
            await this.#mimetypes.attributions(context),
            provider.attributions?.(context) ?? [],
        );
        return [...tags];
    }

    // {§attribution} — reporting derives from exact provider-request evidence;
    // malformed durable tags fail here instead of being silently filtered.
    async loopAttributions(loopId: number): Promise<string[]> {
        const rows = await this.#db.engine_loop_attributions.all<{ attribution: unknown }>({ loop_id: loopId });
        const tags = rows.map(({ attribution }, index) => {
            if (typeof attribution !== "string" || attribution.length === 0) {
                throw new TypeError(`loop ${loopId} attribution row ${index} is not a non-empty string`);
            }
            return attribution;
        });
        return [...Meta.composeAttributions(tags)];
    }

    // Loop totals are billing evidence; the latest-turn pair is the client
    // occupancy gauge. {§tokenomics-client-gauge}, {§notifications-loop-terminated}
    async loopUsage(loopId: number): Promise<LoopUsage> {
        const row = await this.#db.engine_loop_usage.get<{
            prompt: number;
            completion: number;
            cost_usd: number | null;
            costs: string | null;
            context: number | null;
            context_size: number | null;
            meta: string | null;
            accounting_scope_id: string;
            accounting_state: "unscoped" | "open" | "pending" | "settled";
            accounting_charge: string | null;
            accounting_detail: string | null;
            accounting_evaluated_at: string | null;
        }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loopUsage: loop ${loopId} does not exist`);
        const parsedCosts: unknown = JSON.parse(row?.costs ?? "[]");
        if (!Array.isArray(parsedCosts)) throw new TypeError(`loop ${loopId} monetary evidence is not an array`);
        const costs = parsedCosts.map((cost) => validateProviderCost(cost as ProviderCost));
        const projectedCosts = costs.map(providerProjectedCostUsd);
        let accounting: LoopScopeAccounting | null;
        switch (row.accounting_state) {
            case "unscoped":
                accounting = null;
                break;
            case "open":
                accounting = { scopeId: row.accounting_scope_id, status: "open" };
                break;
            case "pending":
                if (row.accounting_detail === null) {
                    throw new TypeError(`loop ${loopId} pending accounting has no reason`);
                }
                accounting = {
                    scopeId: row.accounting_scope_id,
                    status: "pending",
                    reason: row.accounting_detail,
                    ...(row.accounting_evaluated_at === null ? {} : { evaluatedAt: row.accounting_evaluated_at }),
                };
                break;
            case "settled": {
                if (row.accounting_charge === null || row.accounting_evaluated_at === null) {
                    throw new TypeError(`loop ${loopId} settled accounting lacks charge evidence`);
                }
                const charge = validateAuthoritativeCharge(JSON.parse(row.accounting_charge) as AuthoritativeCharge);
                if (providerCostUsd(charge) !== row.cost_usd) {
                    throw new TypeError(`loop ${loopId} settled accounting disagrees with its USD rollup`);
                }
                accounting = {
                    scopeId: row.accounting_scope_id,
                    status: "settled",
                    charge,
                    evaluatedAt: row.accounting_evaluated_at,
                };
                break;
            }
            default:
                throw new TypeError(`loop ${loopId} has invalid accounting state ${String(row.accounting_state)}`);
        }
        return {
            promptTokens: row?.prompt ?? 0,
            completionTokens: row?.completion ?? 0,
            costUsd: row?.cost_usd ?? null,
            projectedCostUsd: projectedCosts.some((cost) => cost === null)
                ? null
                : projectedCosts.reduce<number>((sum, cost) => sum + cost!, 0),
            costs,
            accounting,
            // Latest provider attempt on the latest turn, not the billed total.
            contextTokens: row?.context ?? 0,
            // Latest effective packet allowance; null when uncapped or unknown.
            promptBudget: row?.context_size ?? null,
            // Latest turn's opaque provider metadata. {§meta-passthrough}
            meta: JSON.parse(row?.meta ?? "{}") as Record<string, unknown>,
        };
    }

    async beginLoopAccounting(loopId: number, provider: Provider): Promise<string> {
        if (provider.reconcileAccounting !== undefined) {
            await this.#db.engine_begin_loop_accounting.run({ loop_id: loopId });
        }
        const row = await this.#db.engine_loop_accounting_identity.get<{
            accounting_scope_id: string;
            accounting_state: "unscoped" | "open" | "pending" | "settled";
        }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`beginLoopAccounting: loop ${loopId} does not exist`);
        if (provider.reconcileAccounting !== undefined && row.accounting_state !== "open") {
            throw new Error(`beginLoopAccounting: loop ${loopId} cannot issue a call from ${row.accounting_state} accounting state`);
        }
        return row.accounting_scope_id;
    }

    async reconcileLoopAccounting(loopId: number, provider: Provider, signal?: AbortSignal): Promise<ProviderAccountingResult | null> {
        if (provider.reconcileAccounting === undefined) return null;
        const row = await this.#db.engine_loop_accounting_scope.get<{
            accounting_scope_id: string;
            accounting_started_at: string;
            terminated_at: string | null;
            accounting_state: "unscoped" | "open" | "pending" | "settled";
            accounting_charge: string | null;
            accounting_evaluated_at: string | null;
            attempts: number;
            usage_prompt: number;
            usage_completion: number;
            usage_reasoning: number;
            usage_cached: number;
        }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`reconcileLoopAccounting: loop ${loopId} does not exist`);
        if (row.accounting_state === "unscoped") return null;
        if (row.accounting_state === "settled") {
            if (row.accounting_charge === null || row.accounting_evaluated_at === null) {
                throw new TypeError(`reconcileLoopAccounting: loop ${loopId} has incomplete settled evidence`);
            }
            return {
                status: "settled",
                charge: validateAuthoritativeCharge(JSON.parse(row.accounting_charge) as AuthoritativeCharge),
                evaluatedAt: row.accounting_evaluated_at,
            };
        }
        if (row.terminated_at === null) {
            throw new Error(`reconcileLoopAccounting: loop ${loopId} is not terminal`);
        }
        const usage: ProviderUsage = {
            prompt: row.usage_prompt,
            completion: row.usage_completion,
            reasoning: row.usage_reasoning,
            cached: row.usage_cached,
            total: row.usage_prompt + row.usage_completion + row.usage_reasoning,
        };
        const result = validateProviderAccountingResult(await provider.reconcileAccounting({
            id: row.accounting_scope_id,
            startedAt: row.accounting_started_at,
            endedAt: row.terminated_at,
            model: provider.model,
            attempts: row.attempts,
            usage,
        }, signal));
        if (result.status === "pending") {
            await this.#db.engine_set_loop_accounting_pending.run({
                loop_id: loopId,
                detail: result.reason,
                evaluated_at: result.evaluatedAt ?? null,
            });
            return result;
        }
        const charge = result.charge;
        const costUsd = providerCostUsd(charge);
        if (costUsd === null) throw new TypeError(`provider returned a non-settling charge for loop ${loopId}`);
        await this.#db.engine_set_loop_accounting_settled.run({
            loop_id: loopId,
            charge: JSON.stringify(charge),
            cost_usd: costUsd,
            evaluated_at: result.evaluatedAt,
        });
        return { status: "settled", charge, evaluatedAt: result.evaluatedAt };
    }

    // A mapped rail divergence is a CODE-POINT offset into the model's content;
    // the snippet/notices surface speaks the parser-point convention. {§parser-position}
    // Convert over code points (not UTF-16 units) so an astral char doesn't skew the line,
    // clamping out-of-range offsets to the content's end.
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

    async runLoop({
        provider, messages, requirements = "", workspaceId, workerId, loopId,
        maxTurns = 50, maxStrikes = readMaxStrikes(),
        minCycles = readPositiveInt("PLURNK_SERVICE_MIN_CYCLES", DEFAULT_MIN_CYCLES),
        maxCyclePeriod = readPositiveInt("PLURNK_SERVICE_MAX_CYCLE_PERIOD", DEFAULT_MAX_CYCLE_PERIOD),
        origin = "model", signal, onDispatch,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        // The requirements section content. Rendered at the end of the user
        // slot under `## Plurnk Service Requirements`. Caller sources from
        // Paths.defaultRequirements.
        requirements?: string;
        workspaceId: number; workerId: number; loopId: number;
        maxTurns?: number;
        maxStrikes?: number;
        minCycles?: number;
        maxCyclePeriod?: number;
        origin?: WriterTier;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
    }): Promise<{ turnIds: number[]; result: SchemeResult; hitMaxTurns: boolean; reason: "max_turns" | "strike_threshold" | "budget_overflow" | "invalid_emission" | "loop_timeout" | "external" | null }> {
        // A 202 park suspends this durable loop and a later wake re-enters runLoop.
        // Its ceiling therefore counts every prior turn, not merely this process-local
        // execution segment.
        const turnIds = await this.#lifecycle.turnIds(loopId);
        let invalidEmissionRecoveryEntryId: number | null = null;
        // Per-loop AbortController for scheme-side cancellation propagation.
        // Chained from the caller's `signal` so an external abort cascades.
        const loopAbort = new AbortController();
        if (signal !== undefined) {
            if (signal.aborted) loopAbort.abort(signal.reason);
            else signal.addEventListener("abort", () => loopAbort.abort(signal.reason), { once: true });
        }
        this.#loopAborts.set(loopId, loopAbort);

        // {§operator-config-loop-timeout} — the wall-clock budget. Expiry aborts the loop signal, so a
        // mid-flight provider call (generate rides this signal) and in-flight spawns tear down; the
        // loop terminates 504 (kin to the exec <T> reap's 504, {§exec-timeout}) — a legible engine
        // terminal, never an outside kill. unref'd: the wall never holds the process open.
        const wall = setTimeout(() => loopAbort.abort(LOOP_TIMEOUT_REASON), readLoopTimeoutMs());
        wall.unref();
        const timedOut = (): boolean => loopAbort.signal.aborted && loopAbort.signal.reason === LOOP_TIMEOUT_REASON;
        const ruleTimeout = async (): Promise<{ turnIds: number[]; result: SchemeResult; hitMaxTurns: boolean; reason: "loop_timeout" }> => {
            const failure = Results.failure(
                "engine:rails",
                "loop-timeout",
                504,
                `The loop exceeded its wall-clock deadline after ${turnIds.length} turns.`,
                {},
                {
                    turns: turnIds.length,
                    stage: "loop",
                    retryable: false,
                },
            );
            const result = await this.#lifecycle.finish(loopId, failure);
            if (result === null) throw new Error(`loop ${loopId} became terminal before timeout settlement`);
            cleanup("forceful", "loop_timeout");
            return { turnIds, result, hitMaxTurns: false, reason: "loop_timeout" };
        };

        // Cleanup splits by termination kind:
        // - "graceful" (SEND[202] Accepted): in-flight streaming-scheme spawns
        //   are ALLOWED to outlive the loop — they complete naturally, write final
        //   channel state, and wake-on-completion (E.4) opens a fresh loop. 202 is
        //   the only terminal that means "keep my async work."
        // - "forceful" (SEND[200] done, max_turns, strike, cancel, budget, 4xx/5xx):
        //   fire the loop-level abort so leftover spawns tear down. "Done" reaps.
        const cleanup = (kind: "graceful" | "forceful", reason?: string): void => {
            clearTimeout(wall);
            if (kind === "forceful" && !loopAbort.signal.aborted) {
                loopAbort.abort(reason ?? "loop_forceful_termination");
            }
            this.#loopAborts.delete(loopId);
            this.#strikes.delete(loopId);
            this.searchGate.cleanup(loopId);
            this.#hardOverflowRecovery.delete(loopId);
            this.#notices.delete(loopId);
        };

        while (true) {
            const row = await this.#db.engine_loop_status.get<{ status: number }>({ loop_id: loopId });
            if (row === undefined) throw new Error(`Engine.runLoop: loop ${loopId} not found`);
            if (row.status === 100) {
                // NOT a terminal — a wake re-queued this loop while its own live drain was
                // between turns (a child concluded in the gap between our 202 write and this
                // check, {§worker-lifecycle-wake-requeue-not-terminal}). The wake's intent is KEEP
                // RUNNING: re-claim atomically and continue — the injected prompt is already
                // this loop's next turn. Returning it as "external" broadcast a QUEUED loop
                // as a terminal result with status 100 — the delegation-flags race.
                await this.#db.engine_reclaim_queued_loop.run({ loop_id: loopId });
                continue; // claimed (or a racer flipped it first — the re-read decides)
            }
            if (row.status !== 102) {
                // Only 202 (Accepted) lets spawns outlive — it IS the async wake
                // contract (E.4). Every other terminal, 200 included, reaps: "done"
                // must not leak running execs. Trust the code's declared intent.
                cleanup(row.status === 202 ? "graceful" : "forceful", `loop_terminal_${row.status}`);
                if (row.status === 202) {
                    return { turnIds, result: { status: 202 }, hitMaxTurns: false, reason: "external" };
                }
                const result = await this.#lifecycle.result(loopId);
                if (result === null) {
                    throw new Error(`terminal loop ${loopId} status ${row.status} has no operation result`);
                }
                return { turnIds, result, hitMaxTurns: false, reason: "external" };
            }

            // Durable disposition outranks a later process-local cancellation observation.
            // SEND may commit 202 immediately before daemon shutdown aborts this drain; reading
            // the abort first launders that lawful park into 499 under load. Only a still-running
            // 102 loop can be cancelled or time out at this boundary.
            if (timedOut()) return await ruleTimeout();
            signal?.throwIfAborted();

            if (maxTurns >= 0 && turnIds.length >= maxTurns) {
                const failure = Results.failure(
                    "engine:rails",
                    "max-turns",
                    429,
                    `The configured turn ceiling (${maxTurns}) is exhausted.`,
                    {},
                    {
                        maximumTurns: maxTurns,
                        stage: "loop",
                        retryable: false,
                    },
                );
                const result = await this.#lifecycle.finish(loopId, failure);
                if (result === null) throw new Error(`loop ${loopId} became terminal before max-turn settlement`);
                cleanup("forceful", "max_turns");
                return { turnIds, result, hitMaxTurns: true, reason: "max_turns" };
            }

            const execHandler = this.#schemes.get("exec") as { hasActiveHoldSpawns?: (workerId: number, holdSet: ReadonlySet<string>) => boolean } | undefined;
            // {§exec-hold-until-concluded} — hold matching runtime/effect
            // streams until conclusion or the fail-open cap, then resume the
            // ordinary cycle without altering stream state.
            const holdSet = new Set((process.env.PLURNK_SERVICE_EXEC_HOLD ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0));
            const holdCapMs = Number(process.env.PLURNK_SERVICE_EXEC_HOLD_MS ?? "300000");
            if (holdSet.size > 0 && holdCapMs > 0 && execHandler?.hasActiveHoldSpawns !== undefined) {
                const holdStart = Date.now();
                while (execHandler.hasActiveHoldSpawns(workerId, holdSet) && Date.now() - holdStart < holdCapMs) {
                    await delay(150, undefined, { signal });
                }
            }
            let turn;
            const releaseWorkspace = await this.#acquireWorkspaceTurn(workspaceId, workerId);
            try {
                turn = await observed( // {§observability-boundary}
                    "loop.turn",
                    { workerId, "loop.id": loopId },
                    async (span) => {
                        const t = await this.runTurn({
                            provider, messages, requirements, workspaceId, workerId, loopId, origin, signal, onDispatch,
                            turnNumber: turnIds.length + 1, maxTurns,
                            invalidEmissionRecoveryEntryId,
                        });
                        span.setAttribute("turn.id", t.turnId);
                        return t;
                    },
                );
                await this.#workspaceTurnCompleted?.({
                    workspaceId,
                    workerId,
                    loopId,
                    turnId: turn.turnId,
                });
            } catch (err) {
                // The wall fired mid-turn — the abort tore the turn down (generate rides the loop
                // signal); rule the legible 504, never a generic drain error.
                if (timedOut()) return await ruleTimeout();
                throw err;
            } finally {
                releaseWorkspace();
            }
            turnIds.push(turn.turnId);

            // {§invalid-emission-attempts} Invalid provider emissions are retried beneath this turn and never
            // reach the strike rail. The first consecutive exhaustion has already
            // exposed its bounded lifeline through ordinary next-turn state. A
            // second exhaustion is terminal; an admitted turn clears the sequence.
            if (turn.emissionExhausted) {
                if (invalidEmissionRecoveryEntryId === null) {
                    if (turn.rejectedModelEntryId === undefined) {
                        throw new Error("an admitted invalid-emission recovery requires its rejected model-entry identity");
                    }
                    invalidEmissionRecoveryEntryId = turn.rejectedModelEntryId;
                    continue;
                }
                const failure = Results.failure(
                    "engine:generation",
                    "invalid-emission-exhausted",
                    500,
                    `No valid PLAN...SEND turn was received after ${turn.emissionAttempts} emission attempts.`,
                    {},
                    {
                        attempts: turn.emissionAttempts,
                        stage: "emission-validation",
                        retryable: false,
                    },
                );
                const result = await this.#lifecycle.finish(loopId, failure);
                if (result === null) throw new Error(`loop ${loopId} became terminal before invalid-emission settlement`);
                cleanup("forceful", "invalid_emission");
                return { turnIds, result, hitMaxTurns: false, reason: "invalid_emission" };
            }
            invalidEmissionRecoveryEntryId = null;

            // SPEC {§grinder}: budget hard-stop — packet won't fit even collapsed → abandon.
            if (turn.budgetHardStop) {
                if (turn.budget === undefined) {
                    throw new Error("a budget hard-stop requires its measured overflow");
                }
                const failure = BudgetOverflow.result(
                    turn.budget.usage,
                    turn.budget.ceiling,
                    false,
                );
                const result = await this.#lifecycle.finish(loopId, failure);
                if (result === null) throw new Error(`loop ${loopId} became terminal before budget settlement`);
                cleanup("forceful", "budget_overflow");
                return { turnIds, result, hitMaxTurns: false, reason: "budget_overflow" };
            }

            // {§engine-rails} — per-turn strike accounting (cycle detection, the
            // grinder/steer coupling, hard-failure statuses). StrikeRail owns the
            // bookkeeping; runLoop owns abandonment.
            const verdict = this.#strikes.assess(loopId, {
                fingerprint: turn.fingerprint,
                statuses: turn.statuses,
                budgetStruck: turn.budgetStruck,
                steerStruck: turn.steerStruck,
                minCycles, maxCyclePeriod, maxStrikes,
            });
            if (verdict.thresholdCrossed) {
                // {§engine-rails} — the source on the crossing turn classifies
                // the engine verdict: cycle-driven is 508; every other strike is 500.
                const status = verdict.cycleDetected ? 508 : 500;
                const failure = Results.failure(
                    "engine:rails",
                    "strike-threshold",
                    status,
                    verdict.cycleDetected
                        ? `The loop reached its strike threshold after ${turnIds.length} turns because its operation pattern repeated.`
                        : `The loop reached its strike threshold after ${turnIds.length} turns because consecutive turns failed.`,
                    {},
                    {
                        turns: turnIds.length,
                        stage: "loop",
                        retryable: false,
                    },
                );
                const result = await this.#lifecycle.finish(loopId, failure);
                if (result === null) throw new Error(`loop ${loopId} became terminal before strike settlement`);
                cleanup("forceful", "strike_threshold");
                return { turnIds, result, hitMaxTurns: false, reason: "strike_threshold" };
            }
        }
    }

    async runTurn({
        provider, messages, requirements = "", workspaceId, workerId, loopId, origin = "model", signal, onDispatch,
        turnNumber = 1, maxTurns = 50, invalidEmissionRecoveryEntryId,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        requirements?: string;
        workspaceId: number; workerId: number; loopId: number;
        origin?: WriterTier;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        // Position in the surrounding loop. Used to build per-turn LLM
        // context: turn 1 carries the initial user prompt verbatim; turn
        // N>1 substitutes a continuation marker. Both
        // are augmented with the durable state (index/log/notices).
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
        // === Turn-as-container model ===
        //
        // Turn rows are created at runTurn OPEN (status=102, placeholder
        // packet) so things can be written into the turn before the model
        // is called: the user prompt on turn 1; later, system signals or
        // injected Notices on any turn. The turn is CLOSED at
        // the end with the final packet + status + usage stats.
        //
        // sequence is "ordinal of stuff in this turn." Pre-model
        // writes consume low indices; model ops continue from there.
        const seqRow = await this.#db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        const seq = (seqRow as { next: number }).next;
        // loops.sequence is the loop's ordinal within the worker. Turn-0 foists that belong to the
        // WORKER (manifest preview, AGENTS, operator docs) gate on the worker's first loop, not every loop's
        // first turn ({§actor-boundary-catalog-preview}); per-loop foists such as
        // {§prompt-entry} still fire each loop. Read once, turn-1 only.
        const loopRow = seq === 1
            ? await this.#db.engine_get_loop_prompt.get<{ prompt: string; sequence: number; open_paths: string }>({ loop_id: loopId })
            : undefined;
        const workerFirstLoop = (loopRow?.sequence ?? 0) === 1;
        const openRow = await this.#db.engine_open_turn.get<{ id: number }>({
            loop_id: loopId, sequence: seq,
        });
        if (openRow === undefined) throw new Error("Engine.runTurn: turn open returned no row");
        const turnId = openRow.id;
        // {§env-delta-log-pull} — establish a fresh worker's observation
        // baseline immediately after its first turn opens. A fork already has
        // its parent's cursor, so the NULL-guarded statement leaves it intact.
        // Events committed after this statement belong to this or a later
        // closed pull window; pre-existing state is read through the ordinary
        // shared-world projections in this first packet.
        await this.#db.engine_initialize_ambient_cursor.get({ workspace_id: workspaceId, worker_id: workerId });
        // Threaded per turn, never engine state, so concurrent loops on
        // different providers each read their own honest tokenizer values.
        const systemCtx: PlurnkSchemeContext = {
            db: this.#db, workspaceId, workerId, loopId, turnId,
            writer: "plurnk",
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            tokenize: this.#tokenize,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s),
            pushNotice: (notice) => this.#notices.push(workspaceId, loopId, notice),
        };

        // Pre-model writes. Each prompt the model has not seen yet becomes an
        // actionless `prompt` log row whose target is its durable prompt:// entry:
        //   - Turn 1: loop.prompt is the initial user prompt.
        //   - Turn N>1: only if Engine.inject (or wake-on-completion via
        //     daemon.inject) wrote a prompt entry for this turn slot
        //     between turn N-1 and N. Inject writes directly to entries;
        //     we DON'T re-foist here for N>1.
        // Model ops dispatch after these pre-model rows.
        let nextActionIndex = 1;
        const turnOpenPaths: string[] = [];
        // {§model-entry} — the worker's first turn opens with the model's own turn-0, mirrored OPEN: a
        // worked turn PLAN → the environment FINDs the foist ACTUALLY dispatches → SEND[102]. Built
        // from the real ops below (not a static print — we lean into the genuine echo paradigm) and
        // written at sequence 1, so it reads first as the emission with the foisted results following.
        const turnZeroMoves: string[] = [];
        if (seq === 1) {
            if (workerFirstLoop) nextActionIndex = 2;  // reserve sequence 1 for the turn-0 echo
            // Operator doc READs (PLURNK_SERVICE_MD_<ALIAS>, {§actor-boundary-doc-injection}). The docs were materialized
            // as worker://plurnk/<entry> entries by the plurnk worker (LoopDocs, via the
            // {§actor-boundary} keystone); foist a READ of each into THIS turn-0 so the model
            // reads them inline. It sees only the READ — the materializing EDIT
            // lives in the plurnk worker's log, never the model's.
            // {§operator-config-workspace-md-docs} — env docs union the workspace's client docs; foist a READ of
            // each materialized worker://plurnk/<alias>.md (LoopDocs materialized the same set).
            const { mdDocs } = await WorkspaceSettings.read(this.#db, workspaceId);
            // {§actor-boundary-doc-injection} — operator docs appear on the worker's first loop.
            for (const doc of workerFirstLoop ? await WorkspaceSettings.resolveDocs(mdDocs) : []) {
                const docTarget: UrlPath = {
                    kind: "url", raw: `worker://plurnk/${doc.entryName}`, scheme: "worker",
                    username: null, password: null, hostname: "plurnk", port: null,
                    pathname: `/${doc.entryName}`, query: null, fragment: null,
                };
                const docRead: ReadStatement = {
                    op: "READ", suffix: "", signal: null, target: docTarget,
                    lineMarker: null, body: null, position: UNKNOWN_POSITION,
                };
                await this.dispatch({
                    statement: docRead, workspaceId, workerId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk", onDispatch,
                });
                nextActionIndex++;
            }
            const promptRow = loopRow; // {§prompt-entry} — per-loop; fires every loop's turn 1
            if (promptRow !== undefined && typeof promptRow.prompt === "string" && promptRow.prompt.length > 0) {
                const openPaths = assertOpenPaths(JSON.parse(promptRow.open_paths) as unknown, `Loop ${loopId} open_paths`);
                const promptLoopSeq = promptRow.sequence; // the loop's per-worker sequence — model-facing, matching log coordinates (owner: the db id read as prompt/2/1)
                const promptPath = promptTarget(promptLoopSeq, seq);
                const entry: EntryData = {
                    channels: { body: { content: promptRow.prompt, mimetype: "text/markdown" } },
                    tags: [],
                    attributes: { openPaths },
                };
                await EntryCrud.writeEntry(promptPath.pathname, entry, systemCtx, "prompt", workerId);
                turnOpenPaths.push(...openPaths);
                const promptLogId = await this.#writePromptLog({
                    workerId,
                    loopId,
                    turnId,
                    sequence: nextActionIndex,
                    target: promptPath,
                    content: promptRow.prompt,
                });
                onDispatch?.(promptLogId);
                nextActionIndex++;
            }
        }

        // {§prompt-loop-containment}: the loop contains every prompt that arrived
        // while it ran. Publish each undelivered frame as a prompt row, oldest
        // first, so rapid arrivals reach the model together exactly once.
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
                .filter((r) => typeof r.content === "string" && r.content.length > 0);
            for (const injectedRow of undelivered) {
                const attributes = parsePromptAttributes(injectedRow.attributes, `Prompt ${injectedRow.pathname} attributes`);
                const encodedOpenPaths = attributes.openPaths;
                if (encodedOpenPaths !== undefined) {
                    turnOpenPaths.push(...assertOpenPaths(encodedOpenPaths, `Prompt ${injectedRow.pathname} openPaths`));
                }
                const ordinal = Number(injectedRow.pathname.split("/").filter(Boolean).at(-1));
                const injTarget = promptTarget(loopSeq, ordinal);
                const promptLogId = await this.#writePromptLog({
                    workerId,
                    loopId,
                    turnId,
                    sequence: nextActionIndex,
                    target: injTarget,
                    content: injectedRow.content,
                });
                onDispatch?.(promptLogId);
                nextActionIndex++;
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
        await this.#queueWorkspaceWarm(systemCtx, false);
        // The warm materialized membership before deriving. This second pass is the
        // ordinary cheap change detector and captures any drift that landed meanwhile.
        const fsDivergences = await GitMembership.indexGitMembership(systemCtx);
        // {§packet-git-status} — one post-reconciliation snapshot supplies both
        // the compact packet summary and each causal file event's exact XY state.
        const gitStatus = await GitState.status(this.#db, workspaceId, this.#loopAborts.get(loopId)?.signal);
        await this.#logFsFictions(workspaceId, fsDivergences, gitStatus);
        // The refresh above may have changed bodies (including model/client edits
        // since the startup warm). Re-derive to completion before packet/model
        // construction. Membership is already current, so this pass does not
        // consume the filesystem divergences a second time.
        await this.#queueWorkspaceWarm(systemCtx, true, false);

        // Turn-0 catalog preview (PLURNK_SERVICE_FILES_ITEMS, {§actor-boundary-catalog-preview}):
        // FIND surveys foisted into the worker's first model turn so it opens with its catalog.
        // Folder-capable surfaces reveal one level with `*`; each deeper directory is an
        // actionable `dir/**` aggregate. The curated kernel docs remain recursive, so the
        // opening packet demonstrates both navigation forms. Empty results are orientation.
        if (seq === 1) {
            // {§operator-config-workspace-files-items} — workspace filesItems replaces the env default.
            const { filesItems: workspaceMI } = await WorkspaceSettings.read(this.#db, workspaceId);
            const filesItems = workspaceMI !== null ? normalizeFilesItems(workspaceMI) : readFilesItems();
            if (filesItems !== null && workerFirstLoop) { // {§actor-boundary-catalog-preview} — once per worker
                // engine_scheme_catalog_summary is the workspace-bounded scheme source: ordered,
                // one row per stored entry scheme. log:// is absent —
                // it lives in log_entries, not the catalog (present-mode, the # Log section).
                const catalogSchemes = await this.#db.engine_scheme_catalog_summary.all<{ scheme: string; entries: number; shallow_items: number }>({ workspace_id: workspaceId });
                // Entry-bearing plugin schemes foist alongside the four structural surveys below.
                const foistSchemes = catalogSchemes
                    .filter((catalog) => catalog.scheme !== "prompt" && catalog.scheme !== "worker")
                    .map(({ scheme, shallow_items }) => ({ scheme, shallow_items }));
                // Commons + project files always foist. An empty result establishes that the
                // surface exists and currently contains nothing.
                foistSchemes.push({
                    scheme: "worker",
                    shallow_items: catalogSchemes.find((c) => c.scheme === "worker")?.shallow_items ?? 0,
                });
                if (!foistSchemes.some((c) => c.scheme === "file")) foistSchemes.push({ scheme: "file", shallow_items: 0 }); // Empty project surface still receives its orienting FIND.
                for (const { scheme, shallow_items: shallowItems } of foistSchemes) {
                    const isFile = scheme === "file";
                    const pattern = this.#schemes.manifestFor(scheme)?.folderScopes === true ? "*" : "**";
                    // Only the file map takes PLURNK_SERVICE_FILES_ITEMS as a first-N cap;
                    // other system-authored surveys explicitly request all results rather than
                    // relying on the markerless model default.
                    const cap = isFile && filesItems > 0 && shallowItems > 0 ? Math.min(filesItems, shallowItems) : null;
                    const catalogMarker = cap === null
                        ? { marks: [1, -1] as [number, number] }
                        : { marks: [1, cap] as [number, number] };
                    // The file survey foists as the BARE relative glob — the path shape plurnk.md
                    // teaches (`*`, `src/**`, `**/notes.md`; bare = project-relative) — so the turn-0
                    // exemplar and the log rows the model reads never train a leading-slash or
                    // file:/// habit the rest of the teaching contradicts.
                    const catalogFind: FindStatement = {
                        op: "FIND", suffix: "", signal: null,
                        target: isFile ? { kind: "local", raw: pattern } : {
                            kind: "url",
                            raw: `${scheme}:///${pattern}`,
                            scheme,
                            username: null, password: null, hostname: null, port: null,
                            pathname: `/${pattern}`,
                            query: null, fragment: null,
                        },
                        body: null,
                        lineMarker: catalogMarker,
                        position: UNKNOWN_POSITION,
                    };
                    await this.dispatch({
                        statement: catalogFind, workspaceId, workerId, loopId, turnId,
                        sequence: nextActionIndex, origin: "plurnk", onDispatch,
                    });
                    nextActionIndex++;
                    // {§model-entry} — the same FIND, rendered back to DSL for the turn-0 echo (the model's
                    // own survey, mirrored OPEN). The <L> cap rides as `<1,N>`, exactly as the model would type it.
                    turnZeroMoves.push(`<<FIND(${isFile ? pattern : `${scheme}:///${pattern}`})<1,${cap ?? -1}>::FIND`);
                }
                // The kernel's self-documenting surface — FIND(worker://plurnk/docs/**), uncapped,
                // always ({§schemes-directory}, published under {§entry-owner}).
                await Owner.kernelId(this.#db, workspaceId); // the row exists even before docs materialize — the empty survey is orienting, never 404
                const kernelDocsFind: FindStatement = {
                    op: "FIND", suffix: "", signal: null,
                    target: { kind: "url", raw: "worker://plurnk/docs/**", scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: "/docs/**", query: null, fragment: null },
                    body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
                };
                await this.dispatch({ statement: kernelDocsFind, workspaceId, workerId, loopId, turnId, sequence: nextActionIndex, origin: "plurnk", onDispatch });
                nextActionIndex++;
                turnZeroMoves.push("<<FIND(worker://plurnk/docs/**)<1,-1>::FIND");
                // {§worker-scheme} — the building worker's own scratch gets the same complete
                // one-level map in its perspective alone. It always executes: an empty private
                // space is useful orientation, not grounds to hide the surface.
                const ownFind: FindStatement = {
                    op: "FIND", suffix: "", signal: null,
                    target: { kind: "url", raw: "worker://~/*", scheme: "worker", username: null, password: null, hostname: "~", port: null, pathname: "/*", query: null, fragment: null },
                    body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
                };
                await this.dispatch({ statement: ownFind, workspaceId, workerId, loopId, turnId, sequence: nextActionIndex, origin: "plurnk", onDispatch });
                nextActionIndex++;
                turnZeroMoves.push("<<FIND(worker://~/*)<1,-1>::FIND");  // {§model-entry} — the own-space survey, into the turn-0 echo
            }
            // {§model-entry} — mirror the model's turn-0 OPEN at sequence 1: PLAN → the FINDs actually
            // foisted above (real, their results already in the log) → SEND[102]. Dynamic — it reflects
            // the true survey, never a frozen print — and OPEN: the worked example the model orients on,
            // so the grammar can stay thin. Subsequent turns mirror the model's real output, folded.
            if (workerFirstLoop) {
                const emission = ["<<PLAN:Initialize:PLAN", ...turnZeroMoves, "<<SEND[102]:Next, address the prompt from the initialized context.:SEND"].join("\n");
                await this.#dispatcher.writeModelEntry({ verbatim: emission, workerId, loopId, turnId, sequence: 1, folded: false, origin: "plurnk" });
            }
        }

        // {§methods-loop-run-open-paths}: selected workspace paths belong to
        // the prompt frame. Publish the frame, then dispatch ordinary core READs
        // in that same turn; missing/non-member paths retain their normal 4xx.
        for (const raw of turnOpenPaths) {
            const pathname = raw.startsWith("/") ? raw : `/${raw}`;
            const fileRead: ReadStatement = {
                op: "READ", suffix: "", signal: null, lineMarker: null,
                target: {
                    kind: "url", raw: `file://${pathname}`, scheme: "file",
                    username: null, password: null, hostname: null, port: null,
                    pathname, query: null, fragment: null,
                },
                body: null, position: UNKNOWN_POSITION,
            };
            await this.dispatch({
                statement: fileRead, workspaceId, workerId, loopId, turnId,
                sequence: nextActionIndex, origin: "plurnk", onDispatch,
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
        nextActionIndex += await this.#materializeStreamDeltas({ workerId, loopId, turnId, fromSequence: nextActionIndex });

        // The post-reconciliation Git snapshot above is threaded into the packet
        // and every budget rebuild; overflow never shells again.
        // Notices are non-terminal observations, never operation-failure truth.
        // Drain once and thread the same set through every grinder rebuild.
        const notices = this.#notices.drain(loopId)
            .filter((event) => (event as { level?: string }).level !== "info") as Notice[];

        // Build the model request packet ({§packet-stored-shape}). The log build
        // queries log_entries scoped to the worker — the prompt entry just
        // written (if turn 1) is part of that query result.
        let requestPacket = await this.#packets.buildRequestPacket({
            initialMessages: messages, requirements, workspaceId, workerId, loopId,
            currentTurnSeq: seq, provider, gitStatus, notices, transientOpenLogEntryId,
        });
        // SPEC {§grinder} — budget grinder, pre-LLM: reclaim window on actual overflow.
        const enforced = await this.#packets.enforceBudget({
            packet: requestPacket, provider, workerId, loopId, turnId,
            // The overflow error row is minted at the turn's running sequence (nextActionIndex), pre-generate;
            // runTurn advances the counter past it below so the post-generate dispatch rows never collide.
            mintSequence: nextActionIndex,
            // Rebuilds re-derive durable errors and retain the one drained notice
            // set; neither path can duplicate or swallow a product failure.
            rebuild: () => this.#packets.buildRequestPacket({
                initialMessages: messages, requirements, workspaceId, workerId, loopId,
                currentTurnSeq: seq, provider, gitStatus, notices, transientOpenLogEntryId,
            }),
        });
        if (enforced.recorded) nextActionIndex += 1; // a fold-to-fit Problem consumed the reserved sequence
        requestPacket = enforced.packet;
        if (!enforced.fit) {
            // {§grinder-hard-413-recovery}/{§grinder-hard-413-abort} — admit
            // one physically sendable informed recovery turn; a physical
            // overflow or consecutive policy overflow terminates immediately.
            let physicalAdmission = await this.#packets.physicalAdmission(
                requestPacket,
                provider,
                this.#loopAborts.get(loopId)?.signal,
            );
            let recoveryAdmitted = false;
            if (physicalAdmission.admitted && !this.#hardOverflowRecovery.has(loopId)) {
                const ceiling = this.#packets.ceilingFor(provider);
                if (ceiling === null) {
                    throw new Error("an unbounded prompt budget cannot enter budget recovery");
                }
                await this.#problems.record({
                    workerId,
                    loopId,
                    turnId,
                    sequence: nextActionIndex++,
                    origin: "model",
                    source: "engine",
                    result: BudgetOverflow.result(requestPacket.tokens, ceiling, true),
                });
                // Rebuild so the recovery-steer row just minted renders in THIS packet's log +
                // errors sections (the same re-derive contract the soft grind uses).
                requestPacket = await this.#packets.buildRequestPacket({
                    initialMessages: messages, requirements, workspaceId, workerId, loopId,
                    currentTurnSeq: seq, provider, gitStatus, notices, transientOpenLogEntryId,
                });
                physicalAdmission = await this.#packets.physicalAdmission(
                    requestPacket,
                    provider,
                    this.#loopAborts.get(loopId)?.signal,
                );
                if (physicalAdmission.admitted) {
                    this.#hardOverflowRecovery.add(loopId);
                    recoveryAdmitted = true;
                }
            }
            if (!recoveryAdmitted) {
                // Hard 413: physically unsendable, or still over after the informed recovery turn.
                const ceiling = this.#packets.ceilingFor(provider);
                if (ceiling === null) {
                    throw new Error("an unbounded prompt budget cannot hard-stop");
                }
                if (!enforced.recorded || !physicalAdmission.admitted) {
                    await this.#problems.record({
                        workerId,
                        loopId,
                        turnId,
                        sequence: nextActionIndex++,
                        origin: "plurnk",
                        source: "engine",
                        result: BudgetOverflow.result(
                            requestPacket.tokens,
                            ceiling,
                            false,
                            physicalAdmission.admitted
                                ? undefined
                                : {
                                    reason: physicalAdmission.reason,
                                    detail: physicalAdmission.detail,
                                    capacity: physicalAdmission.capacity,
                                    tokens: physicalAdmission.measurement?.tokens,
                                    tokenKind: physicalAdmission.measurement?.kind,
                                    tokenSource: physicalAdmission.measurement?.source,
                                },
                        ),
                    });
                    requestPacket = await this.#packets.buildRequestPacket({
                        initialMessages: messages, requirements, workspaceId, workerId, loopId,
                        currentTurnSeq: seq, provider, gitStatus, notices, transientOpenLogEntryId,
                    });
                }
                // Skip the LLM, close the turn, and let runLoop abandon.
                await this.#db.engine_close_turn.run({
                    id: turnId, status: 413, packet: StoredPacket.stringify(requestPacket),
                    // The attempted turn retains its effective allowance even
                    // when no provider exchange completed. {§tokenomics-client-gauge}
                    usage_prompt_budget: this.#packets.promptBudgetFor(provider),
                    finish_reason: "budget_hard_stop", model: provider.model, meta: "{}",
                });
                return {
                    turnId,
                    status: 413,
                    statuses: [],
                    fingerprint: "",
                    budgetStruck: enforced.struck,
                    budgetHardStop: true,
                    steerStruck: false,
                    emissionAttempts: 0,
                    emissionExhausted: false,
                    budget: BudgetOverflow.measure(requestPacket.tokens, ceiling),
                };
            }
        } else {
            // A fitting turn clears the recovery grant; a later independent overflow can earn
            // a fresh recovery turn (chronic overflow still strikes out via the rail).
            this.#hardOverflowRecovery.delete(loopId);
        }
        const modelMessages = PacketWire.packetToWireMessages(requestPacket) as ChatMessage[];
        // Packet pressure and provider generation are independent. The grinder governs
        // only the request packet; maxTokens comes only from the provider envelope and
        // never shrinks as the virtual prompt budget fills.
        let response: ProviderAttempt | undefined;
        let splitResponse: SplitProviderResponse | undefined;
        let railGrammar: string | undefined;
        let railEvidence: GrammarEvidence | undefined;
        let emissionAttempts = 0;
        let providerCallInFlight = false;
        let providerAttemptSequence = 0;
        let providerAttemptId: number | null = null;
        let providerAttemptAttributions: string[] = [];
        const providerSignal = this.#loopAborts.get(loopId)?.signal ?? signal;
        // {§client-metadata}
        const { client } = await WorkspaceSettings.read(this.#db, workspaceId);
        const observeProviderAttempt = async (
            id: number,
            attemptResponse: ProviderAttempt,
        ): Promise<void> => {
            const attemptUsage = attemptResponse.assistant.usage;
            await this.#db.engine_observe_turn_attempt_response.run({
                id,
                response: JSON.stringify(attemptResponse),
                usage_prompt: attemptUsage.prompt,
                usage_completion: attemptUsage.completion,
                usage_reasoning: attemptUsage.reasoning,
                usage_cached: attemptUsage.cached,
                usage_cost: JSON.stringify({
                    kind: "unknown",
                    reason: "provider response retained before monetary classification",
                } satisfies ProviderCost),
                finish_reason: attemptResponse.assistant.finishReason,
                model: attemptResponse.assistant.model,
            });
        };
        const classifyProviderAttempt = async (
            id: number,
            attemptResponse: ProviderAttempt,
            attemptSplit: SplitProviderResponse,
            sequence: number,
            accepted: boolean,
            failure: SchemeResult | null = null,
        ): Promise<void> => {
            const attemptUsage = attemptSplit.callMetadata.usage;
            const attemptCost = providerCostFor(provider, attemptUsage, attemptResponse.charge);
            const attemptCostUsd = providerCostUsd(attemptCost);
            await this.#db.engine_classify_turn_attempt_response.run({
                id,
                accepted: accepted ? 1 : 0,
                parse_errors: JSON.stringify(attemptSplit.parseErrors),
                failure: failure === null ? null : JSON.stringify(failure),
                usage_cost: JSON.stringify(attemptCost),
                usage_cost_usd: attemptCostUsd,
            });
            emissionAttempts = sequence;
        };
        try {
            // {§turn-lifecycle}: bracket the complete provider-attempt window with liveness notices.
            if (!signal?.aborted) this.#notices.push(workspaceId, loopId, { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" });
            const loopSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId }))?.sequence ?? loopId;
            railGrammar = await this.#grammarConstraint(provider);
            const primaryWorkerId = String(await this.resolveWorkerPrimary(workerId));
            const attemptLimit = readEmissionAttempts();
            const maxTokens = this.#packets.maxTokensFor(provider) ?? undefined;
            const strikeStreak = this.#strikes.streak(loopId);
            const accountingScopeId = await this.beginLoopAccounting(loopId, provider);
            for (let attempt = 1; attempt <= attemptLimit; attempt++) {
                // Every attempt carries the exact same model packet, coordinates,
                // limits, and engine-strike state. Plugin-authored tags are pulled
                // for the attempt and do not alter the model messages. No failed
                // emission is appended and no new engine turn opens between calls.
                providerAttemptSequence = attempt;
                const attributionContext: PluginAttributionContext = Object.freeze({
                    workspaceId: String(workspaceId),
                    workerId: String(workerId),
                    primaryWorkerId,
                    loop: loopSeq,
                    turn: seq,
                    attempt,
                });
                providerAttemptAttributions = await this.#attemptAttributions(provider, attributionContext);
                requestPacket = { ...requestPacket, attributions: providerAttemptAttributions };
                const attemptRow = await this.#db.engine_open_turn_attempt.get<{
                    id: number;
                    accounting_id: string;
                }>({
                    turn_id: turnId,
                    sequence: attempt,
                    attributions: JSON.stringify(providerAttemptAttributions),
                    model: provider.model,
                });
                if (attemptRow === undefined) {
                    throw new Error(`Engine.runTurn: provider attempt ${attempt} did not open`);
                }
                providerAttemptId = attemptRow.id;
                providerCallInFlight = true;
                const completedResponse = await observed( // {§observability-boundary}
                    "provider.generate",
                    { model: provider.model, attempt },
                    async (span) => {
                        const generated = await provider.generate({
                            messages: modelMessages,
                            workerId: String(workerId),
                            primaryWorkerId,
                            signal: providerSignal,
                            grammar: railGrammar,
                            maxTokens,
                            strikes: strikeStreak,
                            attributions: providerAttemptAttributions.length > 0
                                ? providerAttemptAttributions
                                : undefined,
                            client: client ?? undefined,
                            workspaceId: String(workspaceId),
                            loop: loopSeq,
                            turn: seq,
                            accounting: {
                                scopeId: accountingScopeId,
                                callId: attemptRow.accounting_id,
                            },
                        }); // {§provider-surface-generate} {§provider-guarantees-signal-wired} {§provider-guarantees-serial-attempts} {§attribution} {§client-metadata}
                        providerCallInFlight = false;
                        recordCounter(PROVIDER_CALLS, {
                            model: provider.model,
                            attempt,
                            status: "resolved",
                        });
                        span.setAttribute("status", "resolved");
                        return generated;
                    },
                );
                response = completedResponse;
                await observeProviderAttempt(attemptRow.id, completedResponse);
                railEvidence = railGrammar === undefined
                    ? undefined
                    : Engine.#requireGrammarEvidence(completedResponse);
                splitResponse = this.#splitResponse(completedResponse);
                await classifyProviderAttempt(
                    attemptRow.id,
                    completedResponse,
                    splitResponse,
                    attempt,
                    splitResponse.emissionValid,
                );
                if (splitResponse.emissionValid) break;
            }
            if (!signal?.aborted) this.#notices.push(workspaceId, loopId, { source: "engine:turn", kind: "turn_generated", level: "info", message: "parsing model response" });
        } catch (err) {
            // This handler owns only provider-call failures. Parser, cost, SQL,
            // and engine-contract failures retain their original source.
            if (!providerCallInFlight) throw err;
            providerCallInFlight = false;
            if (providerAttemptId === null) {
                throw new Error("provider call failed without a durable attempt identity", { cause: err });
            }
            const failure: SchemeResult = err instanceof ProviderError
                ? { status: err.problem.status, problem: err.problem }
                : providerSignal?.aborted === true
                    ? Results.failure(
                        "engine:provider",
                        providerSignal.reason === LOOP_TIMEOUT_REASON ? "provider-call-timeout" : "provider-call-cancelled",
                        providerSignal.reason === LOOP_TIMEOUT_REASON ? 504 : 499,
                        providerSignal.reason === LOOP_TIMEOUT_REASON
                            ? "The provider call was interrupted by the loop deadline."
                            : "The provider call was interrupted by loop cancellation.",
                        {},
                        { stage: "provider-request", retryable: false },
                    )
                    : (() => {
                        console.error("Provider failed outside its Problem Details contract:", err);
                        return Results.failure(
                            "engine:provider",
                            "provider-contract-violation",
                            502,
                            "The provider failed without returning its required Problem Details.",
                            {},
                            {
                                stage: "provider-request",
                                retryable: false,
                            },
                        );
                    })();
            // {§provider-interrupted-attempt} — a provider-declared interruption
            // carries response evidence without becoming a completed exchange.
            // Persist it as an unaccepted attempt before settling the failure.
            if (err instanceof ProviderError && err.attempt !== undefined) {
                response = err.attempt;
                await observeProviderAttempt(providerAttemptId, response);
                splitResponse = this.#splitResponse(response);
                await classifyProviderAttempt(
                    providerAttemptId,
                    response,
                    splitResponse,
                    providerAttemptSequence,
                    false,
                    failure,
                );
            } else {
                const unknownCost: ProviderCost = {
                    kind: "unknown",
                    reason: "provider call failed without response-bearing charge evidence",
                };
                await this.#db.engine_fail_turn_attempt.run({
                    id: providerAttemptId,
                    failure: JSON.stringify(failure),
                    usage_cost: JSON.stringify(unknownCost),
                });
                emissionAttempts = providerAttemptSequence;
            }
            // {§turn-never-blank} — a ProviderError means no completed exchange exists.
            // Persist its exact RFC 9457 result before propagating it. Grammar evidence
            // and its engine-owned verdict exist only on completed responses
            // ({§rail-truth-engine-verdict}). Cancellation is lifecycle truth, not a
            // provider failure. Close the
            // attempted turn without inventing an assistant response, then let
            // runLoop/Daemon settle the exact 504/499 loop result.
            if (providerSignal?.aborted) {
                await this.#db.engine_close_turn.run({
                    id: turnId,
                    status: providerSignal.reason === LOOP_TIMEOUT_REASON ? 504 : 499,
                    packet: StoredPacket.stringify(requestPacket),
                    usage_prompt_budget: this.#packets.promptBudgetFor(provider),
                    finish_reason: splitResponse?.callMetadata.finishReason ?? null,
                    model: splitResponse?.callMetadata.model ?? provider.model,
                    meta: JSON.stringify(response?.meta ?? {}),
                });
                throw err;
            }
            const recorded = await this.#problems.record({
                workerId,
                loopId,
                turnId,
                sequence: nextActionIndex,
                origin: "plurnk",
                source: "provider",
                result: failure,
            });
            // The provider call was attempted, but no completed exchange exists.
            // Persist the exact request half and failure status; omitting assistant
            // is materially different from fabricating an empty model turn.
            await this.#db.engine_close_turn.run({
                id: turnId,
                status: recorded.result.status,
                packet: StoredPacket.stringify(requestPacket),
                usage_prompt_budget: this.#packets.promptBudgetFor(provider),
                finish_reason: splitResponse?.callMetadata.finishReason ?? null,
                model: splitResponse?.callMetadata.model ?? provider.model,
                meta: JSON.stringify(response?.meta ?? {}),
            });
            throw new OperationFailureError(recorded.result, { cause: err });
        }

        if (response === undefined || splitResponse === undefined) {
            throw new Error("provider attempt loop completed without a response");
        }
        if (!splitResponse.emissionValid) {
            // {§invalid-emission-attempts} The first consecutive exhaustion
            // publishes only the raw final response and generic recovery fact.
            let rejectedModelEntryId: number | undefined;
            if (allowInvalidEmissionRecovery) {
                rejectedModelEntryId = await this.#dispatcher.writeModelEntry({
                    verbatim: splitResponse.packetAssistant.content,
                    workerId,
                    loopId,
                    turnId,
                    sequence: nextActionIndex,
                    folded: true,
                    admission: "rejected",
                });
                this.#notices.push(workspaceId, loopId, {
                    source: "engine:grammar",
                    kind: "invalid_emission",
                    level: "error",
                    message: INVALID_EMISSION_RECOVERY_MESSAGE,
                });
            }
            await this.#db.engine_close_turn.run({
                id: turnId,
                status: allowInvalidEmissionRecovery ? TURN_STATUS_IMPLICIT_CONTINUE : 500,
                packet: StoredPacket.stringify(requestPacket),
                usage_prompt_budget: this.#packets.promptBudgetFor(provider),
                finish_reason: splitResponse.callMetadata.finishReason,
                model: splitResponse.callMetadata.model,
                meta: JSON.stringify(response.meta ?? {}),
            });
            return {
                turnId,
                status: allowInvalidEmissionRecovery ? TURN_STATUS_IMPLICIT_CONTINUE : 500,
                statuses: [],
                fingerprint: "",
                budgetStruck: enforced.struck,
                budgetHardStop: false,
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
        // the model resolves it against its own emission — READ the folded model-emission row at the
        // cited lines ({§model-entry}) — not an embedded snippet that would duplicate the emission.
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
            let verdict: ReturnType<typeof validateGbnf> | null = null;
            try { verdict = validateGbnf(railGrammar, railEvidence.input); }
            catch (cause) { Engine.#warnRailVerdictGapOnce((cause as Error).message); }
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
        const opsCount = packetAssistant.ops.length;
        const finalOp = packetAssistant.ops.at(-1);
        if (finalOp?.op !== "SEND") {
            // Text emissions cannot reach this point without a disposition;
            // this fail-hard guard also keeps Mock's trusted pre-parsed seam
            // from creating runtime states that production admission forbids.
            throw new Error("an admitted emission must end in a disposition SEND");
        }
        const dispositionSignal = finalOp.signal;
        if (typeof dispositionSignal !== "number" || !TERMINAL_SEND_SIGNALS.has(dispositionSignal)) {
            throw new Error("an admitted emission must end in a disposition SEND");
        }
        const sendOp = finalOp;
        // {§send} the terminal contract — engine error states verify a terminal claim against loop
        // state, never trusting the model's code. They strike via turn.steerStruck
        // ({§engine-rails}): the loop continues, the model sees the steering hint not the strike
        // count, and a non-resolver spins out to the engine's 500.
        let steerStruck = false;
        // Engine errors raised this turn, minted as op='error' log rows after dispatch (they share the
        // post-dispatch sequence counter). {§operation-result-uniform-error-channel}
        const pendingEngineErrors: EngineProblemKind[] = [];

        // Terminal adjudication moved to the DISPATCHER ({§send-premature-terminate}, the unified
        // pending set): the terminal SEND is judged AT ITS OWN DISPATCH — after the emission's
        // earlier ops executed — so a same-turn KILL+[200] repairs in one turn and a same-turn
        // WORK+[200] is caught. A refused final disposition (409) strikes via
        // the dispatch-loop check below.

        let turnStatus = dispositionSignal;

        // Idle turn: an implicit-continue (102) that did no WORK — its ops are only PLAN/SEND, no mid op.
        // The model continued with nothing to do.
        const midOpsCount = packetAssistant.ops.filter((op) => op.op !== "PLAN" && op.op !== "SEND").length
            + recoverableParseErrors.length;
        if (!steerStruck && turnStatus === TURN_STATUS_IMPLICIT_CONTINUE && midOpsCount === 0) {
            steerStruck = true;
            pendingEngineErrors.push("idle_turn");
        }

        // Close the turn with the final packet, status, and usage stats.
        const packet = StoredPacket.admit(requestPacket, packetAssistant, response.assistantRaw);
        await this.#db.engine_close_turn.run({
            id: turnId,
            status: turnStatus,
            packet: StoredPacket.stringify(packet),
            usage_prompt_budget: this.#packets.promptBudgetFor(provider), // {§tokenomics-client-gauge}
            finish_reason: callMetadata.finishReason,
            model: callMetadata.model,
            // Opaque provider metadata plus engine-authored rail keys.
            // {§meta-passthrough}, {§rail-truth-engine-verdict}
            meta: JSON.stringify({ ...(response.meta ?? {}), ...(railKeys ?? {}) }),
        });

        // Dispatch model ops starting at nextActionIndex (continues the
        // turn's running counter after any pre-model writes).
        //
        // Max-commands ceiling: OFF by default (unlimited) — every generated op dispatches.
        // A degenerate op-loop is a sampler failure guarded at generation, not by dropping
        // already-generated work post-hoc. The ceiling is an OPT-IN operator/client bound:
        // when set, overflow ops drop without per-op log entries (no forensics flood) and the
        // model gets one notices signal next packet.
        // {§operator-config-workspace-max-commands} — workspace maxCommands min()s the env ceiling.
        const maxCommands = Math.min(readMaxCommands(), (await WorkspaceSettings.read(this.#db, workspaceId)).maxCommands ?? Number.POSITIVE_INFINITY);
        // PLAN (intended goals) and the final disposition SEND are not actions —
        // they always dispatch and never count against the cap. maxCommands
        // bounds real actions only; maxCommands:0 still admits a plan and a disposition
        // (the PLAN/SEND ops, zero actions), which is its only coherent meaning.
        let realCommands = 0;
        const admittedOps = packetAssistant.ops.filter(
            (op) => {
                return op.op === "PLAN"
                || op === sendOp
                || realCommands++ < maxCommands;
            },
        );
        const opsToDispatch = scheduleTurnOps(admittedOps);
        await this.#dispatcher.prepareEditBatches(
            opsToDispatch.filter(
                (statement): statement is EditStatement =>
                    statement.op === "EDIT",
            ),
            {
                workspaceId, workerId, loopId, turnId,
                origin, onDispatch,
            },
        );
        const droppedCount = opsCount - opsToDispatch.length;
        const statuses: number[] = [];
        // Running counter — a multi-file READ writes N rows from one statement (rowsWritten),
        // so the next op's sequence picks up after them. Collapses to nextActionIndex+i when
        // every op writes one row (the common case).
        let rowSeq = nextActionIndex;
        let parseErrorsRecorded = false;
        const recordRecoverableParseErrors = async (): Promise<void> => {
            if (parseErrorsRecorded) return;
            parseErrorsRecorded = true;
            for (const error of recoverableParseErrors) {
                const recorded = await this.#problems.record({
                    workerId,
                    loopId,
                    turnId,
                    sequence: rowSeq++,
                    origin: "model",
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
                statuses.push(recorded.result.status);
                onDispatch?.(recorded.id);
            }
        };
        for (const statement of opsToDispatch) {
            if (
                statement.op === "SEND"
                && typeof statement.signal === "number"
                && TERMINAL_SEND_SIGNALS.has(statement.signal)
            ) {
                await recordRecoverableParseErrors();
                // {§exec-optimistic-settlement} — SEND judges the refreshed
                // lifecycle after this turn's own fast streams receive one
                // bounded opportunity to conclude. This is not a sleep and
                // does not delay a later turn for older monitored streams.
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
                    readExecSettlementMs(),
                    providerSignal,
                );
            }
            const result = await observed( // {§observability-boundary}
                "op.dispatch",
                { op: statement.op },
                async (span) => {
                    const dispatchResult = await this.#dispatcher.dispatch({
                        statement, workspaceId, workerId, loopId, turnId,
                        sequence: rowSeq,
                        origin, onDispatch,
                    });
                    span.setAttribute("status", dispatchResult.status);
                    recordCounter(OPS_DISPATCHED, { op: statement.op, status: dispatchResult.status });
                    return dispatchResult;
                },
            );
            statuses.push(result.status);
            for (const normalization of result.scopeNormalizations ?? []) {
                this.#notices.push(workspaceId, loopId, {
                    source: "engine:slicer",
                    kind: "scope_normalized",
                    level: "warn",
                    message: `Scope <${normalization.requested.join(",")}> was normalized to <${normalization.canonical.join(",")}>.`,
                });
            }
            // {§engine-rails} — a refused final disposition leaves both loop
            // and turn continuing, and its 409 steering ruling strikes once.
            if (statement === sendOp && result.status === 409) {
                steerStruck = true;
                turnStatus = TURN_STATUS_IMPLICIT_CONTINUE;
                await this.#db.engine_reconcile_turn_status.run({ id: turnId, status: turnStatus });
            }
            // {§send-300-choices}: a question resolves through the proposal system; whatever the
            // resolution (answer/reject/timeout), the LOOP continues to the turn where the model
            // reads it; the turn record is a continue, never a 300 terminal.
            if (statement === sendOp && sendOp.signal === 300 && result.status !== 409) {
                turnStatus = TURN_STATUS_IMPLICIT_CONTINUE;
                await this.#db.engine_reconcile_turn_status.run({ id: turnId, status: turnStatus });
            }
            // A broadcast [202] is a conditional wait, not an unconditional turn status:
            // live work parks at 202; completed-but-unobserved work continues at 102; an
            // empty join completes at 200. Persist and return the dispatcher's actual ruling.
            if (
                statement === sendOp
                && result.status !== 409
                && sendOp.target === null
                && sendOp.signal === 202
                && result.status !== 202
            ) {
                turnStatus = result.status;
                await this.#db.engine_reconcile_turn_status.run({ id: turnId, status: turnStatus });
            }
            rowSeq += (result.rowsWritten as number | undefined) ?? 1;
        }
        await recordRecoverableParseErrors();
        // Engine rail failures mint as op='error' log rows at the turn's next
        // free sequence. Bounded syntax failures were recorded in their
        // authored turn before its terminal disposition.
        let errSeq = rowSeq;
        // max_commands_exceeded IS model-facing: dropped ops the model emitted that didn't run.
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
                    recovery: "Perform an operation before continuing with SEND[102].",
                    retryable: false,
                };
            await this.#problems.record({
                workerId,
                loopId,
                turnId,
                sequence: errSeq++,
                origin: "plurnk",
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
        // {§log-row-self-explains} — model-operation failures remain on their
        // own rows; genuine engine faults fail hard and mint no substitute row.
        // {§model-entry} — mirror this turn's verbatim emission back as a `model` row, so the NEXT
        // packet shows the model exactly what it last produced. ALWAYS born FOLDED — the old
        // born-OPEN-on-error auto-trigger was conditional helpfulness that bred its own hazards
        // (a 24k-char ramble mirrored open re-injects itself into the next packet: cost,
        // contamination, pressure feedback).
        // {§encrypted-reasoning-carrier} — core relays every provider-normalized
        // item unchanged.
        const reasoningItems = response.assistant.reasoningEncrypted?.length
            ? response.assistant.reasoningEncrypted
            : undefined;
        if (packetAssistant.content.trim().length > 0 || reasoningItems !== undefined) {
            await this.#dispatcher.writeModelEntry({ verbatim: packetAssistant.content, workerId, loopId, turnId, sequence: errSeq++, folded: true, ...(reasoningItems !== undefined ? { reasoningItems } : {}) });
        }

        return {
            turnId,
            status: turnStatus,
            statuses,
            fingerprint: StrikeRail.fingerprintTurn(packetAssistant.ops),
            budgetStruck: enforced.struck,
            budgetHardStop: false,
            steerStruck,
            emissionAttempts,
            emissionExhausted: false,
        };
    }

    // Split the wire-level ProviderResponse into the two destinations:
    // packet.assistant gets the model's emission (content, ops, reasoning);
    // Turn columns get the call-metadata (usage, finishReason, model).
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
            callMetadata: { usage: assistant.usage, finishReason: assistant.finishReason, model: assistant.model },
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

    // #note12 — the plugin-provided reference docs (schemes' + execs' `documentation`),
    // materialized at worker://plurnk/docs/<name>.md by LoopDocs (like operator docs).
    docEntries(workspaceId: number): Promise<Array<{ name: string; content: string }>> {
        return this.#packets.docEntries(workspaceId);
    }

    // {§env-delta-log-pull} — materialize one closed interval of the ambient
    // occurrence journal into this worker's self-contained log. #67 owns only
    // the remaining model-facing actor-name projection.
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
            status_rx: number | null;
            prompt: string | null;
            terminated_by: string | null;
        }>({ workspace_id: workspaceId, worker_id: workerId });
        const window = rows[0];
        if (window === undefined) throw new Error(`ambient pull: worker ${workerId} has no observation window`);
        let written = 0;
        for (const r of rows) {
            if (r.event_id === null || r.producer_worker_id === null || r.producer_worker_name === null || r.kind === null
                || r.op === null || r.status_rx === null) continue;
            const termination = r.kind === "loop_termination";
            const rx = termination
                ? BranchReceipt.append(
                    markTerminal(r.terminated_by, r.rx) ?? `loop "${r.prompt ?? ""}" ended (${r.status_rx})`,
                    await BranchReceipt.render(this.#db, r.producer_worker_id),
                )
                : r.rx;
            if (rx === null) throw new Error(`ambient event ${r.event_id} has no materializable result`);
            const inserted = await this.#db.engine_insert_ambient_delta.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: fromSequence + written,
                event_id: r.event_id,
                source: r.source ?? WorkerControlAddress.render(r.producer_worker_name),
                op: r.op,
                scheme: r.scheme,
                hostname: r.hostname,
                pathname: r.pathname,
                rx,
                mimetype_rx: termination ? "text/markdown" : "application/json",
                status: r.status_rx,
                expanded: termination && r.status_rx >= 200 && r.status_rx < 300 ? 1 : 0,
                attrs: r.attrs ?? "{}",
            });
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

    cancelSubscription(subscriptionId: number): Promise<boolean> {
        return this.#liveSubscriptions.cancel(subscriptionId);
    }

    // {§env-delta} — exec streams as an instance of the ambient-observe machine:
    // each turn, emit each owned channel's unshown byte-delta as a foisted READ row. It is 200
    // while the channel streams and preserves the exact terminal result when closed. Ongoing
    // deltas fold; the terminal delta auto-OPENs. The cursor is the
    // streamEnd recorded on the channel's prior delta — no exec-specific surfacing, just the
    // env-observe loop with a byte cursor where env-delta uses a timestamp. {§exec-stream}
    async #materializeStreamDeltas(args: {
        workerId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number> {
        const { workerId, loopId, turnId, fromSequence } = args;
        const channels = await this.#db.engine_worker_stream_channels.all<{
            subscription_id: number; runtime: string; coord: string; channel: string; content: string;
            state: string; close_status: number | null; close_result: string | null; published_channel: string | null;
        }>({ worker_id: workerId });
        let written = 0;
        for (const ch of channels) {
            // Default channels are an implementation detail. Preserve the
            // channel internally on the entry/subscription, but present the
            // ordinary address to the model; only an explicitly non-default
            // channel earns a fragment in the log.
            const visibleFragment = ch.published_channel !== null
                && ch.channel === this.#schemes.defaultChannelFor(ch.runtime)
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
            if (ch.content.length <= cursor) {
                // The cursor-terminal race (owner's dogfood find): a channel written in one final
                // burst gets fully shown FOLDED while still active; the close then has zero new
                // bytes and the auto-OPEN terminal delta never fired — the model was never shown
                // the conclusion of a stream whose result it already holds folded. The same
                // observation is required when the stream produced zero bytes: completion is
                // information independently of payload. Emit the terminal marker ONCE: open,
                // terse, carrying the close status ({§tokenomics-fetch-fits-free}).
                if (closed && priorAttrs.terminal !== true) {
                    const streamTarget = renderTarget({
                        scheme: ch.runtime,
                        pathname: ch.coord,
                        fragment: visibleFragment,
                    });
                    if (streamTarget === null) throw new Error(`stream ${ch.subscription_id} has no renderable address`);
                    const pointer = cursor > 0
                        ? `full output already delivered above; READ ${streamTarget} to revisit`
                        : "stream produced no output";
                    const sequence = fromSequence + written;
                    await this.#db.engine_insert_stream_delta.run({
                        worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                        scheme: ch.runtime, pathname: ch.coord, fragment: visibleFragment,
                        rx: JSON.stringify(await terminalResult({
                            content: `[ stream closed (${ch.close_status ?? 200}) - ${pointer} ]`,
                            mimetype: "text/stream",
                        }, sequence)),
                        status: terminal?.status ?? 200,
                        attrs: JSON.stringify({ streamEnd: ch.content.length, terminal: true }),
                        expanded: 1,
                    });
                    written++;
                }
                continue;
            }
            // startLine continues the line count across turns: a multi-turn stream's deltas number
            // into one sequence (lines N..M, then M+1..), not N independent "1:" restarts. {§exec-stream}
            const startLine = (ch.content.slice(0, cursor).match(/\n/g)?.length ?? 0) + 1;
            const sequence = fromSequence + written;
            const result = closed
                ? await terminalResult({ content: ch.content.slice(cursor), mimetype: "text/stream", startLine }, sequence)
                : { status: 200, content: ch.content.slice(cursor), mimetype: "text/stream", startLine };
            await this.#db.engine_insert_stream_delta.run({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                scheme: ch.runtime, pathname: ch.coord, fragment: visibleFragment,
                rx: JSON.stringify(result),
                status: result.status,
                attrs: JSON.stringify({ streamEnd: ch.content.length, terminal: closed }),
                expanded: closed ? 1 : 0,  // {§exec-stream} — terminal delta auto-OPENs; ongoing folds
            });
            written++;
        }
        return written;
    }

    // {§env-delta-filesystem-narration} {§membership-emi-divergence-signal}
    // — journal project-file divergence once through the reserved actor.
    async #logFsFictions(
        workspaceId: number,
        divergences: FsDivergence[],
        gitStatus: GitStatusSnapshot | null,
    ): Promise<void> {
        if (divergences.length === 0) return;
        const gitByPath = new Map(gitStatus?.files.map(({ path, status }) => [path, status] as const) ?? []);
        const worker = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" })
            ?? await this.#db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "plurnk" });
        if (worker === undefined) throw new Error("logFsFictions: plurnk worker resolution returned no row");
        const loop = await this.#db.envelope_insert_client_loop.get<{ id: number }>({ worker_id: worker.id });
        if (loop === undefined) throw new Error("logFsFictions: loop insert returned no row");
        const turn = await JournalTurn.insert(this.#db, loop.id);
        let sequence = 1;
        for (const d of divergences) {
            const span = editedSpan(d.before, d.after);
            await this.#db.engine_insert_log_entry.get({
                worker_id: worker.id, loop_id: loop.id, turn_id: turn.id, sequence: sequence++,
                origin: "plurnk", source: "file", op: "EDIT", suffix: "", signal: null,
                // Match Dispatcher.#extractTarget: a bare file address has NULL scheme
                // only in log target metadata; its entry identity remains `file`.
                scheme: null, username: null, password: null, hostname: null, port: null,
                pathname: d.pathname, query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/plain",
                rx: JSON.stringify({ status: 200, entryId: d.entryId, channel: d.channel, span }), mimetype_rx: "application/json",
                status_rx: 200, tokens: 0, state: "resolved", outcome: null,
                attrs: gitByPath.has(d.pathname)
                    ? JSON.stringify({ git: gitByPath.get(d.pathname) })
                    : "{}",
            });
        }
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        return observed( // {§observability-boundary}
            "op.dispatch",
            { op: context.statement.op },
            async (span) => {
                if (context.statement.op === "EDIT") {
                    const { statement, sequence: _sequence, ...batchContext } = context;
                    await this.#dispatcher.prepareEditBatches([statement], batchContext);
                }
                const result = await this.#dispatcher.dispatch(context);
                span.setAttribute("status", result.status);
                return result;
            },
        );
    }

    // {§op-look}: resolve a READ without writing a log_entries row.
    async look(context: {
        statement: PlurnkStatement;
        workspaceId: number; workerId: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        return this.#dispatcher.look(context);
    }

    async resolveEntryAddress(context: {
        target: ParsedPath;
        workspaceId: number;
        workerId: number;
    }): Promise<ResolvedClientEntryAddress | null> {
        return this.#dispatcher.resolveEntryAddress(context);
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
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence,
            origin: "plurnk",
            source: null,
            op: "prompt",
            suffix: "",
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
            rx: JSON.stringify({ content, mimetype: "text/markdown" }),
            mimetype_rx: "application/json",
            status_rx: 200,
            tokens: this.#tokenize(content),
            state: "resolved",
            outcome: null,
            attrs: "{}",
        });
        if (row === undefined) throw new Error("Engine.#writePromptLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // External API to feed a resolution into a pending proposal — the client-interface
    // seam, core-owned disposition, or the timeout watcher.
    // {§worker-lifecycle-total-reap}: release every stopped-world waiter before joining drains.
    cancelAllProposals(outcome: string): void {
        this.#proposals.cancelAll(outcome);
    }

    resolveProposal(logEntryId: number, resolution: ProposalResolution): void {
        this.#proposals.resolve(logEntryId, resolution);
    }

    // Snapshot of pending proposals for client-interface discovery.
    pendingProposalIds(): number[] {
        return this.#proposals.pendingIds();
    }

    // Subscribe to proposal-pending observations. Automatic settlement is
    // core-owned and happens before observers run.
    onProposalPending(listener: (event: ProposalPendingEvent) => void): void {
        this.#proposals.onPending(listener);
    }

    async pendingProposals(workspaceId: number): Promise<ProposalProjection[]> {
        return this.#proposals.list(workspaceId);
    }

    // Used by wake-on-completion (daemon side): "is there any loop in this
    // worker still accepting turns?" If yes, skip the wake — the active loop
    // will pick up the channel transition at its next turn boundary. If no,
    // the daemon opens a fresh loop with the wake prompt.
    async hasActiveLoopForWorker(workerId: number): Promise<boolean> {
        const row = await this.#db.engine_count_active_loops_for_worker.get<{ n: number }>({ worker_id: workerId });
        return (row?.n ?? 0) > 0;
    }

    // Workspace-scope eager warm: creation and membership changes start the
    // exhaustive graph/FTS/vector derivation immediately. The seam call returns while
    // progress live-fans-out at loopId 0; a model turn joins this same coalesced
    // promise and cannot reach its provider until coverage is complete.
    async warmWorkspaceDerivations(workspaceId: number): Promise<void> {
        const ctx: PlurnkSchemeContext = {
            db: this.#db, workspaceId, workerId: 0, loopId: 0, turnId: 0,
            writer: "plurnk",
            signal: undefined,
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            tokenize: this.#tokenize,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s),
            pushNotice: (notice) => this.#notices.notify(workspaceId, 0, notice),
        };
        await this.#queueWorkspaceWarm(ctx); // materialize first; overlapping requests coalesce and rescan
    }

    // Inject a prompt into the worker's current non-terminal loop. Writes the
    // next owner-keyed prompt:///<loop>/<N> entry; the next turn publishes it
    // as one actionless prompt row. Prompt-frame writes serialize per worker,
    // so concurrent arrivals retain distinct ordered ordinals.
    //
    // Returns null when no loop in the worker is active or parked (102/202).
    // The daemon-side inject path then enqueues a fresh loop with this
    // prompt; engine doesn't open loops itself.
    inject(workerId: number, prompt: string, openPaths: readonly string[] = []): Promise<
        { loopId: number; turnSeq: number } | null
    > {
        return this.#withPromptWriteLock(workerId, () => this.#injectPrompt(workerId, prompt, openPaths));
    }

    #withPromptWriteLock<T>(workerId: number, write: () => Promise<T>): Promise<T> {
        const previous = this.#promptWriteLocks.get(workerId) ?? Promise.resolve();
        const run = previous.then(write, write);
        const tail = run.catch(() => {});
        this.#promptWriteLocks.set(workerId, tail);
        void tail.then(() => {
            if (this.#promptWriteLocks.get(workerId) === tail) this.#promptWriteLocks.delete(workerId);
        });
        return run;
    }

    async #injectPrompt(workerId: number, prompt: string, openPaths: readonly string[]): Promise<
        { loopId: number; turnSeq: number } | null
    > {
        const loopRow = await this.#db.drain_current_loop_for_worker.get<{ id: number; sequence: number }>({ worker_id: workerId });
        if (loopRow === undefined) return null;
        const loopId = loopRow.id;
        const turnRow = await this.#db.drain_next_turn_seq_for_loop.get<{ next: number }>({ loop_id: loopId });
        const turnSeq = turnRow?.next ?? 1;
        const workspaceRow = await this.#db.drain_get_worker_workspace.get<{ workspace_id: number }>({ worker_id: workerId });
        if (workspaceRow === undefined) throw new Error(`Engine.inject: worker ${workerId} not found`);
        // {§prompt-loop-containment} — the frame is the loop's NEXT prompt ordinal, never a turn
        // slot: rapid arrivals land as N and N+1, both contained, nothing superseded.
        const prefix = promptLoopPrefix(loopRow.sequence);
        const ordinalRow = await this.#db.drain_next_prompt_ordinal_for_loop.get<{ next: number }>({
            owner_id: workerId,
            pattern: `${prefix}%`,
            prefix_len: prefix.length,
        });
        const pathname = promptPathname(loopRow.sequence, ordinalRow?.next ?? 2);
        const ctx: PlurnkSchemeContext = {
            db: this.#db, workspaceId: workspaceRow.workspace_id, workerId, loopId,
            turnId: 0,                   // no turn open at inject time; entries don't pin turnId
            writer: "plurnk",
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            tokenize: this.#tokenize,
            pushNotice: (notice) => this.#notices.push(workspaceRow.workspace_id, loopId, notice),
        };
        const entry: EntryData = {
            channels: { body: { content: prompt, mimetype: "text/markdown" } },
            tags: [],
            attributes: { openPaths },
        };
        await EntryCrud.writeEntry(pathname, entry, ctx, "prompt", workerId);
        return { loopId, turnSeq };
    }

    //  — can this op open a wake edge mid-turn? The grounding scan for a
    // same-turn spawn-then-hibernate: an EXEC (stream conclusion / poll cadence wakes), a COPY to
    // worker:// (child-conclusion wake, {§worker-lifecycle-child-wake}), a directed SEND to worker:// (irc — the
    // addressee can act and conclude back), or an http READ (a web fetch streams into a subscription).
    // Conservative on purpose: a false PERMIT risks a dead park only in the spawn-failed corner; a
    // false REFUSE breaks legitimate hibernation.

    // A worker "holds a live thing" iff it has an open stream/spawn (subscription registry or an
    // exec spawn) OR a non-terminal child worker — the structured-concurrency invariant a terminal
    // SEND must respect ({§send-premature-terminate}, {§worker-loop-lifecycle}:
    // children and streams are the same kind of live thing a worker holds).
}
