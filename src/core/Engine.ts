import { PlurnkParser, PlurnkParseError, parsePath } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement, ParsedPath, LineMarker, PlurnkOp, EditStatement, ReadStatement, UrlPath, MatcherBody } from "@plurnk/plurnk-grammar";

// Internal-only — collected from PlurnkParser output, then translated to
// TelemetryEvent envelopes (per @plurnk/plurnk-grammar 0.17.0 protocol)
// before being pushed to the loop's telemetry buffer.
type ParseErrorInfo = { message: string; line: number; column: number; source: string };
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "./Db.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import EntryManifest from "../schemes/_entry-manifest.ts";
import GitMembership, { type FsDivergence } from "./git-membership.ts";
import GitState, { type GitStatus } from "./git-state.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext, LoopFlags } from "./scheme-types.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import { DEFAULT_LOOP_FLAGS } from "./scheme-types.ts";
import type { StreamEventNotify, TelemetryEventNotify, WakeRunNotify } from "./ChannelWrite.ts";
import { LineMarkerOps, MimetypeBinary, editedSpan } from "../content/index.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import Paths from "../Paths.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";

// SPEC §scheme-surface: writer must be in target scheme's manifest.writableBy.
// OPEN/FOLD/READ/FIND are not gated — they curate the log or read, never mutating an entry.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "EXEC", "KILL"]);

const DEFAULT_MAX_STRIKES = 3;
const DEFAULT_MAX_COMMANDS = 99;
const DEFAULT_BUDGET_CEILING = 0.9;

// Substituted into the budget readout after the assembled packet is measured
// (the figure depends on the packet's own rendered size — chicken/egg).
const TOKENS_FREE_PLACEHOLDER = "{{tokensFree}}";
const TOKEN_USAGE_PLACEHOLDER = "{{tokenUsage}}";
const TOKEN_PERCENT_PLACEHOLDER = "{{tokenPercent}}";

// PLURNK_BUDGET_CEILING is dual-mode: <=1 is a fraction of the provider's
// context window, >1 is an absolute token wall — lets a demo pin a tiny
// ceiling regardless of the model's real window to force the grinder.
const readCeiling = (): number => {
    const raw = process.env.PLURNK_BUDGET_CEILING;
    if (raw === undefined || raw.length === 0) return DEFAULT_BUDGET_CEILING;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUDGET_CEILING;
    return n;
};

const readMaxStrikes = (): number => {
    const raw = process.env.PLURNK_MAX_STRIKES;
    if (raw === undefined || raw.length === 0) return DEFAULT_MAX_STRIKES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STRIKES;
    return n;
};

const readMaxCommands = (): number => {
    const raw = process.env.PLURNK_MAX_COMMANDS;
    if (raw === undefined || raw.length === 0) return DEFAULT_MAX_COMMANDS;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_COMMANDS;
    return n;
};

// PLURNK_MANIFEST_ITEMS — the turn-0 manifest preview. null = off (no foist);
// -1 = the full manifest; positive N = the first N items. 0 / unset = off.
const readManifestItems = (): number | null => {
    const raw = process.env.PLURNK_MANIFEST_ITEMS;
    if (raw === undefined || raw.length === 0) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n === 0) return null;
    return n < 0 ? -1 : n;
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { Provider, ProviderResponse, ProviderAssistant, ProviderUsage } from "@plurnk/plurnk-providers";

// packet.assistant shape per plurnk-grammar 0.6.0 Packet.json. Wire-level
// call-metadata (usage, finishReason, model) is NOT here — those are
// properties of the call and live on the Turn row, alongside Turn.usage.
type PacketAssistant = {
    content: string;
    ops: PlurnkStatement[];
    reasoning: string | null;
};

// Spec'd packet (Packet.json) sans the assistant + assistantRaw fields,
// which aren't known until the provider responds. Engine builds this
// before the call (so the wire projection has a source) and completes
// it with the response section after. Two consumers: serialized to
// ChatMessage[] via #packetToWireMessages, and stored in turns.packet
// (via #completePacket) as the canonical record of the exchange.
type RequestPacket = {
    system: {
        tokens: number;
        system_definition: string;
        log: object[];
    };
    user: {
        tokens: number;
        prompt: string;
        telemetry: { budget: string; errors: object[] };
        // Static per-turn rules block, rendered at the bottom of the user
        // packet as `# Plurnk System Requirements`. Caller sources from
        // Paths.defaultRequirements (PLURNK_REQUIREMENTS env override →
        // requirements.md package default).
        system_requirements: string;
    };
};

// Split-out call-metadata that travels with the parsed packet but lands in
// Turn columns instead of packet.assistant.
type TurnCallMetadata = {
    usage: ProviderUsage;
    finishReason: string | null;
    model: string;
};

type DispatchContext = {
    statement: PlurnkStatement;
    sessionId: number;
    runId: number;
    loopId: number;
    turnId: number;
    sequence: number;
    origin: WriterTier;
    onDispatch?: (logEntryId: number) => void;
};

type DispatchResult = { status: number; attrs?: object; [key: string]: unknown };

// Proposal lifecycle types. A scheme returns DispatchResult{status:202,attrs}
// to propose; engine writes a state='proposed' log entry, registers a waiter
// in #pendingProposals, and awaits resolution. Resolution arrives via
// Engine.resolveProposal(id, decision, body?) — from the loop/resolve RPC
// (Phase E.2), the in-tree YOLO listener (Phase E.3), or a timeout.
export type ProposalDecision = "accept" | "reject" | "cancel";
export interface ProposalResolution {
    decision: ProposalDecision;
    // Final body the resolver wants written/applied (e.g., reviewer-
    // edited content). INPUT to applyResolution; not in the model-facing
    // rx — the model sees the result via the entry/index now (post-F.5
    // and EDIT-registers-entry), not via input echoes.
    body?: string;
    // Operational reason (rejected / timeout / policy_veto / etc.).
    // Stored on log_entries.outcome COLUMN for forensics; NOT included
    // in the rx body — model doesn't need to know administratively how
    // a proposal was resolved (per AGENTS.md hygiene rule).
    outcome?: string;
}
interface ProposalWaiter {
    resolve: (resolution: ProposalResolution) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

// External observers of pending-proposal events. sessionId is included so
// Daemon can scope its WS broadcast. attrs is the scheme-supplied payload
// (file diff, exec command, etc.) the client needs to render review UI.
// flags carries the loop's persisted flags so listeners (YOLO auto-accept,
// the client-facing notification) can decide policy without a second DB
// roundtrip — loaded once in Engine, shared with all listeners.
export interface ProposalPendingEvent {
    logEntryId: number;
    sessionId: number;
    runId: number;
    loopId: number;
    turnId: number;
    op: string;
    target: { scheme: string | null; pathname: string | null };
    body: string;
    attrs: object;
    flags: LoopFlags;
}

// Resolution timeout — proposed entries auto-cancel if nothing arrives
// within this window. SPEC.md §engine-rails (proposal lifecycle) + §methods (loop.resolve).
const PROPOSAL_TIMEOUT_DEFAULT_MS = 300000;
const readProposalTimeoutMs = (): number => {
    const raw = process.env.PLURNK_PROPOSAL_TIMEOUT_MS;
    if (raw === undefined || raw.length === 0) return PROPOSAL_TIMEOUT_DEFAULT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return PROPOSAL_TIMEOUT_DEFAULT_MS;
    return n;
};

type SchemeMethod = (statement: PlurnkStatement, ctx: PlurnkSchemeContext) => Promise<DispatchResult>;

interface SchemeWithCrud {
    readEntry?: (pathname: string, ctx: PlurnkSchemeContext) => Promise<ReadEntryResult>;
    writeEntry?: (pathname: string, entry: EntryData, ctx: PlurnkSchemeContext) => Promise<WriteEntryResult>;
    deleteEntry?: (pathname: string, ctx: PlurnkSchemeContext) => Promise<DeleteEntryResult>;
}

const pathnameFromPath = (path: ParsedPath): string => {
    if (path.kind === "url") return path.pathname;
    return path.raw;
};

// Default turn.status when ops were emitted but no SEND. Model is implicitly
// continuing; loop.status stays 102 either way (only SEND broadcast advances
// loop terminal). No strike, no telemetry.
const TURN_STATUS_IMPLICIT_CONTINUE = 102;

// Status assigned to a turn that emitted NO ops at all. Strike-worthy; the
// action routes through telemetry.errors[] (§telemetry, §telemetry-no-error-scheme — never an error:// scheme).
const TURN_STATUS_NO_OPS = 422;

// Rail #38: action-entry statuses that DON'T accumulate strikes. Model adapted
// to a finding (not_found, op_not_supported); no penalty. Rummy parallel:
// SOFT_FAILURE_OUTCOMES = {"not_found", "unparsed"}.
const SOFT_FAILURE_STATUSES: ReadonlySet<number> = new Set([404, 501]);

const DEFAULT_MIN_CYCLES = 3;
const DEFAULT_MAX_CYCLE_PERIOD = 4;

const readPositiveInt = (envVar: string, fallback: number): number => {
    const raw = process.env[envVar];
    if (raw === undefined || raw.length === 0) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return n;
};

// Per-op fingerprint: op verb + target URI, plus an op-specific discriminator
// where the activity isn't fully captured by target alone:
//   - EDIT/COPY/MOVE: body excluded — re-writing the same target with varied
//     content IS cycling (the model is producing different versions of the
//     same artifact instead of progressing).
//   - FIND/READ/OPEN/FOLD: body IS the search/selection pattern; varied
//     matchers on the same target ARE different activities (the model is
//     exploring different queries, not repeating one).
const fingerprintOp = (stmt: PlurnkStatement): string => {
    const path = stmt.target;
    const matcherDiscriminator = (): string => {
        // For matcher-bearing ops, the body's `raw` (matcher source) plus
        // any lineMarker forms the activity discriminator.
        const parts: string[] = [];
        const body = (stmt as { body?: { raw?: unknown } | string | null }).body;
        if (body !== null && typeof body === "object" && typeof body.raw === "string") {
            parts.push(`body:${body.raw.slice(0, 64)}`);
        }
        const lm = (stmt as { lineMarker?: { first: number; last: number | null } | null }).lineMarker;
        if (lm !== null && lm !== undefined) parts.push(`L:${lm.first},${lm.last ?? ""}`);
        return parts.length > 0 ? `|${parts.join("|")}` : "";
    };
    if (path === null) {
        // Path-less ops need an activity-defining discriminator other
        // than `target`. Picked per op so the cycle detector reflects
        // intent rather than syntax:
        //   - EXEC: the command body IS the activity. Without a body
        //     digest, varied shell commands (find / ls / wc) collapse to
        //     one fingerprint and the detector mislabels exploration
        //     as a loop.
        //   - SEND: the status code (signal) IS the activity. Different
        //     SEND[X] are different intentions; same SEND[X] with
        //     different message bodies is the same termination signal.
        if (stmt.op === "EXEC") {
            const body = typeof stmt.body === "string" ? stmt.body : "";
            return `EXEC|(no-path)${body.length > 0 ? `|body:${body.slice(0, 64)}` : ""}`;
        }
        if (stmt.op === "SEND") {
            const signal = typeof stmt.signal === "number" ? stmt.signal : "";
            return `SEND|(no-path)|signal:${signal}`;
        }
        return `${stmt.op}|(no-path)`;
    }
    const base = path.kind === "url"
        ? `${stmt.op}|${path.scheme}://${path.pathname}`
        : `${stmt.op}|local:${path.raw}`;
    if (stmt.op === "FIND" || stmt.op === "READ" || stmt.op === "OPEN" || stmt.op === "FOLD") {
        return `${base}${matcherDiscriminator()}`;
    }
    return base;
};

export default class Engine {
    static computeCeiling(contextSize: number | null, config: number): number | null {
        // Absolute wall (config > 1) is window-independent — the point of the >1
        // mode is to pin a ceiling even when the provider reports no window; cap at
        // the real window when one is known. Ratio mode needs a window to scale.
        if (config > 1) return contextSize === null ? Math.floor(config) : Math.min(Math.floor(config), contextSize);
        return contextSize === null ? null : Math.floor(contextSize * config);
    }

    // Per-turn fingerprint: sorted set of per-op fingerprints, joined. Order
    // within a turn doesn't matter — we want the SET of activities.
    static fingerprintTurn(ops: ReadonlyArray<PlurnkStatement>): string {
        return ops.map(fingerprintOp).toSorted().join(",");
    }

    // Rail #39 cycle detector. For each candidate period k in [1, maxCyclePeriod],
    // check whether the last k*minCycles entries form minCycles repetitions of the
    // same length-k pattern. O(maxCyclePeriod × minCycles × max k) ≈ tiny. Rummy
    // parallel: src/plugins/error/error.js detectCycle.
    static detectCycle(
        history: ReadonlyArray<string>,
        minCycles: number,
        maxCyclePeriod: number,
    ): { detected: false } | { detected: true; period: number; cycles: number } {
        for (let k = 1; k <= maxCyclePeriod; k++) {
            const needed = k * minCycles;
            if (history.length < needed) continue;
            const tail = history.slice(-needed);
            const cycle = tail.slice(0, k);
            let match = true;
            outer: for (let rep = 0; rep < minCycles; rep++) {
                for (let j = 0; j < k; j++) {
                    if (tail[rep * k + j] !== cycle[j]) { match = false; break outer; }
                }
            }
            if (match) return { detected: true, period: k, cycles: minCycles };
        }
        return { detected: false };
    }

    #db: Db;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #budgetCeiling: number;
    // Write-time tokenizer (SPEC §tokenomics). Synchronous per the provider
    // contract (§provider-surface). Populated from the active provider's countTokens via
    // the Daemon; a divisor tripwire stands in only for bare/standalone
    // construction before a provider is wired (same boot affordance as
    // Mimetypes, §mimetype-surface). Real counts come from provider.countTokens.
    #tokenize: (text: string) => number;
    // Boot-discovered runtime executors. Daemon builds + sets via
    // setExecutors at start(); undefined until then (and in bare tests).
    #executors: ExecutorRegistry | undefined;
    // Per-loop transient buffer of actionless failures pending surface in the
    // NEXT packet's user.telemetry.errors[]. Drained by #buildTelemetryErrors.
    // Map<loopId, TelemetryError[]>. SPEC §telemetry.
    #telemetryBuffer = new Map<number, object[]>();
    // Rail #38 strike state per loop. `streak` = consecutive struck turns;
    // resets on a clean turn. `turnErrors` is bumped externally by per-turn
    // rails (cycle detection #39, etc.) — read and reset at end of each turn.
    // `history` holds per-turn fingerprints for rail #39 cycle detection.
    #strikeState = new Map<number, { streak: number; turnErrors: number; history: string[] }>();
    // Proposal lifecycle: pending dispatch pauses waiting for resolution.
    // Engine.runTurn awaits the promise when a scheme returns status 202;
    // Engine.resolveProposal feeds the resolution back in. Map is per-log-
    // entry-id; entries clear on resolution. SPEC.md §engine-rails + §methods (loop.resolve).
    #pendingProposals = new Map<number, ProposalWaiter>();
    // External observers of proposal lifecycle events. Daemon subscribes
    // here to push `loop/proposal` notifications when an entry enters
    // pending state. YOLO listener (Phase E.3) subscribes here too. Lean
    // event emitter — no priority, no veto chain at this layer; filter
    // chains come later if a real consumer needs them.
    #proposalPendingListeners: Array<(payload: ProposalPendingEvent) => void> = [];

    // Per-loop AbortController for cancellation propagation into scheme
    // ctx.signal. runLoop creates one at entry, cleans up at end. Engine
    // cancellation paths (strikes, max_turns, external) abort it.
    // Streaming schemes (exec) chain their per-spawn controllers off
    // ctx.signal so cancelled loops tear down their background spawns.
    #loopAborts = new Map<number, AbortController>();

    #streamEventNotify: StreamEventNotify | undefined;
    #wakeRunNotify: WakeRunNotify | undefined;
    // Telemetry event fan-out: every TelemetryEvent pushed to the loop's
    // buffer is also broadcast live to the connected client(s) on the
    // session. Without this, the client sees `loop/terminated` with a
    // status code but has no way to surface why the loop degraded.
    // Per-grammar 0.17.0 protocol — see SPEC §telemetry.
    #telemetryEventNotify: TelemetryEventNotify | undefined;

    // Cached plurnk GBNF — read once on the first constrained generate (#189).
    #gbnfCache: string | null = null;

    constructor({ db, schemes, mimetypes, streamEventNotify, wakeRunNotify, telemetryEventNotify, tokenize }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes?: Mimetypes;
        streamEventNotify?: StreamEventNotify;
        wakeRunNotify?: WakeRunNotify;
        telemetryEventNotify?: TelemetryEventNotify;
        tokenize?: (text: string) => number;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeRunNotify = wakeRunNotify;
        this.#telemetryEventNotify = telemetryEventNotify;
        // Default to empty discovery — standalone Engine construction (in
        // tests) gets no handlers, and content flows through the framework's
        // raw-content fitContent fallback. Daemon-managed Engine receives a
        // production-configured Mimetypes via the constructor arg.
        this.#mimetypes = mimetypes ?? new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map() },
        });
        this.#budgetCeiling = readCeiling();
        // Tripwire default matches the Mimetypes boot affordance (SPEC §mimetype-surface):
        // the divisor stands in only until the provider-backed tokenizer is
        // wired by the Daemon. Real counts come from provider.countTokens.
        this.#tokenize = tokenize ?? ((text) => Math.ceil(text.length / 4));
    }

    // Late injection: the executor registry is async-built at daemon start()
    // (discover + probe), after Engine construction.
    setExecutors(executors: ExecutorRegistry): void {
        this.#executors = executors;
    }

    // Grammar-constrained sampling (#189): when PLURNK_PROVIDERS_GBNF is enabled
    // (the only knob — default-on in .env.example), hand the provider the plurnk
    // GBNF (the full shipped multi-op root, read once + cached). The provider
    // attaches it iff the backend supports it and silently drops it otherwise —
    // capability is providers' concern, not ours. Pure plumbing grammar→provider.
    async #grammarConstraint(): Promise<string | undefined> {
        // PLURNK_PROVIDERS_GBNF SELECTS the GBNF variant to constrain sampling to (#225):
        // a bare name (`plurnk-strict.gbnf` | `plurnk.gbnf`) is a variant shipped by
        // @plurnk/plurnk-grammar; an absolute/relative path is a BYO grammar. Empty or "0"
        // disables — unconstrained generation. (Was a `=== "1"` boolean; the value change
        // would otherwise read as "off", leaving every turn unconstrained.)
        const variant = process.env.PLURNK_PROVIDERS_GBNF;
        if (variant === undefined || variant === "" || variant === "0") return undefined;
        if (this.#gbnfCache === null) {
            const path = variant.startsWith("/") || variant.startsWith(".")
                ? variant
                : fileURLToPath(import.meta.resolve(`@plurnk/plurnk-grammar/${variant}`));
            this.#gbnfCache = await readFile(path, "utf8");
        }
        return this.#gbnfCache;
    }

    // Per-loop usage totals (#197): SUM the loop's turns (usage is stored per
    // turn, §tokenomics). Surfaced on loop.run + loop/terminated so clients render real
    // token/cost numbers. costPico is the stored pico-dollar unit.
    async loopUsage(loopId: number): Promise<{ promptTokens: number; completionTokens: number; costPico: number }> {
        const row = await (this.#db.engine_loop_usage as PrepMethod).get<{ prompt: number; completion: number; cost_pico: number }>({ loop_id: loopId });
        return {
            promptTokens: row?.prompt ?? 0,
            completionTokens: row?.completion ?? 0,
            costPico: row?.cost_pico ?? 0,
        };
    }

    #pushTelemetry(sessionId: number, loopId: number, event: object): void {
        const existing = this.#telemetryBuffer.get(loopId);
        if (existing === undefined) this.#telemetryBuffer.set(loopId, [event]);
        else existing.push(event);
        // Live fan-out: client sees the event the moment it lands in the
        // model's buffer (not at the next packet build). Same envelope on
        // both sides per the grammar 0.17.0 TelemetryEvent protocol.
        this.#telemetryEventNotify?.(sessionId, { loopId, event });
    }

    // Telemetry drains as it's read into the packet — each event surfaces once. §telemetry-drain-on-read
    #drainTelemetry(loopId: number): object[] {
        const buf = this.#telemetryBuffer.get(loopId);
        if (buf === undefined) return [];
        this.#telemetryBuffer.delete(loopId);
        return buf;
    }

    // Pull a ±windowLines context block around `targetLine` (1-based) from
    // `content`, formatted with N:\t prefixes — same shape the model
    // already knows from READ output and numbered Index entries. Used to
    // give parse_error telemetry concrete locality: the model sees what
    // it wrote on the offending line, not just an abstract error message.
    //
    // Lenient: targetLine ≤ 0 clamps to 1; targetLine beyond content
    // returns whatever overlap exists; empty content returns "".
    #extractSnippet(content: string, targetLine: number, windowLines: number): string {
        if (content.length === 0) return "";
        const lines = content.split("\n");
        const target = Math.max(1, targetLine);
        const start = Math.max(1, target - windowLines);
        const end = Math.min(lines.length, target + windowLines);
        const slice = [];
        for (let i = start; i <= end; i++) {
            slice.push(`${i}:\t${lines[i - 1] ?? ""}`);
        }
        return slice.join("\n");
    }

    async runLoop({
        provider, messages, requirements = "", sessionId, runId, loopId,
        maxTurns = 50, maxStrikes = readMaxStrikes(),
        minCycles = readPositiveInt("PLURNK_MIN_CYCLES", DEFAULT_MIN_CYCLES),
        maxCyclePeriod = readPositiveInt("PLURNK_MAX_CYCLE_PERIOD", DEFAULT_MAX_CYCLE_PERIOD),
        origin = "model", signal, onDispatch,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        // packet.user.system_requirements content. Rendered at the end of
        // the user packet under `# Plurnk System Requirements`. Caller
        // sources from Paths.defaultRequirements.
        requirements?: string;
        sessionId: number; runId: number; loopId: number;
        maxTurns?: number;
        maxStrikes?: number;
        minCycles?: number;
        maxCyclePeriod?: number;
        origin?: WriterTier;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
    }): Promise<{ turnIds: number[]; finalStatus: number; hitMaxTurns: boolean; reason: "max_turns" | "strike_threshold" | "budget_overflow" | "external" | null }> {
        const turnIds: number[] = [];
        const suddenDeathThreshold = maxTurns - maxStrikes;

        // Per-loop AbortController for scheme-side cancellation propagation.
        // Chained from the caller's `signal` so an external abort cascades.
        const loopAbort = new AbortController();
        if (signal !== undefined) {
            if (signal.aborted) loopAbort.abort(signal.reason);
            else signal.addEventListener("abort", () => loopAbort.abort(signal.reason), { once: true });
        }
        this.#loopAborts.set(loopId, loopAbort);

        // Cleanup splits by termination kind:
        // - "graceful" (loop emitted SEND[2xx]): in-flight streaming-scheme
        //   spawns are ALLOWED to outlive the loop. They complete naturally,
        //   write final channel state, and wake-on-completion (E.4) opens a
        //   fresh loop in the same run if the model needs to react.
        // - "forceful" (max_turns, strike_threshold, external cancel,
        //   non-2xx loop status): fire the loop-level abort so spawns
        //   tear down immediately.
        const cleanup = (kind: "graceful" | "forceful", reason?: string): void => {
            if (kind === "forceful" && !loopAbort.signal.aborted) {
                loopAbort.abort(reason ?? "loop_forceful_termination");
            }
            this.#loopAborts.delete(loopId);
            this.#strikeState.delete(loopId);
            this.#telemetryBuffer.delete(loopId);
        };

        while (true) {
            signal?.throwIfAborted();

            const row = await (this.#db.engine_loop_status as PrepMethod).get<{ status: number }>({ loop_id: loopId });
            if (row === undefined) throw new Error(`Engine.runLoop: loop ${loopId} not found`);
            if (row.status !== 102) {
                // Status 2xx = graceful (model said done); 4xx/5xx = forceful
                // (external cancel or upstream failure). The threshold splits
                // at 400 to match HTTP success/error semantics.
                cleanup(row.status < 400 ? "graceful" : "forceful", `loop_terminal_${row.status}`);
                return { turnIds, finalStatus: row.status, hitMaxTurns: false, reason: "external" };
            }

            if (maxTurns >= 0 && turnIds.length >= maxTurns) {
                await (this.#db.engine_loop_cancel as PrepMethod).run({ loop_id: loopId });
                cleanup("forceful", "max_turns");
                return { turnIds, finalStatus: 499, hitMaxTurns: true, reason: "max_turns" };
            }

            // PLURNK_EXEC_WAIT_MS — a post-EXEC breath: if a spawn from the prior turn
            // is still in flight, give it a tunable beat to land in THIS turn's packet
            // before we assemble it. A fixed grace beat, never a wait-for-completion;
            // 0/unset = off. Abortable with the loop signal.
            const execWaitMs = Number(process.env.PLURNK_EXEC_WAIT_MS ?? "0");
            if (execWaitMs > 0) {
                const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (runId: number) => boolean } | undefined;
                if (execHandler?.hasActiveSpawns?.(runId) === true) await delay(execWaitMs, undefined, { signal });
            }

            const turn = await this.runTurn({
                provider, messages, requirements, sessionId, runId, loopId, origin, signal, onDispatch,
                turnNumber: turnIds.length + 1, maxTurns,
            });
            turnIds.push(turn.turnId);

            // SPEC §grinder: budget hard-stop — packet won't fit even collapsed → abandon.
            if (turn.budgetHardStop) {
                await (this.#db.engine_loop_cancel as PrepMethod).run({ loop_id: loopId });
                cleanup("forceful", "budget_overflow");
                return { turnIds, finalStatus: 499, hitMaxTurns: false, reason: "budget_overflow" };
            }

            // Rail #39: cycle detection. Push this turn's fingerprint to
            // history, scan for repetition patterns. Detection bumps
            // turnErrors so the strike system handles abandonment
            // naturally — same internal-only role rummy gave it
            // (plugins/error/error.js#verdict). Intentionally NOT a
            // model-facing telemetry kind: model sees the strike pile-up
            // (which IS the actionable signal); cycle is the engine's
            // reason for treating the turn as a failure, not its own alert.
            const state = this.#strikeState.get(loopId) ?? { streak: 0, turnErrors: 0, history: [] };
            state.history.push(turn.fingerprint);
            const cycle = Engine.detectCycle(state.history, minCycles, maxCyclePeriod);
            if (cycle.detected) state.turnErrors++;
            // SPEC §grinder: a non-soft grinder fire counts toward the strike streak.
            if (turn.budgetStruck) state.turnErrors++; // a grinder fire bumps the strike streak — §grinder-strike-coupling
            this.#strikeState.set(loopId, state);

            // Rail #38: strike accounting. Three sources strike a turn:
            //  1. recordedFailed — any action-entry at hard failure status
            //     (>= 400 and not in SOFT_FAILURE_STATUSES).
            //  2. noOps — turn.status === TURN_STATUS_NO_OPS (per #41).
            //  3. turnErrors — externally bumped by per-turn rails (#39 cycle).
            // Struck → streak++; clean → streak = 0. Threshold → abandon.
            // Strike accounting is engine-internal bookkeeping. Per rummy
            // precedent (plugins/error/error.js#verdict) and SPEC §telemetry
            // policy: model sees errors that happened (parse_error,
            // action_failure), never the engine's accounting about them
            // (strike counts, cycle detection, sudden-death threshold).
            // Surfacing internal state to the model creates a gamification
            // surface — model optimizes for engine metrics rather than
            // task progress.
            const recordedFailed = turn.statuses.some((s) => s >= 400 && !SOFT_FAILURE_STATUSES.has(s));
            const noOps = turn.status === TURN_STATUS_NO_OPS;
            const struck = noOps || recordedFailed || state.turnErrors > 0;
            if (struck) {
                state.streak++;
                if (state.streak >= maxStrikes) {
                    await (this.#db.engine_loop_cancel as PrepMethod).run({ loop_id: loopId });
                    cleanup("forceful", "strike_threshold");
                    return { turnIds, finalStatus: 499, hitMaxTurns: false, reason: "strike_threshold" };
                }
            } else {
                state.streak = 0;
            }
            state.turnErrors = 0;
            this.#strikeState.set(loopId, state);

            // Sudden-death threshold is engine-internal — abandonment
            // happens at maxTurns regardless. Per gamification policy:
            // we don't warn the model that it's nearing our limit.
            if (turnIds.length >= suddenDeathThreshold && turnIds.length < maxTurns) {
                // Threshold tripped; engine bookkeeping only.
            }
        }
    }

    async runTurn({
        provider, messages, requirements = "", sessionId, runId, loopId, origin = "model", signal, onDispatch,
        turnNumber = 1, maxTurns = 50,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        requirements?: string;
        sessionId: number; runId: number; loopId: number;
        origin?: WriterTier;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        // Position in the surrounding loop. Used to build per-turn LLM
        // context: turn 1 carries the initial user prompt verbatim; turn
        // N>1 substitutes a continuation marker (rummy's pattern). Both
        // are augmented with the durable state (index/log/telemetry).
        turnNumber?: number;
        maxTurns?: number;
    }): Promise<{ turnId: number; status: number; statuses: number[]; fingerprint: string; budgetStruck: boolean; budgetHardStop: boolean }> {
        // === Turn-as-container model ===
        //
        // Turn rows are created at runTurn OPEN (status=102, placeholder
        // packet) so things can be written into the turn before the model
        // is called: the user prompt on turn 1; later, system signals or
        // injected telemetry events on any turn. The turn is CLOSED at
        // the end with the final packet + status + usage stats.
        //
        // sequence is "ordinal of stuff in this turn." Pre-model
        // writes consume low indices; model ops continue from there.
        const seqRow = await (this.#db.engine_next_turn_sequence as PrepMethod).get<{ next: number }>({ loop_id: loopId });
        const seq = (seqRow as { next: number }).next;
        const openRow = await (this.#db.engine_open_turn as PrepMethod).get<{ id: number }>({
            loop_id: loopId, sequence: seq,
        });
        if (openRow === undefined) throw new Error("Engine.runTurn: turn open returned no row");
        const turnId = openRow.id;

        // Pre-model writes. Each turn opens with a system-origin EDIT
        // against `plurnk:///prompt/<loop_id>/<seq>` IF there's a prompt
        // for THIS turn the model hasn't seen yet:
        //   - Turn 1: loop.prompt is the initial user prompt.
        //   - Turn N>1: only if Engine.inject (or wake-on-completion via
        //     daemon.inject) wrote a prompt entry for this turn slot
        //     between turn N-1 and N. Inject writes directly to entries;
        //     we DON'T re-foist here for N>1.
        // The log records the EDIT for forensics. Model ops dispatch
        // from sequence=2 onward on prompt-foisted turns; 1 onward
        // otherwise.
        let nextActionIndex = 1;
        if (seq === 1) {
            // Operator doc READs (PLURNK_MD_<ALIAS>, §actor-boundary-doc-injection). The docs were materialized
            // as plurnk:///<entry> entries by the plurnk run (loop_run, via the
            // §actor-boundary keystone); foist a READ of each into THIS turn-0 so the model
            // reads them inline. It sees only the READ — the materializing EDIT
            // lives in the plurnk run's log, never the model's.
            for (const doc of Paths.docs()) {
                const docTarget: UrlPath = {
                    kind: "url", raw: `plurnk:///${doc.entryName}`, scheme: "plurnk",
                    username: null, password: null, hostname: null, port: null,
                    pathname: `/${doc.entryName}`, params: {}, fragment: null,
                };
                const docRead: ReadStatement = {
                    op: "READ", suffix: "", signal: null, target: docTarget,
                    lineMarker: null, body: null, position: { line: 1, column: 1 },
                };
                await this.dispatch({
                    statement: docRead, sessionId, runId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk", onDispatch,
                });
                nextActionIndex++;
            }
            const promptRow = await (this.#db.engine_get_loop_prompt as PrepMethod).get<{ prompt: string; sequence: number }>({ loop_id: loopId });
            if (promptRow !== undefined && typeof promptRow.prompt === "string" && promptRow.prompt.length > 0) {
                const promptPath: UrlPath = {
                    kind: "url", raw: `plurnk:///prompt/${loopId}/${seq}`,
                    scheme: "plurnk", username: null, password: null,
                    hostname: null, port: null,
                    pathname: `/prompt/${loopId}/${seq}`, params: {}, fragment: null,
                };
                const promptStmt: EditStatement = {
                    op: "EDIT", suffix: "", signal: null,
                    target: promptPath, lineMarker: null,
                    body: promptRow.prompt, position: { line: 1, column: 1 },
                };
                await this.dispatch({
                    statement: promptStmt, sessionId, runId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk", onDispatch,
                });
                nextActionIndex++;
            }
        }

        // plurnk:///manifest.json — rewritten EVERY turn (a live view of the
        // entry set, which changes each turn). A derived view like the index,
        // NOT an action — written directly (Engine.inject's path): no log entry,
        // no sequence slot, not dispatched. The catalog body is built in the
        // schemes layer (_entry-manifest); the engine only orchestrates the
        // per-turn write. Does not list itself.
        const systemCtx: PlurnkSchemeContext = {
            db: this.#db, sessionId, runId, loopId, turnId,
            writer: "plurnk",
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeRunNotify: this.#wakeRunNotify,
            tokenize: this.#tokenize,
            mimetypes: this.#mimetypes,
            pushTelemetry: (event) => this.#pushTelemetry(sessionId, loopId, event),
        };
        // SPEC §membership D4/D5 — git-ls-files workspace membership, resolved at
        // prompt-composition (EMI is eager + exhaustive — git is the only bound). When the
        // session's project_root is a git working tree, tracked files are
        // members without a client `add`; active members are materialized
        // (disk → body channel) so they appear in the manifest below. No-ops
        // on headless / non-git sessions. Runs BEFORE the manifest write so
        // this turn's packet reflects them.
        const fsDivergences = await GitMembership.indexGitMembership(systemCtx);
        await this.#logFsFictions(sessionId, fsDivergences);

        await EntryCrud.writeEntry("/manifest.json", {
            channels: { body: { content: await EntryManifest.buildManifestBody(systemCtx), mimetype: "application/json" } },
            tags: [],
        }, systemCtx, "plurnk");

        // Manifest preview (PLURNK_MANIFEST_ITEMS, §actor-boundary-manifest-preview):
        // a turn-0 foisted READ of the just-built catalog so a run opens with what's
        // available, not blank. -1 → full; N → the first N items (jsonpath slice — the
        // manifest is JSON); off by default. AFTER the manifest write so the READ hits
        // it, not a 404; same plurnk-origin foist as the operator docs.
        if (seq === 1) {
            const manifestItems = readManifestItems();
            if (manifestItems !== null) {
                const manifestRead: ReadStatement = {
                    op: "READ", suffix: "", signal: null, lineMarker: null,
                    target: {
                        kind: "url", raw: "plurnk:///manifest.json", scheme: "plurnk",
                        username: null, password: null, hostname: null, port: null,
                        pathname: "/manifest.json", params: {}, fragment: null,
                    },
                    body: manifestItems < 0 ? null : { dialect: "jsonpath", raw: `$[0:${manifestItems}]` } as MatcherBody,
                    position: { line: 1, column: 1 },
                };
                await this.dispatch({
                    statement: manifestRead, sessionId, runId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk", onDispatch,
                });
                nextActionIndex++;
            }
        }

        // §env-delta — pre-seed environment deltas (changes since this run last
        // reconciled) as system EDIT rows, before the packet composes; advance
        // the action index past them so model ops continue after.
        nextActionIndex += await this.#materializeEnvironmentDeltas({ sessionId, runId, loopId, turnId, fromSequence: nextActionIndex });

        // SPEC §telemetry — git working-tree state for the telemetry section, read once
        // (a service-side `git status` shell-out) and threaded into the budget
        // rebuild too so it isn't re-shelled on overflow.
        const gitStatus = await GitState.status(this.#db, sessionId, this.#loopAborts.get(loopId)?.signal);

        // Build the spec'd packet (Packet.json) request half. #buildLog
        // queries log_entries scoped to the run — the prompt entry just
        // written (if turn 1) is part of that query result.
        let requestPacket = await this.#buildRequestPacket({
            initialMessages: messages, requirements, runId, loopId,
            currentTurnSeq: seq, provider, gitStatus,
        });
        // SPEC §grinder — budget grinder, pre-LLM: reclaim window on actual overflow.
        const enforced = await this.#enforceBudget({
            packet: requestPacket, provider, runId, loopId, turnId, sessionId, turnNumber,
            rebuild: (telemetryErrors) => this.#buildRequestPacket({
                initialMessages: messages, requirements, runId, loopId,
                currentTurnSeq: seq, provider, telemetryErrors, gitStatus,
            }),
        });
        requestPacket = enforced.packet;
        if (!enforced.fit) {
            // Hard 413: won't fit even with only the manifest left. Skip the LLM,
            // close the turn, and let runLoop abandon (499).
            const hardPacket = this.#completePacket(requestPacket, { content: "", ops: [], reasoning: null }, null, provider);
            await (this.#db.engine_close_turn as PrepMethod).run({
                id: turnId, status: 413, packet: JSON.stringify(hardPacket),
                usage_prompt: 0, usage_completion: 0, usage_cached: 0, usage_cost_pico: 0,
                finish_reason: "budget_hard_stop", model: provider.model,
            });
            return { turnId, status: 413, statuses: [], fingerprint: "", budgetStruck: enforced.struck, budgetHardStop: true };
        }
        const modelMessages = this.#packetToWireMessages(requestPacket);
        // maxTokens = remaining context window (loop policy, plurnk-providers#10).
        // The 0.28.0 EOS-forcing root terminates the turn at the status SEND, but a
        // grammar can't bound degeneration *inside* a statement body — this caps the
        // decode at the free window so a runaway can't reach the context wall.
        const genCeiling = Engine.computeCeiling(provider.contextSize, this.#budgetCeiling); // provider.contextSize, the immutable identity, read by the budget — §provider-surface-identity
        const maxTokens = genCeiling === null ? undefined : Math.max(1, genCeiling - requestPacket.system.tokens - requestPacket.user.tokens);
        const response = await provider.generate({ messages: modelMessages, runId: String(runId), signal, grammar: await this.#grammarConstraint(), maxTokens }); // §provider-surface-generate §provider-guarantees-single-call §provider-guarantees-signal-wired

        // Engine splits wire-level response: emission (content, reasoning,
        // parsed ops) → packet.assistant per Packet.json §assistant;
        // call-metadata (usage, finishReason, model) → Turn columns per
        // Turn.json. Mixing the two on packet.assistant was the wrong layer.
        const { packetAssistant, callMetadata, parseErrors } = this.#splitResponse(response); // raw assistant content is opaque — split, never interpreted — §provider-guarantees-assistantraw-opaque
        // Surface parse errors to the model's NEXT packet so it can self-
        // correct. Without this, malformed emissions (e.g. a READ matcher
        // body starting with `//` being interpreted as xpath) silently
        // drop, the model sees zero ops dispatched, strike-rail fires,
        // model has no feedback on WHY its emission didn't take effect.
        //
        // Envelope per @plurnk/plurnk-grammar 0.17.0 TelemetryEvent:
        //   { source, kind, message, position: { type: "content-offset", line, column } }
        // Plus a `snippet` field (additionalProperties) carrying ±N lines
        // of the assistant's own content around the error line. Without
        // the snippet, the model sees "invalid xpath at 1:0" but can't
        // connect that to what IT wrote — and tends to regenerate the
        // same broken emission. See edit-todo demo for the canonical case.
        for (const { message, line, column, source } of parseErrors ?? []) {
            this.#pushTelemetry(sessionId, loopId, {
                source: "grammar",
                kind: "parse_error",
                message,
                position: { type: "content-offset", line, column },
                snippet: this.#extractSnippet(packetAssistant.content, line, 2),
                parserSource: source,
            });
        }
        const opsCount = packetAssistant.ops.length;
        // Informational SEND[103] broadcasts (#free-text-capture) are log rows, not
        // actions: excluded from the real-op count so a prose-only turn still strikes
        // as no-ops, and the terminal scan ignores 1xx so they never set turnStatus.
        const realOpsCount = packetAssistant.ops.filter(
            (op) => !(op.op === "SEND" && op.signal === 103 && op.target === null),
        ).length;
        const sendOp = packetAssistant.ops.findLast(
            (op): op is PlurnkStatement & { op: "SEND"; signal: number } =>
                op.op === "SEND" && typeof op.signal === "number" && op.signal >= 200,
        );
        // Rail #41 (revised): the per-turn requirement is "emit at least one
        // op," not "emit a terminal SEND." SEND is purely a signal verb; many
        // turns may pass without one. An empty op list is the only strike.
        const turnStatus = sendOp !== undefined
            ? sendOp.signal
            : realOpsCount === 0 ? TURN_STATUS_NO_OPS : TURN_STATUS_IMPLICIT_CONTINUE;

        // Close the turn with the final packet, status, and usage stats.
        const packet = this.#completePacket(requestPacket, packetAssistant, response.assistantRaw, provider);
        const { usage, finishReason, model } = callMetadata;
        await (this.#db.engine_close_turn as PrepMethod).run({
            id: turnId,
            status: turnStatus,
            packet: JSON.stringify(packet),
            usage_prompt: usage.prompt,
            usage_completion: usage.completion,
            usage_cached: usage.cached,
            usage_cost_pico: provider.costFor(usage), // §provider-surface-costfor
            finish_reason: finishReason,
            model,
        });

        // Dispatch model ops starting at nextActionIndex (continues the
        // turn's running counter after any pre-model writes).
        //
        // Max-commands cap: a single emission with more than `maxCommands`
        // ops is the runaway-loop fingerprint observed in pathological cases
        // (html-attrs demo: 635 ops in one turn). Cap dispatches at the
        // configured limit; overflow ops are dropped without per-op log
        // entries (avoids bloating forensics with hundreds of identical refusals)
        // and the model gets a single telemetry signal next packet so it knows
        // its emission was truncated.
        const maxCommands = readMaxCommands();
        const opsToDispatch = packetAssistant.ops.slice(0, maxCommands);
        const droppedCount = opsCount - opsToDispatch.length;
        const statuses: number[] = [];
        for (const [i, statement] of opsToDispatch.entries()) {
            const result = await this.dispatch({
                statement, sessionId, runId, loopId, turnId,
                sequence: nextActionIndex + i,
                origin, onDispatch,
            });
            statuses.push(result.status);
        }
        // max_commands_exceeded IS model-facing: dropped ops are things
        // the model emitted that didn't run — it needs to know. Engine
        // bookkeeping (the cap value, our threshold reasoning) stays
        // internal; only the facts of what happened are reported.
        if (droppedCount > 0) {
            this.#pushTelemetry(sessionId, loopId, {
                source: "engine:rail",
                kind: "max_commands_exceeded",
                emitted: opsCount,
                dropped: droppedCount,
            });
        }

        // Zero ops is NOT an error to report — the model knows it emitted
        // nothing. Strike accounting (engine-internal) treats it as a
        // struck turn; the model just sees an empty packet next turn.
        // Per SPEC §telemetry gamification policy.

        return { turnId, status: turnStatus, statuses, fingerprint: Engine.fingerprintTurn(packetAssistant.ops), budgetStruck: enforced.struck, budgetHardStop: false };
    }

    // Split the wire-level ProviderResponse into the two destinations:
    // packet.assistant gets the model's emission (content, ops, reasoning);
    // Turn columns get the call-metadata (usage, finishReason, model).
    // SPEC §provider-surface / plurnk-providers#1: text-fragment scraping policy lives
    // here — engine owns the parse and the scraping rule, providers stay
    // grammar-unaware.
    //
    // Test-fixture escape hatch: the Mock provider may pre-supply `ops` on
    // its assistant payload to skip the parse roundtrip. The wire Provider
    // contract has no `ops` field; only Mock exposes one. Real providers
    // always take the parse path because their `assistant.ops` is undefined.
    #splitResponse(response: ProviderResponse): { packetAssistant: PacketAssistant; callMetadata: TurnCallMetadata; parseErrors: ParseErrorInfo[] } {
        const { assistant } = response;
        const preParsedOps = (assistant as { ops?: PlurnkStatement[] }).ops;
        const ops: PlurnkStatement[] = [];
        // #plan-reasoning: PLAN bodies are the model's in-band reasoning — hoisted
        // out of the op stream into the reasoning field, never dispatched as a log op.
        // Free text becomes informational SEND[103] log ops (#free-text-capture) below.
        const planFragments: string[] = [];
        const hoistPlan = (op: PlurnkStatement): boolean => {
            if (op.op !== "PLAN") return false;
            const raw = (op.body ?? "").trim();
            if (raw.length > 0) planFragments.push(raw);
            return true;
        };
        // Full PlurnkParseError context (line/column/source) is preserved
        // here so runTurn can build TelemetryEvent envelopes per the
        // grammar 0.17.0 protocol — model needs position info to locate
        // its own offending content on the next turn.
        const parseErrors: ParseErrorInfo[] = [];
        if (preParsedOps !== undefined) {
            for (const op of preParsedOps) if (!hoistPlan(op)) ops.push(op);
        } else {
            const parsed = PlurnkParser.parse(assistant.content);
            for (const item of parsed.items) {
                if (item.kind === "statement") {
                    if (!hoistPlan(item.statement)) ops.push(item.statement);
                }
                else if (item.kind === "text") {
                    // #free-text-capture: interstitial prose → an informational
                    // SEND[103] broadcast log op, interleaved in emission order.
                    const trimmed = item.text.trim();
                    if (trimmed.length > 0) ops.push({
                        op: "SEND", suffix: "", signal: 103, target: null,
                        lineMarker: null, body: { raw: trimmed, json: null },
                        position: (item as { position?: { line: number; column: number } }).position ?? { line: 1, column: 1 },
                    } as PlurnkStatement);
                }
                else if (item.kind === "error") {
                    const err = (item as { error?: PlurnkParseError }).error;
                    if (err instanceof PlurnkParseError) {
                        parseErrors.push({ message: err.message, line: err.line, column: err.column, source: err.source });
                    } else {
                        const msg = (err as { message?: string } | undefined)?.message ?? "parse error";
                        parseErrors.push({ message: msg, line: 0, column: 0, source: "parser" });
                    }
                }
            }
            // The grammar also reports an `unparsedTail` when input ends
            // mid-statement (a body opened but never closed): its `reason`
            // names the op AND the fix ("…never closed — add `:READ`"), where
            // the item-level error only says "expected close tag" for a tag the
            // model thinks it already wrote. Surface it — phenomenal messages
            // the model can self-correct from are the whole point of the DSL.
            const tail = parsed.unparsedTail;
            if (tail !== undefined) {
                parseErrors.push({ message: tail.reason, line: tail.from.line, column: tail.from.column, source: "grammar" });
            }
        }
        const wireReasoning = assistant.reasoning ?? "";
        const planReasoning = planFragments.join("\n\n");
        const reasoningParts = [wireReasoning, planReasoning].filter((s) => s.length > 0);
        const reasoning = reasoningParts.length > 0 ? reasoningParts.join("\n\n") : null;
        return {
            packetAssistant: { content: assistant.content, ops, reasoning },
            callMetadata: { usage: assistant.usage, finishReason: assistant.finishReason, model: assistant.model },
            parseErrors,
        };
    }

    // Assemble the request half of the spec'd packet (Packet.json §system
    // and §user) BEFORE the provider call. The same packet object is then
    // completed with assistant + assistantRaw after the model responds, so
    // the stored packet and the wire payload share one source of truth.
    async #buildRequestPacket({
        initialMessages, requirements, runId, loopId, currentTurnSeq, provider, gitStatus, telemetryErrors: presetTelemetry,
    }: {
        initialMessages: ChatMessage[];
        // Optional requirements override. Empty in practice — callers don't thread it;
        // the engine sources Paths.defaultRequirements itself (a non-empty value wins).
        requirements: string;
        gitStatus: GitStatus | null;
        runId: number; loopId: number;
        // DB-level turn sequence for "look at the previous turn" queries
        // (e.g. telemetry errors).
        currentTurnSeq: number;
        provider: Provider;
        // Pre-drained telemetry — the grinder passes the first build's errors
        // through its rebuilds so a destructive re-drain can't swallow them.
        telemetryErrors?: object[];
    }): Promise<RequestPacket> {
        const byRole = (role: ChatMessage["role"]): string =>
            initialMessages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        const system_definition = byRole("system");
        // user.prompt sources from the loop's most recent prompt entry first
        // (plurnk:///prompt/<loop_id>/<N> for the highest N written to date).
        // This is what inject + the turn-1 foist write into. Falls back to
        // the runLoop caller's messages.user for tests that bypass the
        // foist mechanism entirely.
        const latestPromptRow = await (this.#db.drain_get_latest_prompt_body_for_loop as PrepMethod).get<{ content: string }>({ pattern: `prompt/${loopId}/%` });
        const prompt = (latestPromptRow !== undefined && typeof latestPromptRow.content === "string" && latestPromptRow.content.length > 0)
            ? latestPromptRow.content
            : byRole("user");
        // Requirements is engine-sourced, NOT threaded from callers — that threading is
        // exactly how it went missing (callers read the sysprompt but never the
        // requirements). Read Paths.defaultRequirements (PLURNK_REQUIREMENTS env →
        // requirements.md) fresh each build so edits take effect; a non-empty param wins.
        const requirementsText = requirements.length > 0 ? requirements : await readFile(Paths.defaultRequirements, "utf8");
        const log = await this.#buildLog(runId);
        const telemetryErrors = presetTelemetry ?? await this.#buildTelemetryErrors(loopId, currentTurnSeq);
        // Per-section render-cost subtotals via provider's tokenizer.
        // Engine approximates each section by tokenizing its serialized
        // form — wire-payload tokens may differ slightly because chat-
        // template scaffolding adds bytes, but the subtotal tracks "what
        // the model has to process" closely enough for budget diagnostics.
        const countTokens = (t: string): number => provider.countTokens(t); // §provider-surface-counttokens
        // Budget readout (SPEC.md §tokenomics). Two-pass: measure the wire-rendered
        // index/log sections (budget-independent), install the readout with a
        // tokensFree placeholder, measure the assembled total, resolve free,
        // substitute. Subtotals come from the real render — meta and fences
        // included — not a serialized approximation. ceiling is the provider's
        // window × PLURNK_BUDGET_CEILING (null when no window is reported →
        // headline omitted, section lines still shown).
        const ceiling = Engine.computeCeiling(provider.contextSize, this.#budgetCeiling);
        const scratch = {
            system: { system_definition, log },
            user: { prompt, telemetry: { budget: "", errors: telemetryErrors, git: gitStatus }, tools: this.#collectTools(), system_requirements: requirementsText },
        };
        const sections = PacketWire.measureBudgetSections(scratch, countTokens);
        scratch.user.telemetry.budget = this.#renderBudget(sections, ceiling);
        const total = countTokens(PacketWire.renderSystemContent(scratch.system)) + countTokens(PacketWire.renderUserContent(scratch.user));
        const tokensFree = ceiling === null ? null : Math.max(0, ceiling - total); // free floors at 0 on overshoot — §tokenomics-over-budget-floor
        const percent = ceiling === null ? null : Math.round((total / ceiling) * 100); // usage as % of the ceiling — §tokenomics-context-percent
        const budget = tokensFree === null
            ? scratch.user.telemetry.budget
            : scratch.user.telemetry.budget
                .replace(TOKEN_USAGE_PLACEHOLDER, String(total))
                .replace(TOKEN_PERCENT_PLACEHOLDER, String(percent))
                .replace(TOKENS_FREE_PLACEHOLDER, String(tokensFree));
        const system = { tokens: 0, system_definition, log };
        const user = { tokens: 0, prompt, telemetry: { budget, errors: telemetryErrors, git: gitStatus }, tools: scratch.user.tools, system_requirements: requirementsText };
        system.tokens = countTokens(PacketWire.renderSystemContent(system));
        user.tokens = countTokens(PacketWire.renderUserContent(user));
        return { system, user };
    }

    // Budget readout body, rendered into the `# Plurnk System Budget` section.
    // Headline `ceiling/free` only when a ceiling exists; section lines for the
    // curatable index/log weight the model can FOLD back. tokensFree is a
    // placeholder here — buildSystem substitutes it after measuring the packet.
    #renderBudget(
        sections: {
            log: {
                entries: number; tokens: number;
                byTurn: Array<{ turn: string; tokens: number }>;
                largest: Array<{ path: string; tokens: number }>;
            };
        },
        ceiling: number | null,
    ): string {
        const lines: string[] = [];
        if (ceiling !== null) lines.push(`ceiling ${ceiling} · usage ${TOKEN_USAGE_PLACEHOLDER} (${TOKEN_PERCENT_PLACEHOLDER}%) · free ${TOKENS_FREE_PLACEHOLDER}`);
        if (sections.log.entries > 0) {
            lines.push(`Log entries: ${sections.log.entries} entries, ${sections.log.tokens} tokens`);
            // Per-turn weight — the grinder's rollback unit, oldest first: the
            // model sees what's first to go (§tokenomics {§tokenomics-turn-totals}).
            if (sections.log.byTurn.length > 0) {
                lines.push("Turns:", "| turn | tokens |", "|---|--:|");
                for (const t of sections.log.byTurn) lines.push(`| ${t.turn} | ${t.tokens} |`);
            }
            // The heaviest individual entries — the FOLD targets behind the
            // weight (§tokenomics {§tokenomics-largest-entries}).
            if (sections.log.largest.length > 0) {
                lines.push("Heaviest entries:", "| entry | tokens |", "|---|--:|");
                for (const e of sections.log.largest) lines.push(`| ${e.path} | ${e.tokens} |`);
            }
        }
        return lines.join("\n");
    }

    // The # Plurnk System Tools capability sheet (SPEC §tools). A hook: each
    // enabled capability contributes one line, rendered above Requirements so
    // the model sees what it can do before the rules. PLAN is the first
    // contributor (gated by PLURNK_PLAN); each available executor tag then
    // contributes its self-documenting example (plurnk-execs#7), retiring the
    // blind EXEC.
    // The capability sheet — the live tool surface (PLAN + wired executor tags). §tools-capability-sheet
    #collectTools(): string[] {
        const tools: string[] = [];
        if (process.env.PLURNK_PLAN === "1") { // <<PLAN advertised only when PLAN is enabled — §tools-plan-gated
            tools.push("* Begin every response with <<PLAN:...:PLAN");
        }
        // Each available runtime tag contributes its self-documenting example —
        // the example carries syntax + purpose, so there's no prose line. Tags
        // with no example (sh/node, covered by the core prompt) contribute
        // nothing; available-only, so the model never sees an unusable tag. `* `
        // bullets + bare op forms match the packet's list/op rendering (no `- `,
        // no backticks — see packet-wire.ts).
        if (this.#executors !== undefined) {
            for (const tag of this.#executors.availableRuntimes()) {
                const example = this.#executors.entry(tag)?.example;
                if (example) tools.push(`* ${example}`);
            }
        }
        return tools;
    }

    // SPEC §grinder — the budget grinder. Runs pre-LLM (in runTurn, after the packet
    // is built, before provider.generate); fires only on actual overflow. Two
    // passes, re-measuring between. Folds (never deletes) — the prior turn's logs,
    // then the catalog except the manifest lifeline. The strike it raises and the
    // hard-stop it can signal are returned to runLoop, which owns abandonment.
    // §grinder-overflow-only — fires only on actual overflow, never speculatively
    async #enforceBudget({ packet, provider, runId, loopId, turnId, sessionId, turnNumber, rebuild }: {
        packet: RequestPacket; provider: Provider;
        runId: number; loopId: number; turnId: number; sessionId: number;
        turnNumber: number; rebuild: (telemetryErrors: object[]) => Promise<RequestPacket>;
    }): Promise<{ packet: RequestPacket; fit: boolean; struck: boolean }> {
        const ceiling = Engine.computeCeiling(provider.contextSize, this.#budgetCeiling);
        const measure = (p: RequestPacket): number => p.system.tokens + p.user.tokens;
        if (ceiling === null || measure(packet) <= ceiling) return { packet, fit: true, struck: false };

        const folded = new Map<string, number>();
        const note = (scheme: string): void => { folded.set(scheme, (folded.get(scheme) ?? 0) + 1); };

        // Pass 1 — prior-turn rollback: fold the latest emissions (the ones that
        // pushed it over). No prior turn (turn 1, env overflow) → no-op → pass 2.
        const priorLogs = await (this.#db.engine_grinder_prior_turn_logs as PrepMethod).all<{ id: number; scheme: string | null }>({ loop_id: loopId, turn_id: turnId }); // prior-turn rollback folds the latest emissions — §grinder-layer1-rollback
        for (const le of priorLogs) note(le.scheme ?? "log");
        if (priorLogs.length > 0) await (this.#db.engine_grinder_fold_prior_turn_logs as PrepMethod).run({ loop_id: loopId, turn_id: turnId });
        const errors = packet.user.telemetry.errors;
        let current = priorLogs.length > 0 ? await rebuild(errors) : packet;
        if (measure(current) <= ceiling) {
            this.#emitBudgetOverflow(sessionId, loopId, folded);
            return { packet: current, fit: true, struck: turnNumber > 1 }; // turn 0/1 overflow is the environment, never a strike — §grinder-soft-turn-0-1
        }

        // Prior-turn rollback is the only budget lever now: entries don't render
        // (no index), so there is no catalog to collapse. If pass 1 didn't fit,
        // the packet is over and the caller hard-413s. §grinder-hard-413-abort
        this.#emitBudgetOverflow(sessionId, loopId, folded);
        return { packet: current, fit: measure(current) <= ceiling, struck: turnNumber > 1 };
    }

    // The model-facing budget event (SPEC §grinder, §telemetry): which entries left the
    // window, by scheme — the model's own terms, no mechanism vocabulary. The
    // strike this overflow triggers stays engine-internal (gamification policy).
    // §grinder-event-model-terms — model-facing terms only; the strike stays engine-internal
    #emitBudgetOverflow(sessionId: number, loopId: number, folded: Map<string, number>): void {
        if (folded.size === 0) return;
        this.#pushTelemetry(sessionId, loopId, {
            source: "engine:rail",
            kind: "budget_overflow",
            folded: [...folded.entries()].map(([scheme, count]) => ({ scheme, count })),
        });
    }

    // Wire projection lives in ./packet-wire.ts so Engine and
    // bin/digest.ts import the exact same function — structurally one
    // implementation, no drift between wire and digest possible.
    // Format: markdown (user pick over rummy's XML alternative, 2026-05-22).
    #packetToWireMessages(packet: RequestPacket): ChatMessage[] {
        return PacketWire.packetToWireMessages(packet) as ChatMessage[];
    }

    // Complete the packet by adding the model's response. After this the
    // packet matches Packet.json fully and is ready for storage.
    #completePacket(requestPacket: RequestPacket, assistant: PacketAssistant, assistantRaw: unknown, provider: Provider): object {
        const assistantTokens = provider.countTokens(assistant.content);
        return {
            tokens: requestPacket.system.tokens + requestPacket.user.tokens + assistantTokens,
            system: requestPacket.system,
            user: requestPacket.user,
            assistant,
            assistantRaw,
        };
    }

    // Render-time mimetype invocation (SPEC §mimetype {§mimetype-handlers-fire-render-time},
    // §per-entry-channels {§per-entry-channels-preview-is-handler-output}). For each (run, entry, channel)
    // with indexed=1, pass the channel's current content through
    // mimetype.preview(content, budget). State is included verbatim — engine
    // does NOT branch on it (§channel-state {§channel-state-engine-does-not-branch-on-state}).
    // SPEC §telemetry: model-facing alert surface.
    // Two sources, merged on each packet build:
    //   1. Previous-turn action-bound failures (status_rx >= 400 on log_entries).
    //   2. Engine-buffered actionless failures (no_send, parse, watchdog, rails).
    // Buffer drains on read — each error appears in exactly one packet.
    async #buildTelemetryErrors(loopId: number, currentTurnSeq: number): Promise<object[]> {
        const rows = await (this.#db.engine_render_telemetry_errors as PrepMethod).all<{
            op: string; sequence: number; status_rx: number;
            rx: string; mimetype_rx: string;
            scheme: string | null; pathname: string | null;
            turn_seq: number; loop_seq: number;
        }>({ loop_id: loopId, current_turn_seq: currentTurnSeq });
        const actionFailures = rows.map((r) => {
            const target = r.scheme !== null
                ? `${r.scheme}://${r.pathname ?? ""}`
                : (r.pathname ?? null);
            const parsedRx = r.mimetype_rx === "application/json" ? JSON.parse(r.rx) : r.rx;
            return {
                kind: "action_failure",
                coordinate: `${r.loop_seq}/${r.turn_seq}/${r.sequence}`,
                op: r.op,
                target,
                status: r.status_rx,
                error: typeof parsedRx === "object" && parsedRx !== null && "error" in parsedRx
                    ? (parsedRx as { error: string }).error
                    : typeof parsedRx === "string" ? parsedRx : "",
            };
        });
        return [...this.#drainTelemetry(loopId), ...actionFailures];
    }

    // SPEC §packet packet.system.log — chronological action-entries for the loop.
    // Snapshot is taken at packet build (pre-dispatch this turn), so it
    // reflects "what has happened before this turn." Each row carries a
    // log:///<loop_seq>/<turn_seq>/<sequence> coordinate the model can READ.
    async #buildLog(runId: number): Promise<object[]> {
        // SPEC §packet-terms: runs own log entries — log is the run's history,
        // not the loop's. Span all loops in the run so the model sees
        // earlier loops' work as conversational memory.
        //
        // User prompts are first-class log entries: runTurn writes a
        // client-origin SEND[200] row at sequence=0 of each new
        // turn-1. Prompts thus surface naturally in this query — no
        // synthetic / shim layer.
        const rows = await (this.#db.engine_render_log as PrepMethod).all<{
            loop_seq: number; turn_seq: number; sequence: number;
            origin: string; op: string; suffix: string; signal: string | null;
            scheme: string | null; username: string | null; password: string | null;
            hostname: string | null; port: number | null; pathname: string | null;
            params: string | null; fragment: string | null;
            status_rx: number; rx: string; mimetype_rx: string;
            tx: string; mimetype_tx: string; indexed: number; source: string | null;
        }>({ run_id: runId });
        return rows.map((r) => ({
            coordinate: `${r.loop_seq}/${r.turn_seq}/${r.sequence}`,
            origin: r.origin,
            op: r.op,
            suffix: r.suffix,
            signal: r.signal === null ? null : JSON.parse(r.signal),
            target: {
                scheme: r.scheme,
                username: r.username, password: r.password,
                hostname: r.hostname, port: r.port,
                pathname: r.pathname,
                params: r.params === null ? null : JSON.parse(r.params),
                fragment: r.fragment,
            },
            status: r.status_rx,
            rx: r.mimetype_rx === "application/json" ? JSON.parse(r.rx) : r.rx,
            mimetype_rx: r.mimetype_rx,
            tx: r.mimetype_tx === "application/json" ? JSON.parse(r.tx) : r.tx,
            mimetype_tx: r.mimetype_tx,
            folded: r.indexed === 0,
            source: r.source,
        }));
    }

    // §env-delta (§actor-boundary-no-mutex: runs share without locks; a conflict surfaces as a delta, never prevented) — at pre-turn build, surface what changed in the shared world since this
    // run last looked. No per-run snapshot (§machine-processes "a run is its log"): every
    // edit is already a span-carrying log row, so PULL other actors' EDITs on shared
    // entries since this run's prior turn — real cross-run edits and the plurnk run's
    // fs-sync fictions — and materialize each as a FOLDED delta reusing the row's span +
    // cause. Returns the count so the caller advances nextActionIndex past the deltas.
    async #materializeEnvironmentDeltas(args: {
        sessionId: number; runId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number> {
        const { sessionId, runId, loopId, turnId, fromSequence } = args;
        const boundary = await (this.#db.engine_run_prior_turn_time as PrepMethod).get<{ since: string | null }>({ run_id: runId, turn_id: turnId });
        const since = boundary?.since ?? null;
        if (since === null) return 0;  // first turn — nothing prior; the model reads current state fresh
        const rows = await (this.#db.engine_pull_env_deltas as PrepMethod).all<{
            run_id: number; scheme: string | null; pathname: string; rx: string; source: string | null;
        }>({ session_id: sessionId, run_id: runId, since });
        let written = 0;
        for (const r of rows) {
            // source: the originating run (a real cross-run edit) or 'file' (an fs fiction);
            // rx reuses the originating row's result span — the edit as it looked then.
            await (this.#db.engine_insert_env_delta as PrepMethod).run({
                run_id: runId, loop_id: loopId, turn_id: turnId, sequence: fromSequence + written,
                source: r.source ?? String(r.run_id), scheme: r.scheme, pathname: r.pathname, rx: r.rx,
            });
            written++;
        }
        return written;
    }

    // §env-delta — the filesystem as an actor. Ambient disk divergences detected at
    // pre-turn (git membership re-read) are logged as the plurnk run's source=file EDIT
    // "fictions": no op happened, but EDIT is the only grammar the model has for "your
    // world changed," so the fiction keeps its perspective aligned with what its tooling
    // would show. The fiction lives in the plurnk run's log; every other run pulls it
    // through the one delta path, exactly like a sibling's real edit.
    // §membership-emi-divergence-signal — disk divergences logged as the plurnk run's source=file EDIT fictions
    async #logFsFictions(sessionId: number, divergences: FsDivergence[]): Promise<void> {
        if (divergences.length === 0) return;
        const run = await (this.#db.envelope_get_run_by_name as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "plurnk" })
            ?? await (this.#db.envelope_insert_run as PrepMethod).get<{ id: number }>({ session_id: sessionId, name: "plurnk", origin: "plurnk" });
        if (run === undefined) throw new Error("logFsFictions: plurnk run resolution returned no row");
        const loop = await (this.#db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ run_id: run.id });
        if (loop === undefined) throw new Error("logFsFictions: loop insert returned no row");
        const seq = await (this.#db.client_turn_next_sequence as PrepMethod).get<{ next: number }>({ loop_id: loop.id });
        const turn = await (this.#db.client_turn_insert as PrepMethod).get<{ id: number }>({ loop_id: loop.id, sequence: seq?.next ?? 1, packet: "{}" });
        if (turn === undefined) throw new Error("logFsFictions: turn insert returned no row");
        let sequence = 1;
        for (const d of divergences) {
            const span = editedSpan(d.before, d.after);
            await (this.#db.engine_insert_log_entry as PrepMethod).get({
                run_id: run.id, loop_id: loop.id, turn_id: turn.id, sequence: sequence++,
                origin: "plurnk", source: "file", op: "EDIT", suffix: "", signal: null,
                scheme: d.scheme, username: null, password: null, hostname: null, port: null,
                pathname: d.pathname, params: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/plain",
                rx: JSON.stringify({ status: 200, entryId: d.entryId, channel: d.channel, span }), mimetype_rx: "application/json",
                status_rx: 200, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
            });
        }
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        const { statement, sessionId, runId, loopId, turnId, sequence, origin, onDispatch } = context;
        const schemeCtx: PlurnkSchemeContext = {
            db: this.#db,
            sessionId, runId, loopId, turnId,
            writer: origin,
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeRunNotify: this.#wakeRunNotify,
            mimetypes: this.#mimetypes,
            tokenize: this.#tokenize,
            pushTelemetry: (event) => this.#pushTelemetry(sessionId, loopId, event),
            executors: this.#executors,
        };
        let result: DispatchResult;
        let denial = this.#checkWritable(statement, origin);
        if (denial === null) denial = await this.#checkFlagsGate(statement, loopId);
        if (denial !== null) {
            result = denial;
        } else {
            // SPEC §scheme-surface + plurnk-schemes#1: action-entry-as-outcome. Scheme-handler
            // exceptions become the action-entry's outcome (status 500), not a
            // thrown bubble. The log_entry is the durable record; engine never
            // skips it. Logging failures (#writeLog throws) are NOT caught —
            // those are system failures.
            try {
                if (statement.op === "SEND" && statement.target === null) {
                    result = await this.#handleSendBroadcast(statement, loopId);
                } else if (statement.op === "COPY") {
                    result = await this.#handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#handleMove(statement, schemeCtx);
                } else if (statement.op === "KILL") {
                    result = await this.#handleKill(statement, schemeCtx);
                } else if (statement.op === "PLAN") {
                    result = this.#handlePlan(statement);
                } else if (statement.op === "EXEC") {
                    // EXEC's target slot is `cwd`, not a scheme address.
                    // Per plurnk.md the op routes unconditionally to the
                    // exec scheme; the scheme handler reads runtime
                    // (signal), cwd (target), and command (body).
                    result = await this.#run("exec", statement, schemeCtx);
                } else {
                    result = await this.#run(this.#schemeNameOf(statement.target), statement, schemeCtx); // §op-methods-op-dispatch
                }
            } catch (err) { // a scheme exception becomes the op's 500 outcome — §scheme-surface-exception-500
                result = {
                    status: 500,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }
        const logEntryId = await this.#writeLog({ statement, result, runId, loopId, turnId, sequence, origin });
        onDispatch?.(logEntryId);
        // Proposal lifecycle (SPEC.md §engine-rails + §methods loop.resolve; §proposal-202-pauses). When a
        // scheme returns status 202, the entry is written as state='proposed';
        // dispatch then PAUSES on a per-entry waiter until resolution
        // arrives via Engine.resolveProposal (from the loop/resolve RPC,
        // YOLO listener, or timeout). The post-resolution status replaces
        // 202 in the result the caller sees, so runTurn never branches on
        // a pending state.
        if (result.status === 202) {
            // Effect-gated auto-run (read/pure runtimes, plurnk-service#182):
            // no human gate, no loop/proposal notification. Accept + apply
            // in-process; the model sees the outcome directly, never a review.
            if ((result.attrs as { inline?: boolean } | undefined)?.inline === true) {
                const effective = await this.#runApplyResolution(statement, result, { decision: "accept" }, { sessionId, runId, loopId, turnId });
                return this.#applyResolution(logEntryId, effective);
            }
            // Register the resolution waiter SYNCHRONOUSLY before any await
            // yields. A same-tick resolveProposal() (e.g. from a test that
            // awaits the onDispatch callback and immediately resolves) must
            // find the waiter registered — adding an await between insert
            // and waiter-registration would open a race window.
            const resolutionPromise = this.#awaitResolution(logEntryId);
            // Notify external listeners (Daemon broadcasts loop/proposal;
            // YOLO listener auto-resolves) BEFORE awaiting — they may
            // resolve synchronously inside their handlers.
            const target = this.#extractTarget(statement.target);
            const flags = await this.#loadLoopFlags(loopId); // the loop/proposal notification carries flags (yolo) — §dual-yolo-proposal-carries-flags
            const event: ProposalPendingEvent = {
                logEntryId, sessionId, runId, loopId, turnId,
                op: statement.op,
                target: { scheme: target.scheme, pathname: target.pathname },
                body: typeof result.body === "string" ? result.body : "",
                attrs: (result.attrs ?? {}) as object,
                flags,
            };
            for (const listener of this.#proposalPendingListeners) {
                try { listener(event); } catch (_) { /* listener errors don't break dispatch */ }
            }
            const resolution = await resolutionPromise;
            // Run the scheme's applyResolution hook on accept (writes the
            // file, spawns the process, etc.). If applyResolution returns a
            // 4xx/5xx or throws, the resolution is downgraded to a reject
            // with the failure outcome — engine treats it like a client
            // rejection.
            const effective = await this.#runApplyResolution(statement, result, resolution, { sessionId, runId, loopId, turnId });
            // MOVE into a proposed dest: the deferred source-delete fires ONLY now,
            // after the dest write landed (accept). On reject the source survives.
            if (effective.decision === "accept") {
                const moveSource = (result.attrs as { moveSource?: { scheme: string; pathname: string } } | undefined)?.moveSource;
                if (moveSource !== undefined) {
                    const srcHandler = this.#schemes.get(moveSource.scheme) as SchemeWithCrud | undefined;
                    if (srcHandler !== undefined && typeof srcHandler.deleteEntry === "function") await srcHandler.deleteEntry(moveSource.pathname, schemeCtx);
                }
            }
            const post = await this.#applyResolution(logEntryId, effective);
            return post;
        }
        return result;
    }

    // On accept, run the scheme's applyResolution — File writes disk, Exec spawns. §proposal-accept-applies
    async #runApplyResolution(
        statement: PlurnkStatement,
        originalResult: DispatchResult,
        resolution: ProposalResolution,
        ids: { sessionId: number; runId: number; loopId: number; turnId: number },
    ): Promise<ProposalResolution> {
        const { sessionId, runId, loopId, turnId } = ids;
        if (resolution.decision !== "accept") return resolution;
        // EXEC routes to the exec scheme regardless of target (cwd, not
        // a scheme address). All other ops resolve their handler from
        // statement.target's scheme.
        // COPY/MOVE write the DEST (statement.body), not the source (target): the
        // accept must reach the dest scheme's applyResolution (File writes disk).
        const schemeName = statement.op === "EXEC" ? "exec"
            : (statement.op === "COPY" || statement.op === "MOVE") ? this.#schemeNameOf(statement.body as ParsedPath | null)
            : this.#schemeNameOf(statement.target);
        if (schemeName === null) return resolution;
        const handler = this.#schemes.get(schemeName) as
            | { applyResolution?: (args: { attrs: object; body?: string }, ctx: PlurnkSchemeContext) => Promise<{ status: number; outcome?: string; body?: string }> }
            | undefined;
        if (handler === undefined || typeof handler.applyResolution !== "function") return resolution;
        try {
            // Build a ctx for the scheme's applyResolution. The proposal
            // was raised inside a specific (session, run, loop, turn);
            // the scheme uses ctx to write the entry that makes the
            // operation's artifact visible in the next packet's index.
            const applyCtx: PlurnkSchemeContext = {
                db: this.#db, sessionId, runId, loopId, turnId,
                writer: "model", signal: this.#loopAborts.get(loopId)?.signal,
                streamEventNotify: this.#streamEventNotify,
                wakeRunNotify: this.#wakeRunNotify,
                tokenize: this.#tokenize,
                pushTelemetry: (event) => this.#pushTelemetry(sessionId, loopId, event),
                executors: this.#executors,
            };
            const applyResult = await handler.applyResolution({
                attrs: (originalResult.attrs ?? {}) as object,
                body: resolution.body,
            }, applyCtx);
            if (applyResult.status >= 400) {
                return {
                    decision: "reject",
                    outcome: applyResult.outcome ?? "apply_failed",
                    body: applyResult.body,
                };
            }
            // Propagate applyResolution.outcome onto the accepted resolution
            // (operational metadata, e.g. exec's "exit_N") AND its body — an
            // inline (read/pure) run returns its output as the body, which has
            // to reach the model-facing result this turn, not just stream to
            // the entry. Host accepts carry no body (fire-and-forget).
            const withOutcome = applyResult.outcome !== undefined && resolution.outcome === undefined
                ? { ...resolution, outcome: applyResult.outcome }
                : resolution;
            return applyResult.body === undefined ? withOutcome : { ...withOutcome, body: applyResult.body };
        } catch (err) {
            return {
                decision: "reject",
                outcome: "apply_threw",
                body: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // Engine.resolveProposal: external API to feed a resolution into a
    // pending proposal. Called by the loop/resolve RPC handler (Phase E.2),
    // the in-tree YOLO listener (Phase E.3), or the timeout watcher. Throws
    // when the logEntryId has no pending waiter — duplicate resolutions, IDs
    // for non-proposed entries, or entries already-resolved are caller
    // errors.
    resolveProposal(logEntryId: number, resolution: ProposalResolution): void {
        const waiter = this.#pendingProposals.get(logEntryId);
        if (waiter === undefined) {
            throw new Error(`Engine.resolveProposal: no pending proposal for log_entry ${logEntryId}`);
        }
        clearTimeout(waiter.timeoutHandle);
        this.#pendingProposals.delete(logEntryId);
        waiter.resolve(resolution);
    }

    // Snapshot of pending proposals (for diagnostic / RPC listings). Returns
    // the log entry IDs currently awaiting resolution.
    pendingProposalIds(): number[] {
        return [...this.#pendingProposals.keys()];
    }

    // Used by wake-on-completion (daemon side): "is there any loop in this
    // run still accepting turns?" If yes, skip the wake — the active loop
    // will pick up the channel transition at its next turn boundary. If no,
    // the daemon opens a fresh loop with the wake prompt.
    async hasActiveLoopForRun(runId: number): Promise<boolean> {
        const row = await (this.#db.engine_count_active_loops_for_run as PrepMethod).get<{ n: number }>({ run_id: runId });
        return (row?.n ?? 0) > 0;
    }

    // Inject a prompt into the run's currently-executing loop. Writes a
    // plurnk:///prompt/<loop_id>/<next-turn> entry whose body becomes
    // packet.user.prompt at the next turn boundary. Last-wins: if two
    // injects target the same next-turn slot, the second overwrites the
    // first.
    //
    // Returns null when no loop in the run is currently active (status=102).
    // The daemon-side inject path then enqueues a fresh loop with this
    // prompt; engine doesn't open loops itself.
    //
    // Rummy parallel: AgentLoop.inject(). The "active drain → write
    // prompt entry, return immediately" branch.
    async inject(runId: number, prompt: string): Promise<
        { loopId: number; turnSeq: number } | null
    > {
        const loopRow = await (this.#db.drain_current_loop_for_run as PrepMethod).get<{ id: number; sequence: number }>({ run_id: runId });
        if (loopRow === undefined) return null;
        const loopId = loopRow.id;
        const turnRow = await (this.#db.drain_next_turn_seq_for_loop as PrepMethod).get<{ next: number }>({ loop_id: loopId });
        const turnSeq = turnRow?.next ?? 1;
        const sessionRow = await (this.#db.drain_get_run_session as PrepMethod).get<{ session_id: number }>({ run_id: runId });
        if (sessionRow === undefined) throw new Error(`Engine.inject: run ${runId} not found`);
        const pathname = `prompt/${loopId}/${turnSeq}`;
        const ctx: PlurnkSchemeContext = {
            db: this.#db, sessionId: sessionRow.session_id, runId, loopId,
            turnId: 0,                   // no turn open at inject time; entries don't pin turnId
            writer: "plurnk",
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeRunNotify: this.#wakeRunNotify,
            tokenize: this.#tokenize,
            pushTelemetry: (event) => this.#pushTelemetry(sessionRow.session_id, loopId, event),
        };
        const entry: EntryData = {
            channels: { body: { content: prompt, mimetype: "text/markdown" } },
            tags: [],
        };
        await EntryCrud.writeEntry(pathname, entry, ctx, "plurnk");
        return { loopId, turnSeq };
    }

    // Subscribe to proposal-pending events. Daemon registers a listener
    // that broadcasts the loop/proposal WS notification; YOLO listener
    // (Phase E.3) registers one that auto-resolves. Listeners fire BEFORE
    // dispatch awaits resolution, so synchronous (or fast-async) handlers
    // can resolve inline.
    onProposalPending(listener: (event: ProposalPendingEvent) => void): void {
        this.#proposalPendingListeners.push(listener);
    }

    // Loads loops.flags (json column) and merges over DEFAULT_LOOP_FLAGS so
    // missing keys read as their documented defaults. Single read site —
    // ProposalPendingEvent.flags is constructed from this, and listeners
    // (Daemon broadcast, YOLO auto-accept) share the result.
    async #loadLoopFlags(loopId: number): Promise<LoopFlags> {
        const row = await (this.#db.engine_get_loop_flags as PrepMethod).get<{ flags: string }>({ loop_id: loopId });
        if (row === undefined) return DEFAULT_LOOP_FLAGS;
        try {
            const parsed = JSON.parse(row.flags) as Partial<LoopFlags>;
            return { ...DEFAULT_LOOP_FLAGS, ...parsed };
        } catch {
            return DEFAULT_LOOP_FLAGS;
        }
    }

    #awaitResolution(logEntryId: number): Promise<ProposalResolution> {
        const timeoutMs = readProposalTimeoutMs();
        return new Promise<ProposalResolution>((resolve) => {
            const timeoutHandle = setTimeout(() => {
                // Timeout: synthesize a cancel resolution and feed it back
                // through the same path as any other resolution. State
                // transitions to cancelled with outcome='timeout'.
                if (this.#pendingProposals.has(logEntryId)) {
                    this.#pendingProposals.delete(logEntryId);
                    resolve({ decision: "cancel", outcome: "timeout" }); // §proposal-timeout-cancels
                }
            }, timeoutMs);
            this.#pendingProposals.set(logEntryId, { resolve, timeoutHandle });
        });
    }

    async #applyResolution(logEntryId: number, resolution: ProposalResolution): Promise<DispatchResult> {
        // Map decision → terminal state + HTTP-aligned status:
        //   accept  → state='resolved', status=200
        //   reject  → state='failed',   status=400, outcome='rejected' (default) §proposal-reject-fails
        //   cancel  → state='cancelled',status=499, outcome='loop_aborted' (default) §proposal-cancel-aborts
        // resolution.outcome wins over the default when supplied; this is how
        // veto filters (Phase E.2 proposal.accepting) can specify a more
        // precise outcome string like 'policy_veto' or 'timeout'.
        const decision = resolution.decision;
        const state = decision === "accept" ? "resolved"
            : decision === "reject" ? "failed"
            : "cancelled";
        const status = decision === "accept" ? 200
            : decision === "reject" ? 400
            : 499;
        const defaultOutcome = decision === "accept" ? null
            : decision === "reject" ? "rejected"
            : "loop_aborted";
        const outcome = resolution.outcome ?? defaultOutcome;
        // rx is the model-facing operation result. Status always; outcome is
        // operational (stays on log_entries for forensics, never model-facing).
        // Body is normally dropped — the propose preview was an input echo —
        // EXCEPT an inline auto-run (read/pure) carries its run output AS the
        // body, which is exactly the "what happened" the model needs this turn.
        // Per AGENTS.md "Operational hygiene on what the model sees."
        const rx = (decision === "accept" && resolution.body !== undefined)
            ? JSON.stringify({ status, body: resolution.body })
            : JSON.stringify({ status });
        await (this.#db.engine_resolve_log_entry as PrepMethod).run({
            id: logEntryId, state, outcome, status_rx: status, rx,
        });
        return { status, outcome, body: resolution.body };
    }

    // SPEC §scheme-surface: engine rejects writes whose origin is outside the target
    // scheme's manifest.writableBy.
    // - Read-side ops (READ, FIND, OPEN, FOLD) are not gated.
    // - SEND broadcast (path=null) has no target scheme; not gated.
    // - COPY: dst scheme writableBy applies.
    // - MOVE: both src (delete) and dst (write) schemes' writableBy apply.
    // - Schemes without a manifest are not gated (legacy / future allowance).
    #checkWritable(statement: PlurnkStatement, origin: WriterTier): DispatchResult | null {
        if (!MUTATING_OPS.has(statement.op)) return null;
        if (statement.op === "SEND" && statement.target === null) return null;

        // EXEC's target slot is `cwd`, not a scheme address. The op's
        // authority always belongs to the exec scheme regardless of cwd.
        if (statement.op === "EXEC") {
            return this.#denyIfDisallowed("exec", origin);
        }

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dst = statement.op === "COPY" ? (statement.body === null ? null : parsePath(statement.body)) : statement.body;
            const dstScheme = this.#schemeNameOf(dst);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = this.#schemeNameOf(statement.target);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = this.#schemeNameOf(statement.target);
        return this.#denyIfDisallowed(target, origin);
    }

    #denyIfDisallowed(schemeName: string | null, origin: WriterTier): DispatchResult | null {
        if (schemeName === null) return null;
        const handler = this.#schemes.get(schemeName);
        if (handler === undefined) return null;
        const manifest = (handler.constructor as { manifest?: SchemeManifest }).manifest;
        if (manifest === undefined) return null;
        if (manifest.writableBy.includes(origin)) return null;
        return { status: 403, error: `writer '${origin}' is not in writableBy for scheme '${schemeName}'` }; // §scheme-surface-writableby-403
    }

    // Per-loop flag gating. Schemes self-declare their flag affinity in
    // their manifest (excludedInAsk / requiresWeb /
    // requiresInteraction); SchemeRegistry.resolveForLoop returns the
    // active set under the loop's persisted flags. Anything outside the
    // set returns 403 — action-entry-as-outcome carries the rejection.
    async #checkFlagsGate(statement: PlurnkStatement, loopId: number): Promise<DispatchResult | null> {
        // Broadcast SEND has no scheme to gate.
        if (statement.op === "SEND" && statement.target === null) return null;

        const flags = await this.#loadLoopFlags(loopId);
        // Fast path: default flags gate nothing. (yolo never gates.)
        if (!flags.noWeb && !flags.noInteraction && flags.mode === "act") return null;

        const active = this.#schemes.resolveForLoop(flags);
        const check = (target: PlurnkStatement["target"]): DispatchResult | null => {
            const scheme = this.#schemeNameOf(target);
            if (scheme === null) return null;
            if (active.has(scheme)) return null;
            return { status: 403, error: `scheme '${scheme}' is inactive under current loop flags` };
        };

        if (statement.op === "COPY" || statement.op === "MOVE") {
            return check(statement.target) ?? check(statement.op === "COPY" ? (statement.body === null ? null : parsePath(statement.body)) : statement.body);
        }
        return check(statement.target);
    }

    async #handleCopy(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "COPY") throw new Error("unreachable");
        const srcPath = statement.target;
        // COPY's body is an opaque raw string (grammar §COPY: a dest path OR a run-fork
        // prompt); parse it to the dest path. Non-path bodies (run:// fork prompts) are
        // not yet handled and surface as a 400.
        const dstPath = statement.body === null ? null : parsePath(statement.body);
        if (srcPath === null) return { status: 400, error: "COPY requires source path" };
        if (dstPath === null) return { status: 400, error: "COPY destination must be a parseable path in the body slot" };
        return await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
    }

    async #handleMove(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "MOVE") throw new Error("unreachable");
        const srcPath = statement.target;
        const dstPath = statement.body;
        if (srcPath === null) return { status: 400, error: "MOVE requires source path" };
        // MOVE is relocation only — deletion is KILL's job (§move, §move-dev-null-not-special). The /dev/null
        // and null-body delete-by-MOVE back-compat is retired: no silent debt.
        if (dstPath === null) return { status: 400, error: "MOVE requires a destination; use KILL to delete" }; // §move-null-body-400

        const srcSchemeName = this.#schemeNameOf(srcPath);
        if (srcSchemeName === null) return { status: 400, error: "MOVE source must be a URL path with a scheme" };
        const srcHandler = this.#schemes.get(srcSchemeName) as SchemeWithCrud | undefined;
        if (srcHandler === undefined || typeof srcHandler.deleteEntry !== "function") return { status: 501 };

        // Relocation: COPY then DELETE source (§move-relocation-deletes-source).
        const copyResult = await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
        if (copyResult.status >= 400) return copyResult;
        const srcPathname = pathnameFromPath(srcPath);
        // If the dest write is a pending proposal (file dest → §membership review), the
        // source-delete MUST wait until the dest actually lands — a rejected
        // proposal would otherwise lose the source. Thread it into the resolution:
        // dispatch deletes the source AFTER the dest applies on accept.
        if (copyResult.status === 202) {
            return { ...copyResult, attrs: { ...(copyResult.attrs as Record<string, unknown>), moveSource: { scheme: srcSchemeName, pathname: srcPathname } } };
        }
        const delResult = await srcHandler.deleteEntry(srcPathname, ctx);
        if (delResult.status >= 400) return { status: delResult.status };
        return copyResult;
    }

    // KILL — scheme-polymorphic destroy (plurnk-grammar#203 / 0.28.0). Entry-KILL
    // permanently deletes the entry: the canonical delete now, MOVE→/dev/null
    // retired from the model's vocabulary. Process-KILL (exec:///) aborts the
    // running spawn's controller (the same teardown loop.cancel rides), addressed
    // by coordinate pathname (#203). The KILL body is an opaque
    // annotation with no runtime meaning; it survives into the log row's tx for
    // free via the statement serialization. Status: 200 killed · 404 unknown ·
    // 405 log:/// (append-only) · 403 writableBy (the #checkWritable gate, KILL ∈
    // MUTATING_OPS) · 200/410/304/404 exec (killed / killed-earlier / exited / unknown) · 501 no-kill/delete scheme.
    async #handleKill(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "KILL") throw new Error("unreachable");
        const path = statement.target;
        if (path === null) return { status: 400, error: "KILL requires a target path" };
        const schemeName = this.#schemeNameOf(path);
        if (schemeName === null) return { status: 400, error: "KILL target must be a URL path with a scheme" };
        if (schemeName === "log") return { status: 405, error: "log:/// is append-only; KILL must bounce" };
        if (schemeName === "exec") {
            const execHandler = this.#schemes.get("exec") as { kill?: (pathname: string, ctx: PlurnkSchemeContext) => Promise<{ status: number; error?: string }> } | undefined;
            if (execHandler === undefined || typeof execHandler.kill !== "function") return { status: 501 };
            return await execHandler.kill(pathnameFromPath(path), ctx);
        }
        const handler = this.#schemes.get(schemeName) as SchemeWithCrud | undefined;
        if (handler === undefined || typeof handler.deleteEntry !== "function") return { status: 501 };
        const delResult = await handler.deleteEntry(pathnameFromPath(path), ctx);
        return { status: delResult.status };
    }

    // PLAN — the model's in-band reasoning op (plurnk-grammar 0.30.0, the 11th op).
    // Production HOISTS PLAN bodies into the turn's reasoning field in #parseAssistant
    // (#plan-reasoning) before dispatch runs, so PLAN normally never reaches here. This
    // handler is the op's direct-dispatch semantics (exercised by the dispatch unit
    // test): a pure no-op (PLAN ∉ MUTATING_OPS) whose body would serialize into the log
    // row's tx, no runtime effect.
    #handlePlan(statement: PlurnkStatement): DispatchResult {
        if (statement.op !== "PLAN") throw new Error("unreachable");
        return { status: 200 };
    }

    // Same- and cross-scheme COPY share one orchestrator — §copy-cross-scheme-copy §move-cross-scheme-move
    async #copyOrchestration({ statement, srcPath, dstPath, ctx }: {
        statement: PlurnkStatement;
        srcPath: ParsedPath;
        dstPath: ParsedPath;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const srcSchemeName = this.#schemeNameOf(srcPath);
        const dstSchemeName = this.#schemeNameOf(dstPath);
        if (srcSchemeName === null || dstSchemeName === null) return { status: 400, error: "COPY/MOVE require URL paths with schemes" };

        const srcHandler = this.#schemes.get(srcSchemeName) as SchemeWithCrud | undefined;
        const dstHandler = this.#schemes.get(dstSchemeName) as SchemeWithCrud | undefined;
        if (srcHandler === undefined || dstHandler === undefined) return { status: 501 };
        if (typeof srcHandler.readEntry !== "function" || typeof dstHandler.writeEntry !== "function") return { status: 501 };

        const srcPathname = pathnameFromPath(srcPath);
        const dstPathname = pathnameFromPath(dstPath);

        const srcResult = await srcHandler.readEntry(srcPathname, ctx);
        if (srcResult.status !== 200 || srcResult.entry === null) return { status: 404, error: `COPY/MOVE source not found: ${srcSchemeName}://${srcPathname}` };  // §copy-missing-source-404 §move-missing-source-404
        const entry = srcResult.entry;

        // Destination read — the conflict/no-op verdict is deferred until the
        // to-be-written content is known (after <L> slice + tag resolution below),
        // so an identical re-copy resolves to 304 instead of a phantom 409.
        const dstExisting = typeof dstHandler.readEntry === "function"
            ? await dstHandler.readEntry(dstPathname, ctx)
            : null;

        // Mimetype compatibility check against the destination scheme's manifest
        const dstManifest = (dstHandler.constructor as { manifest?: SchemeManifest }).manifest;
        const dstChannels = dstManifest?.channels ?? {};
        for (const [channelName, channelData] of Object.entries(entry.channels)) {
            const expectedMimetype = dstChannels[channelName];
            if (expectedMimetype !== undefined && expectedMimetype !== channelData.mimetype) {
                return { status: 415, error: `mimetype mismatch on channel '${channelName}': ${channelData.mimetype} vs ${expectedMimetype}` }; // cross-mimetype COPY/MOVE → 415, never coerce — §channel-mimetype-cross-mimetype-415
            }
        }

        // `<L>` source range slicing per SPEC.md §op-invariants (symmetric with READ
        // `<L>` — source range, no line-number prefix).
        // Applied to every channel of the source entry. Binary channels return
        // 415 since line semantics don't apply.
        const lineMarker = (statement as { lineMarker?: { first: number; last: number | null } | null }).lineMarker ?? null;
        let channels = entry.channels;
        if (lineMarker !== null) {
            const sliced: typeof entry.channels = {};
            for (const [channelName, channelData] of Object.entries(entry.channels)) {
                if (MimetypeBinary.isBinaryMimetype(channelData.mimetype)) {
                    return { status: 415, error: `cannot slice <L> on binary channel '${channelName}' (${channelData.mimetype})` };
                }
                const r = LineMarkerOps.sliceLinesRaw(channelData.content ?? "", lineMarker);
                if (r.status !== 200) return { status: r.status, error: r.error };
                sliced[channelName] = { ...channelData, content: r.text ?? "" };
            }
            channels = sliced;
        }

        // Tag resolution: signal = replace (§copy-signal-replaces-source-tags); absent/empty = carry from source (§copy-no-signal-carries-source-tags)
        const tags = (Array.isArray(statement.signal) && statement.signal.length > 0)
            ? statement.signal
            : entry.tags;

        // 304/409 on an existing destination (SPEC §copy): a re-copy that would write
        // exactly what's already there — same channel contents, same tags — is a no-op
        // (304), mirroring EDIT's 304-on-noop (§edit). A divergent destination is a real
        // collision (409); COPY/MOVE never clobbers.
        if (dstExisting !== null && dstExisting.status === 200 && dstExisting.entry !== null) {
            const dstChannels = dstExisting.entry.channels;
            const writeNames = Object.keys(channels).sort();
            const dstNames = Object.keys(dstChannels).sort();
            const sameContent = writeNames.length === dstNames.length
                && writeNames.every((n, i) => n === dstNames[i] && (channels[n]?.content ?? "") === (dstChannels[n]?.content ?? ""));
            const sameTags = [...tags].sort().join("") === [...dstExisting.entry.tags].sort().join("");
            if (sameContent && sameTags) return { status: 304 };  // identical → §copy-noop-304
            return { status: 409, error: `COPY/MOVE destination exists: ${dstSchemeName}://${dstPathname}` };  // §copy-conflict-409
        }

        const writeResult = await dstHandler.writeEntry(dstPathname, { channels, tags }, ctx);
        // A file dest returns 202 (disk write → §membership review): propagate the
        // proposal so dispatch runs the gate + routes applyResolution to the dest.
        if (writeResult.status === 202) return { status: 202, attrs: writeResult.attrs, body: writeResult.body };
        return { status: writeResult.status, entryId: writeResult.entryId, created: writeResult.created };
    }

    async #handleSendBroadcast(statement: PlurnkStatement, loopId: number): Promise<DispatchResult> {
        if (statement.op !== "SEND") throw new Error("unreachable");
        const status = statement.signal;
        if (status === null) return { status: 400 };
        if (status === 200 || status === 499) {
            await (this.#db.engine_loop_set_status as PrepMethod).run({ status, loop_id: loopId });
        }
        return { status };
    }

    async #run(
        schemeName: string | null,
        statement: PlurnkStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (schemeName === null) return { status: 400 };
        const handler = this.#schemes.get(schemeName) as Record<string, SchemeMethod | undefined> | undefined;
        if (handler === undefined) return { status: 501 };
        const methodName = statement.op.toLowerCase();
        const method = handler[methodName];
        if (typeof method !== "function") return { status: 501 };
        // External @plurnk/plurnk-schemes-* siblings receive the DB-free SchemeCtx
        // (caps), never the raw PlurnkSchemeContext (schemes SPEC §channels). The dynamic
        // dispatch is typed for in-tree schemes; the cast bridges the ctx shapes —
        // the sibling reads caps, the in-tree handler reads db.
        if (this.#schemes.isExternal(schemeName)) {
            return method.call(handler, statement, new SchemeCtxImpl(ctx, schemeName) as unknown as PlurnkSchemeContext);
        }
        return method.call(handler, statement, ctx);
    }

    // Bare paths default to the file scheme per plurnk.md (grammar sysprompt):
    // "Bare paths (no scheme) default to local relative project file paths."
    // file:/// remains an optional explicit form for absolute paths.
    #schemeNameOf(path: ParsedPath | null): string | null {
        if (path === null) return null;
        // http + https are one scheme — the http sibling owns both prefixes (#195).
        if (path.kind === "url") return path.scheme === "https" ? "http" : path.scheme;
        return "file";  // local (bare) → file
    }

    async #writeLog({
        statement, result, runId, loopId, turnId, sequence, origin,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        runId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
    }): Promise<number> {
        const target = this.#extractTarget(statement.target);
        const lineMarkerJson = "lineMarker" in statement && statement.lineMarker !== null
            ? JSON.stringify(statement.lineMarker as LineMarker)
            : null;
        // Status 202 from a scheme means the action is proposed — written to
        // the log in state='proposed' until the proposal lifecycle resolves
        // it. attrs holds the scheme-supplied payload (file diff, exec
        // command, etc.) that the client renders for review and the scheme
        // consumes on accept. All other statuses are terminal — state =
        // 'resolved' for the common case.
        const isProposed = result.status === 202;
        let attrsObj: Record<string, unknown> = (result.attrs !== undefined && result.attrs !== null)
            ? { ...(result.attrs as Record<string, unknown>) }
            : {};
        // EXEC pathname is executor-domain + coordinate: the stream entry
        // lives at exec:///<runtime>/<loop_seq>/<turn_seq>/<sequence> (e.g.
        // exec:///sh/1/1/2). The runtime leads — domain-aware, the executor
        // as authority — and the coordinate that follows is already unique
        // per statement, so no slug is injected. The log row's target points
        // at this same address; its log:/// coordinate shares the trailing
        // <loop>/<turn>/<seq>, so the model correlates op to stream output.
        // Runtime comes from statement.signal (EXEC's runtime slot) so it's
        // resolvable for failed execs too; empty/absent = the default shell.
        if (statement.op === "EXEC") {
            const seqs = await (this.#db.engine_loop_turn_seqs as PrepMethod).get<{ loop_seq: number; turn_seq: number }>({
                loop_id: loopId, turn_id: turnId,
            });
            if (seqs === undefined) throw new Error(`Engine.#writeLog: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
            const runtime = (typeof statement.signal === "string" && statement.signal.length > 0) ? statement.signal : "sh";
            const coordPathname = `/${runtime}/${seqs.loop_seq}/${seqs.turn_seq}/${sequence}`;
            target.scheme = "exec";
            target.pathname = coordPathname;
            attrsObj.pathname = coordPathname;
            // Mutate the in-memory result.attrs too: the dispatch path
            // hands originalResult.attrs to handler.applyResolution after
            // proposal accept (see #acceptResolution). Both views — the
            // stored row AND the in-memory proposal — need the same
            // pathname so applyResolution writes the entry at the same URI.
            if (result.attrs !== undefined && result.attrs !== null) {
                (result.attrs as Record<string, unknown>).pathname = coordPathname;
            }
        }
        const attrs = JSON.stringify(attrsObj);
        const txJson = JSON.stringify(statement);
        const rxJson = JSON.stringify(result);
        const row = await (this.#db.engine_insert_log_entry as PrepMethod).get<{ id: number }>({
            run_id: runId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: sequence,
            origin,
            source: null,  // dispatch entries are self-authored; §env-delta deltas set this
            op: statement.op,
            suffix: statement.suffix,
            signal: this.#signalToJson(statement.signal),
            scheme: target.scheme,
            username: target.username,
            password: target.password,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            params: target.params,
            fragment: target.fragment,
            lineMarker: lineMarkerJson,
            tx: txJson,
            mimetype_tx: "application/json",
            rx: rxJson,
            mimetype_rx: "application/json",
            status_rx: result.status,
            tokens: this.#tokenize(txJson) + this.#tokenize(rxJson),
            state: isProposed ? "proposed" : "resolved",
            outcome: null,
            attrs,
        });
        if (row === undefined) throw new Error("Engine.#writeLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // Normalize a parsed path for storage. The `file` scheme is a routing
    // internal — never stored, never rendered to the model. Both bare paths
    // and `file:///...` inputs collapse to scheme=null at this boundary, so
    // entries.scheme / log_entries.scheme never carry the string "file".
    #extractTarget(path: ParsedPath | null): {
        scheme: string | null; username: string | null; password: string | null;
        hostname: string | null; port: number | null; pathname: string | null;
        params: string | null; fragment: string | null;
    } {
        if (path === null) return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, params: null, fragment: null };
        // `local` (bare path) and `regex` (grammar 0.46 `#pattern#flags` target) carry no URL parts — store the raw text as the pathname for the log record, scheme=null.
        if (path.kind === "local" || path.kind === "regex") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: path.raw, params: null, fragment: null };
        const scheme = path.scheme === "file" ? null : path.scheme;
        return {
            scheme, username: path.username, password: path.password,
            hostname: path.hostname, port: path.port, pathname: path.pathname,
            params: JSON.stringify(path.params), fragment: path.fragment,
        };
    }

    #signalToJson(signal: unknown): string | null {
        if (signal === null || signal === undefined) return null;
        return JSON.stringify(signal);
    }
}
