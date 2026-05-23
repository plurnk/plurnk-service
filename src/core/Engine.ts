import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement, ParsedPath, LineMarker, PlurnkOp } from "@plurnk/plurnk-grammar";
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "./Db.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext, LoopFlags } from "./scheme-types.ts";
import { DEFAULT_LOOP_FLAGS } from "./scheme-types.ts";
// Plain JS module shared with bin/digest.js so wire projection and
// digest projection are structurally one function. tsconfig.build.json
// has allowJs:true so this gets copied through to dist/.
import { packetToWireMessages } from "./packet-wire.js";

// SCHEMES.md §8: writer must be in target scheme's manifest.writableBy.
// SHOW/HIDE/READ/FIND are not gated — they touch visibility metadata or read.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "EXEC"]);

const DEFAULT_PREVIEW_BUDGET = 256;
const DEFAULT_MAX_STRIKES = 3;

const readBudget = (): number => {
    const raw = process.env.PLURNK_ENTRY_SIZE_DEFAULT_TOKENS;
    if (raw === undefined || raw.length === 0) return DEFAULT_PREVIEW_BUDGET;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PREVIEW_BUDGET;
    return n;
};

const readMaxStrikes = (): number => {
    const raw = process.env.PLURNK_MAX_STRIKES;
    if (raw === undefined || raw.length === 0) return DEFAULT_MAX_STRIKES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STRIKES;
    return n;
};

interface IndexedRow {
    entry_id: number;
    version: number;
    scope: "agent" | "session";
    session_id: number | null;
    scheme: string | null;
    username: string | null;
    password: string | null;
    hostname: string | null;
    port: number | null;
    pathname: string;
    params: string | null;
    attributes: string;
    channel: string;
    content: string;
    mimetype: string;
    tokens: number;
}

type Origin = "model" | "client" | "system" | "plugin";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Re-export the canonical Provider contract from ProviderRegistry. Engine is
// the consumer; ProviderRegistry owns the type.
import type { Provider, ProviderResponse, ProviderAssistant, ProviderUsage } from "./ProviderRegistry.ts";

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
        persona: string;
        index: object[];
        log: object[];
    };
    user: {
        tokens: number;
        prompt: string;
        telemetry: { budget: string; errors: object[] };
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
    actionIndex: number;
    origin: Origin;
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
    body?: string;
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
// within this window. Per AGENTS.md §Phase E.2.
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
// action routes through telemetry.errors[] (§15.1).
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

// Per-op fingerprint: op verb + target URI. Body deliberately excluded so the
// model writing varied content to the same target still trips. Path kind is
// included as a discriminator (url vs local). Rummy parallel: scheme +
// sorted attributes joined by '='.
const fingerprintOp = (stmt: PlurnkStatement): string => {
    const path = stmt.path;
    if (path === null) return `${stmt.op}|(no-path)`;
    if (path.kind === "url") return `${stmt.op}|${path.scheme}://${path.pathname}`;
    return `${stmt.op}|local:${path.raw}`;
};

// Per-turn fingerprint: sorted set of per-op fingerprints, joined. Order
// within a turn doesn't matter — we want the SET of activities.
export const fingerprintTurn = (ops: ReadonlyArray<PlurnkStatement>): string => {
    return ops.map(fingerprintOp).toSorted().join(",");
};

// Rail #39 cycle detector. For each candidate period k in [1, maxCyclePeriod],
// check whether the last k*minCycles entries form minCycles repetitions of the
// same length-k pattern. O(maxCyclePeriod × minCycles × max k) ≈ tiny. Rummy
// parallel: src/plugins/error/error.js detectCycle.
export const detectCycle = (
    history: ReadonlyArray<string>,
    minCycles: number,
    maxCyclePeriod: number,
): { detected: false } | { detected: true; period: number; cycles: number } => {
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
};

export default class Engine {
    #db: Db;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #previewBudget: number;
    // Per-loop transient buffer of actionless failures pending surface in the
    // NEXT packet's user.telemetry.errors[]. Drained by #buildTelemetryErrors.
    // Map<loopId, TelemetryError[]>. SPEC §15.1.
    #telemetryBuffer = new Map<number, object[]>();
    // Rail #38 strike state per loop. `streak` = consecutive struck turns;
    // resets on a clean turn. `turnErrors` is bumped externally by per-turn
    // rails (cycle detection #39, etc.) — read and reset at end of each turn.
    // `history` holds per-turn fingerprints for rail #39 cycle detection.
    #strikeState = new Map<number, { streak: number; turnErrors: number; history: string[] }>();
    // Proposal lifecycle (task #42): pending dispatch pauses waiting for
    // resolution. Engine.runTurn awaits the promise when a scheme returns
    // status 202; Engine.resolveProposal feeds the resolution back in. Map
    // is per-log-entry-id; entries clear on resolution. See AGENTS.md
    // §Phase E for the broader lifecycle plan.
    #pendingProposals = new Map<number, ProposalWaiter>();
    // External observers of proposal lifecycle events. Daemon subscribes
    // here to push `loop/proposal` notifications when an entry enters
    // pending state. YOLO listener (Phase E.3) subscribes here too. Lean
    // event emitter — no priority, no veto chain at this layer; filter
    // chains come later if a real consumer needs them.
    #proposalPendingListeners: Array<(payload: ProposalPendingEvent) => void> = [];

    constructor({ db, schemes, mimetypes }: { db: Db; schemes: SchemeRegistry; mimetypes?: Mimetypes }) {
        this.#db = db;
        this.#schemes = schemes;
        // Default to empty discovery — standalone Engine construction (in
        // tests) gets no handlers, and content flows through the framework's
        // raw-content fitContent fallback. Daemon-managed Engine receives a
        // production-configured Mimetypes via the constructor arg.
        this.#mimetypes = mimetypes ?? new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map() },
        });
        this.#previewBudget = readBudget();
    }

    #pushTelemetry(loopId: number, error: object): void {
        const existing = this.#telemetryBuffer.get(loopId);
        if (existing === undefined) this.#telemetryBuffer.set(loopId, [error]);
        else existing.push(error);
    }

    #drainTelemetry(loopId: number): object[] {
        const buf = this.#telemetryBuffer.get(loopId);
        if (buf === undefined) return [];
        this.#telemetryBuffer.delete(loopId);
        return buf;
    }

    async runLoop({
        provider, messages, persona = "", sessionId, runId, loopId,
        maxTurns = 50, maxStrikes = readMaxStrikes(),
        minCycles = readPositiveInt("PLURNK_MIN_CYCLES", DEFAULT_MIN_CYCLES),
        maxCyclePeriod = readPositiveInt("PLURNK_MAX_CYCLE_PERIOD", DEFAULT_MAX_CYCLE_PERIOD),
        origin = "model", signal, onDispatch,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        // packet.system.persona content. Caller resolves the source (client
        // override, session-persisted persona once #150 lands, or the
        // service-default persona.md). Engine just plumbs into the packet.
        persona?: string;
        sessionId: number; runId: number; loopId: number;
        maxTurns?: number;
        maxStrikes?: number;
        minCycles?: number;
        maxCyclePeriod?: number;
        origin?: Origin;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
    }): Promise<{ turnIds: number[]; finalStatus: number; hitMaxTurns: boolean; reason: "max_turns" | "strike_threshold" | "external" | null }> {
        const turnIds: number[] = [];
        const suddenDeathThreshold = maxTurns - maxStrikes;

        const cleanup = (): void => {
            this.#strikeState.delete(loopId);
            this.#telemetryBuffer.delete(loopId);
        };

        while (true) {
            signal?.throwIfAborted();

            const row = await (this.#db.engine_loop_status as PrepMethod).get<{ status: number }>({ loop_id: loopId });
            if (row === undefined) throw new Error(`Engine.runLoop: loop ${loopId} not found`);
            if (row.status !== 102) {
                cleanup();
                return { turnIds, finalStatus: row.status, hitMaxTurns: false, reason: "external" };
            }

            if (turnIds.length >= maxTurns) {
                await (this.#db.engine_loop_cancel as PrepMethod).run({ loop_id: loopId });
                cleanup();
                return { turnIds, finalStatus: 499, hitMaxTurns: true, reason: "max_turns" };
            }

            const turn = await this.runTurn({
                provider, messages, persona, sessionId, runId, loopId, origin, signal, onDispatch,
                turnNumber: turnIds.length + 1, maxTurns,
            });
            turnIds.push(turn.turnId);

            // Rail #39: cycle detection. Push this turn's fingerprint to
            // history, scan for repetition patterns. Detection bumps
            // turnErrors so the strike system handles abandonment naturally.
            const state = this.#strikeState.get(loopId) ?? { streak: 0, turnErrors: 0, history: [] };
            state.history.push(turn.fingerprint);
            const cycle = detectCycle(state.history, minCycles, maxCyclePeriod);
            if (cycle.detected) {
                state.turnErrors++;
                this.#pushTelemetry(loopId, {
                    kind: "cycle",
                    period: cycle.period,
                    cycles: cycle.cycles,
                    message: `repeating pattern detected: ${cycle.cycles}× period-${cycle.period}; vary your approach`,
                });
            }
            this.#strikeState.set(loopId, state);

            // Rail #38: strike accounting. Three sources strike a turn:
            //  1. recordedFailed — any action-entry at hard failure status
            //     (>= 400 and not in SOFT_FAILURE_STATUSES).
            //  2. noOps — turn.status === TURN_STATUS_NO_OPS (per #41).
            //  3. turnErrors — externally bumped by per-turn rails (#39 cycle).
            // Struck → streak++; clean → streak = 0. Threshold → abandon.
            const recordedFailed = turn.statuses.some((s) => s >= 400 && !SOFT_FAILURE_STATUSES.has(s));
            const noOps = turn.status === TURN_STATUS_NO_OPS;
            const struck = noOps || recordedFailed || state.turnErrors > 0;
            if (struck) {
                state.streak++;
                this.#pushTelemetry(loopId, {
                    kind: "strike",
                    streak: state.streak,
                    maxStrikes,
                    reason: noOps ? "no_ops" : recordedFailed ? "recorded_failure" : "rail",
                });
                if (state.streak >= maxStrikes) {
                    await (this.#db.engine_loop_cancel as PrepMethod).run({ loop_id: loopId });
                    cleanup();
                    return { turnIds, finalStatus: 499, hitMaxTurns: false, reason: "strike_threshold" };
                }
            } else {
                state.streak = 0;
            }
            state.turnErrors = 0;
            this.#strikeState.set(loopId, state);

            // Rail #40: sudden-death soft warning. When the loop enters the
            // last maxStrikes-sized window before maxTurns, push a warning
            // each turn so the model can wrap up before the hard cancel.
            // Soft: no strike, no loop-status change. SPEC §15.1.
            if (turnIds.length >= suddenDeathThreshold && turnIds.length < maxTurns) {
                this.#pushTelemetry(loopId, {
                    kind: "sudden_death",
                    message: `approaching max turns: ${turnIds.length} of ${maxTurns}; emit SEND[200] to complete`,
                    remaining: maxTurns - turnIds.length,
                });
            }
        }
    }

    async runTurn({
        provider, messages, persona = "", sessionId, runId, loopId, origin = "model", signal, onDispatch,
        turnNumber = 1, maxTurns = 50,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        persona?: string;
        sessionId: number; runId: number; loopId: number;
        origin?: Origin;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
        // Position in the surrounding loop. Used to build per-turn LLM
        // context: turn 1 carries the initial user prompt verbatim; turn
        // N>1 substitutes a continuation marker (rummy's pattern). Both
        // are augmented with the durable state (index/log/telemetry).
        turnNumber?: number;
        maxTurns?: number;
    }): Promise<{ turnId: number; status: number; statuses: number[]; fingerprint: string }> {
        // Build the spec'd packet (Packet.json) request half BEFORE the
        // provider call. The wire payload is a projection OF this packet;
        // the stored packet is the same object completed with the
        // assistant section after the response arrives.
        const requestPacket = await this.#buildRequestPacket({
            initialMessages: messages, persona, runId, loopId, turnNumber, maxTurns, provider,
        });
        const modelMessages = this.#packetToWireMessages(requestPacket);
        const response = await provider.generate({ messages: modelMessages, signal });

        // Engine splits wire-level response: emission (content, reasoning,
        // parsed ops) → packet.assistant per Packet.json §assistant;
        // call-metadata (usage, finishReason, model) → Turn columns per
        // Turn.json. Mixing the two on packet.assistant was the wrong layer.
        const { packetAssistant, callMetadata } = this.#splitResponse(response);
        const opsCount = packetAssistant.ops.length;
        const sendOp = packetAssistant.ops.findLast(
            (op): op is PlurnkStatement & { op: "SEND"; signal: number } =>
                op.op === "SEND" && typeof op.signal === "number",
        );
        // Rail #41 (revised): the per-turn requirement is "emit at least one
        // op," not "emit a terminal SEND." SEND is purely a signal verb; many
        // turns may pass without one. An empty op list is the only strike.
        const turnStatus = sendOp !== undefined
            ? sendOp.signal
            : opsCount === 0 ? TURN_STATUS_NO_OPS : TURN_STATUS_IMPLICIT_CONTINUE;

        const seqRow = await (this.#db.engine_next_turn_sequence as PrepMethod).get<{ next: number }>({ loop_id: loopId });
        const seq = (seqRow as { next: number }).next;
        // Complete the spec'd packet by adding the response section.
        // requestPacket already has system + user matching what was sent
        // to the LLM (one source of truth across wire payload and storage).
        const packet = this.#completePacket(requestPacket, packetAssistant, response.assistantRaw, provider);
        const { usage, finishReason, model } = callMetadata;
        const turnRow = await (this.#db.engine_insert_turn as PrepMethod).get<{ id: number }>({
            loop_id: loopId,
            sequence: seq,
            status: turnStatus,
            packet: JSON.stringify(packet),
            usage_prompt: usage.prompt,
            usage_completion: usage.completion,
            usage_cached: usage.cached,
            usage_cost_pico: provider.costFor(usage),
            finish_reason: finishReason,
            model,
        });
        if (turnRow === undefined) throw new Error("Engine.runTurn: turn insert returned no row");
        const turnId = turnRow.id;

        const statuses: number[] = [];
        for (const [actionIndex, statement] of packetAssistant.ops.entries()) {
            const result = await this.dispatch({
                statement, sessionId, runId, loopId, turnId, actionIndex, origin, onDispatch,
            });
            statuses.push(result.status);
        }

        if (opsCount === 0) {
            // Rail #41 (revised): per-turn requirement is "emit at least one
            // op." Zero ops = actionless failure. SEND specifically is not
            // required — any of the 9 grammar ops satisfies. Pushed AFTER
            // #buildPacket so this turn's drain doesn't consume it.
            this.#pushTelemetry(loopId, {
                kind: "no_ops",
                message: "turn ended without emitting any op; emit at least one operation per turn",
            });
        }

        return { turnId, status: turnStatus, statuses, fingerprint: fingerprintTurn(packetAssistant.ops) };
    }

    // Split the wire-level ProviderResponse into the two destinations:
    // packet.assistant gets the model's emission (content, ops, reasoning);
    // Turn columns get the call-metadata (usage, finishReason, model).
    // PROVIDERS.md §3.3 text-fragment scraping policy lives here — engine
    // owns the parse and the scraping rule, providers stay grammar-unaware.
    //
    // Test-fixture escape hatch: the Mock provider may pre-supply `ops` on
    // its assistant payload to skip the parse roundtrip. The wire Provider
    // contract has no `ops` field; only Mock exposes one. Real providers
    // always take the parse path because their `assistant.ops` is undefined.
    #splitResponse(response: ProviderResponse): { packetAssistant: PacketAssistant; callMetadata: TurnCallMetadata } {
        const { assistant } = response;
        const preParsedOps = (assistant as { ops?: PlurnkStatement[] }).ops;
        const ops: PlurnkStatement[] = [];
        const textFragments: string[] = [];
        if (preParsedOps !== undefined) {
            ops.push(...preParsedOps);
        } else {
            const parsed = PlurnkParser.parse(assistant.content);
            for (const item of parsed.items) {
                if (item.kind === "statement") ops.push(item.statement);
                else if (item.kind === "text") {
                    const trimmed = item.text.trim();
                    if (trimmed.length > 0) textFragments.push(trimmed);
                }
            }
        }
        const wireReasoning = assistant.reasoning ?? "";
        const scrapedReasoning = textFragments.join("\n");
        const reasoningParts = [wireReasoning, scrapedReasoning].filter((s) => s.length > 0);
        const reasoning = reasoningParts.length > 0 ? reasoningParts.join("\n\n") : null;
        return {
            packetAssistant: { content: assistant.content, ops, reasoning },
            callMetadata: { usage: assistant.usage, finishReason: assistant.finishReason, model: assistant.model },
        };
    }

    // Assemble the request half of the spec'd packet (Packet.json §system
    // and §user) BEFORE the provider call. The same packet object is then
    // completed with assistant + assistantRaw after the model responds, so
    // the stored packet and the wire payload share one source of truth.
    // Per Packet.json: user.prompt is "Copy of loop.prompt — never null on
    // a continuation turn"; the turn-N-of-M continuation marker rides on
    // user.system_requirements (per-turn rules), NOT a mutated prompt.
    async #buildRequestPacket({
        initialMessages, persona: defaultPersona, runId, loopId, turnNumber, maxTurns, provider,
    }: {
        initialMessages: ChatMessage[];
        // Fallback persona content — used only when no per-loop, per-run, or
        // per-session override exists in the database (issue #150 cascade).
        // Caller sources this from PATHS.defaultPersona (PLURNK_PERSONA env
        // override → persona.md package default).
        persona: string;
        runId: number; loopId: number;
        turnNumber: number; maxTurns: number;
        provider: Provider;
    }): Promise<RequestPacket> {
        const byRole = (role: ChatMessage["role"]): string =>
            initialMessages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        const system_definition = byRole("system");
        const prompt = byRole("user");
        // Resolve persona cascade: loops.persona > runs.persona >
        // sessions.persona > caller-supplied default. SQL coalesces in one
        // query; null result means no DB override exists, use the default.
        const row = await (this.#db.engine_resolve_persona as PrepMethod).get<{ persona: string | null }>({ loop_id: loopId });
        const persona = (row?.persona !== undefined && row?.persona !== null) ? row.persona : defaultPersona;
        const index = await this.#buildIndex(runId);
        const log = await this.#buildLog(runId);
        const telemetryErrors = await this.#buildTelemetryErrors(loopId);
        // Rummy AgentLoop.js #buildContinuationPrompt: literally
        // `Turn ${turn}/${maxTurns}`. That's the whole string. The model
        // can read the action log to see what it already did; it does
        // not need editorial instructions from us about not repeating.
        const system_requirements = turnNumber > 1
            ? `Turn ${turnNumber}/${maxTurns}`
            : "";
        // Per-section render-cost subtotals via provider's tokenizer.
        // Engine approximates each section by tokenizing its serialized
        // form — wire-payload tokens may differ slightly because chat-
        // template scaffolding adds bytes, but the subtotal tracks "what
        // the model has to process" closely enough for budget diagnostics.
        const systemTokens =
            provider.countTokens(system_definition) +
            provider.countTokens(persona) +
            provider.countTokens(JSON.stringify(index)) +
            provider.countTokens(JSON.stringify(log));
        // user.telemetry.budget — shimmed with section-aggregate table.
        // Real per-scheme breakdown is on AGENTS.md TODO (provider doesn't
        // yet expose getContextSize; user-side token count is below).
        const budget = this.#renderBudgetShim(systemTokens, provider, prompt, system_requirements, telemetryErrors);
        const userTokens =
            provider.countTokens(prompt) +
            provider.countTokens(system_requirements) +
            provider.countTokens(JSON.stringify(telemetryErrors)) +
            provider.countTokens(budget);
        return {
            system: {
                tokens: systemTokens,
                system_definition,
                persona,
                index,
                log,
            },
            user: {
                tokens: userTokens,
                prompt,
                telemetry: { budget, errors: telemetryErrors },
                system_requirements,
            },
        };
    }

    // user.telemetry.budget — SHIM. Per AGENTS.md §Open: real per-scheme
    // breakdown + context-window "free/percent-of-total" awaits provider
    // contract additions (getContextSize). Until then, render the section-
    // aggregate counts we already compute so the wire's `# Plurnk System
    // Budget` section is non-empty for picking-apart purposes.
    #renderBudgetShim(systemTokens: number, provider: Provider, prompt: string, system_requirements: string, telemetryErrors: object[]): string {
        const userPromptTokens = provider.countTokens(prompt);
        const userReqTokens = provider.countTokens(system_requirements);
        const userErrTokens = provider.countTokens(JSON.stringify(telemetryErrors));
        const userTokens = userPromptTokens + userReqTokens + userErrTokens;
        const total = systemTokens + userTokens;
        const pct = (n: number): string => total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;
        return [
            "| Section | Used | Percent |",
            "|---|---|---|",
            `| system | ${systemTokens} | ${pct(systemTokens)} |`,
            `| user | ${userTokens} | ${pct(userTokens)} |`,
            `| **Total** | **${total}** | **100.0%** |`,
        ].join("\n");
    }

    // Wire projection lives in ./packet-wire.js (plain JS) so Engine and
    // bin/digest.js import the exact same function — structurally one
    // implementation, no drift between wire and digest possible.
    // Format: markdown (user pick over rummy's XML alternative, 2026-05-22).
    #packetToWireMessages(packet: RequestPacket): ChatMessage[] {
        return packetToWireMessages(packet) as ChatMessage[];
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

    // Render-time mimetype invocation (SPEC §4 {§4-handlers-fire-render-time},
    // §5.1 {§5.1-preview-is-handler-output}). For each (run, entry, channel)
    // with indexed=1, pass the channel's current content through
    // mimetype.preview(content, budget). State is included verbatim — engine
    // does NOT branch on it (§5.6 {§5.6-engine-does-not-branch-on-state}).
    // SPEC §15.1: model-facing alert surface.
    // Two sources, merged on each packet build:
    //   1. Previous-turn action-bound failures (status_rx >= 400 on log_entries).
    //   2. Engine-buffered actionless failures (no_send, parse, watchdog, rails).
    // Buffer drains on read — each error appears in exactly one packet.
    async #buildTelemetryErrors(loopId: number): Promise<object[]> {
        const rows = await (this.#db.engine_render_telemetry_errors as PrepMethod).all<{
            op: string; action_index: number; status_rx: number;
            rx: string; mimetype_rx: string;
            target_scheme: string | null; target_pathname: string | null;
            turn_seq: number; loop_seq: number;
        }>({ loop_id: loopId });
        const actionFailures = rows.map((r) => {
            const target = r.target_scheme !== null
                ? `${r.target_scheme}://${r.target_pathname ?? ""}`
                : (r.target_pathname ?? null);
            const parsedRx = r.mimetype_rx === "application/json" ? JSON.parse(r.rx) : r.rx;
            return {
                kind: "action_failure",
                coordinate: `${r.loop_seq}/${r.turn_seq}/${r.action_index}`,
                op: r.op,
                target,
                status: r.status_rx,
                message: typeof parsedRx === "object" && parsedRx !== null && "error" in parsedRx
                    ? (parsedRx as { error: string }).error
                    : typeof parsedRx === "string" ? parsedRx : "",
            };
        });
        return [...this.#drainTelemetry(loopId), ...actionFailures];
    }

    // SPEC §15 packet.system.log — chronological action-entries for the loop.
    // Snapshot is taken at packet build (pre-dispatch this turn), so it
    // reflects "what has happened before this turn." Each row carries a
    // log://<loop_seq>/<turn_seq>/<action_index> coordinate the model can READ.
    async #buildLog(runId: number): Promise<object[]> {
        // SPEC §0.6: runs own log entries — log is the run's history,
        // not the loop's. Span all loops in the run so the model sees
        // earlier loops' work as conversational memory.
        const rows = await (this.#db.engine_render_log as PrepMethod).all<{
            loop_seq: number; turn_seq: number; action_index: number;
            origin: string; op: string; suffix: string; signal: string | null;
            target_scheme: string | null; target_username: string | null; target_password: string | null;
            target_hostname: string | null; target_port: number | null; target_pathname: string | null;
            target_params: string | null; target_fragment: string | null;
            status_rx: number; rx: string; mimetype_rx: string;
        }>({ run_id: runId });
        const realEntries = rows.map((r) => ({
            sortKey: [r.loop_seq, r.turn_seq, r.action_index] as [number, number, number],
            entry: {
                coordinate: `${r.loop_seq}/${r.turn_seq}/${r.action_index}`,
                origin: r.origin,
                op: r.op,
                suffix: r.suffix,
                signal: r.signal === null ? null : JSON.parse(r.signal),
                target: {
                    scheme: r.target_scheme,
                    username: r.target_username, password: r.target_password,
                    hostname: r.target_hostname, port: r.target_port,
                    pathname: r.target_pathname,
                    params: r.target_params === null ? null : JSON.parse(r.target_params),
                    fragment: r.target_fragment,
                },
                status: r.status_rx,
                rx: r.mimetype_rx === "application/json" ? JSON.parse(r.rx) : r.rx,
                mimetype_rx: r.mimetype_rx,
            },
        }));
        // Synthetic PROMPT entries — SHIM per AGENTS.md §Open. One per
        // loop in the run with a non-empty prompt, coordinate L/0/0 so
        // sort-by-(loop,turn,action) places it before that loop's actions.
        // NOT URI-addressable yet; real fix writes a first-class log_entries
        // row at loop start so the model can READ it.
        const loopRows = await (this.#db.engine_get_run_prompts as PrepMethod).all<{ id: number; sequence: number; prompt: string }>({ run_id: runId });
        const promptEntries = loopRows.map((l) => ({
            sortKey: [l.sequence, 0, 0] as [number, number, number],
            entry: {
                coordinate: `${l.sequence}/0/0`,
                origin: "client",
                op: "PROMPT",
                suffix: "",
                signal: null,
                target: {
                    scheme: null, username: null, password: null,
                    hostname: null, port: null, pathname: null,
                    params: null, fragment: null,
                },
                status: 200,
                rx: l.prompt,
                mimetype_rx: "text/plain",
            },
        }));
        return [...realEntries, ...promptEntries]
            .sort((a, b) => {
                if (a.sortKey[0] !== b.sortKey[0]) return a.sortKey[0] - b.sortKey[0];
                if (a.sortKey[1] !== b.sortKey[1]) return a.sortKey[1] - b.sortKey[1];
                return a.sortKey[2] - b.sortKey[2];
            })
            .map((e) => e.entry);
    }

    async #buildIndex(runId: number): Promise<object[]> {
        const rows = await (this.#db.engine_render_index as PrepMethod).all<IndexedRow>({ run_id: runId });
        const tagsStmt = this.#db.engine_entry_tags as PrepMethod;

        const entries = new Map<number, {
            id: number; version: number; scope: "agent" | "session"; session_id: number | null;
            scheme: string | null; username: string | null; password: string | null;
            hostname: string | null; port: number | null; pathname: string;
            params: Record<string, string> | null;
            channels: Record<string, { content: string; mimetype: string; tokens: number }>;
            attributes: Record<string, unknown>;
            tags: string[];
        }>();

        for (const row of rows) {
            let entry = entries.get(row.entry_id);
            if (entry === undefined) {
                const tagRows = await tagsStmt.all<{ tag: string }>({ entry_id: row.entry_id });
                entry = {
                    id: row.entry_id,
                    version: row.version,
                    scope: row.scope,
                    session_id: row.session_id,
                    scheme: row.scheme,
                    username: row.username,
                    password: row.password,
                    hostname: row.hostname,
                    port: row.port,
                    pathname: row.pathname,
                    params: row.params === null ? null : JSON.parse(row.params),
                    channels: {},
                    attributes: JSON.parse(row.attributes),
                    tags: tagRows.map((r) => r.tag),
                };
                entries.set(row.entry_id, entry);
            }
            // Mimetypes.process owns the full preview pipeline: detect (or
            // honor the hint), resolve handler, validate, extract → symbols,
            // budget-truncate via the framework's fit/fitContent. Passing
            // `hint: row.mimetype` short-circuits detection — service already
            // knows what each channel is.
            const result = await this.#mimetypes.process(
                { content: row.content, hint: row.mimetype },
                { budget: this.#previewBudget },
            );
            entry.channels[row.channel] = {
                content: result.preview,
                mimetype: row.mimetype,
                tokens: row.tokens,
            };
        }

        return [...entries.values()];
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        const { statement, sessionId, runId, loopId, turnId, actionIndex, origin, onDispatch } = context;
        const schemeCtx: PlurnkSchemeContext = {
            db: this.#db,
            sessionId, runId, loopId, turnId,
            writer: origin as WriterTier,
            signal: undefined,
        };
        let result: DispatchResult;
        const denial = this.#checkWritable(statement, origin);
        if (denial !== null) {
            result = denial;
        } else {
            // SCHEMES.md §7.1 / §8: action-entry-as-outcome. Scheme-handler
            // exceptions become the action-entry's outcome (status 500), not a
            // thrown bubble. The log_entry is the durable record; engine never
            // skips it. Logging failures (#writeLog throws) are NOT caught —
            // those are system failures.
            try {
                if (statement.op === "SEND" && statement.path === null) {
                    result = await this.#handleSendBroadcast(statement, loopId);
                } else if (statement.op === "COPY") {
                    result = await this.#handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#handleMove(statement, schemeCtx);
                } else {
                    result = await this.#run(this.#schemeNameOf(statement.path), statement, schemeCtx);
                }
            } catch (err) {
                result = {
                    status: 500,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }
        const logEntryId = await this.#writeLog({ statement, result, runId, loopId, turnId, actionIndex, origin });
        onDispatch?.(logEntryId);
        // Proposal lifecycle (task #42, AGENTS.md §Phase E). When a scheme
        // returns status 202, the entry is written as state='proposed';
        // dispatch then PAUSES on a per-entry waiter until resolution
        // arrives via Engine.resolveProposal (from the loop/resolve RPC,
        // YOLO listener, or timeout — Phase E.2/E.3 work). The post-
        // resolution status replaces 202 in the result the caller sees,
        // so runTurn never branches on a pending state.
        if (result.status === 202) {
            // Register the resolution waiter SYNCHRONOUSLY before any await
            // yields. A same-tick resolveProposal() (e.g. from a test that
            // awaits the onDispatch callback and immediately resolves) must
            // find the waiter registered — adding an await between insert
            // and waiter-registration would open a race window.
            const resolutionPromise = this.#awaitResolution(logEntryId);
            // Notify external listeners (Daemon broadcasts loop/proposal;
            // YOLO listener auto-resolves) BEFORE awaiting — they may
            // resolve synchronously inside their handlers.
            const target = this.#extractTarget(statement.path);
            const flags = await this.#loadLoopFlags(loopId);
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
            const effective = await this.#runApplyResolution(statement, result, resolution);
            const post = await this.#applyResolution(logEntryId, effective);
            return post;
        }
        return result;
    }

    async #runApplyResolution(
        statement: PlurnkStatement,
        originalResult: DispatchResult,
        resolution: ProposalResolution,
    ): Promise<ProposalResolution> {
        if (resolution.decision !== "accept") return resolution;
        const schemeName = this.#schemeNameOf(statement.path);
        if (schemeName === null) return resolution;
        const handler = this.#schemes.get(schemeName) as
            | { applyResolution?: (args: { attrs: object; body?: string }) => Promise<{ status: number; outcome?: string; body?: string }> }
            | undefined;
        if (handler === undefined || typeof handler.applyResolution !== "function") return resolution;
        try {
            const applyResult = await handler.applyResolution({
                attrs: (originalResult.attrs ?? {}) as object,
                body: resolution.body,
            });
            if (applyResult.status >= 400) {
                return {
                    decision: "reject",
                    outcome: applyResult.outcome ?? "apply_failed",
                    body: applyResult.body,
                };
            }
            return resolution;
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
                    resolve({ decision: "cancel", outcome: "timeout" });
                }
            }, timeoutMs);
            this.#pendingProposals.set(logEntryId, { resolve, timeoutHandle });
        });
    }

    async #applyResolution(logEntryId: number, resolution: ProposalResolution): Promise<DispatchResult> {
        // Map decision → terminal state + HTTP-aligned status:
        //   accept  → state='resolved', status=200
        //   reject  → state='failed',   status=400, outcome='rejected' (default)
        //   cancel  → state='cancelled',status=499, outcome='loop_aborted' (default)
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
        const rx = JSON.stringify({ status, outcome, body: resolution.body ?? null });
        await (this.#db.engine_resolve_log_entry as PrepMethod).run({
            id: logEntryId, state, outcome, status_rx: status, rx,
        });
        return { status, outcome, body: resolution.body };
    }

    // SCHEMES.md §8 {§8-writable-by-enforcement}: engine rejects writes whose
    // origin is outside the target scheme's manifest.writableBy.
    // - Read-side ops (READ, FIND, SHOW, HIDE) are not gated.
    // - SEND broadcast (path=null) has no target scheme; not gated.
    // - COPY: dst scheme writableBy applies.
    // - MOVE: both src (delete) and dst (write) schemes' writableBy apply.
    // - Schemes without a manifest are not gated (legacy / future allowance).
    #checkWritable(statement: PlurnkStatement, origin: Origin): DispatchResult | null {
        if (!MUTATING_OPS.has(statement.op)) return null;
        if (statement.op === "SEND" && statement.path === null) return null;

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dstScheme = this.#schemeNameOf(statement.body);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = this.#schemeNameOf(statement.path);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = this.#schemeNameOf(statement.path);
        return this.#denyIfDisallowed(target, origin);
    }

    #denyIfDisallowed(schemeName: string | null, origin: Origin): DispatchResult | null {
        if (schemeName === null) return null;
        const handler = this.#schemes.get(schemeName);
        if (handler === undefined) return null;
        const manifest = (handler.constructor as { manifest?: SchemeManifest }).manifest;
        if (manifest === undefined) return null;
        if (manifest.writableBy.includes(origin as WriterTier)) return null;
        return { status: 403, error: `writer '${origin}' is not in writableBy for scheme '${schemeName}'` };
    }

    async #handleCopy(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "COPY") throw new Error("unreachable");
        const srcPath = statement.path;
        const dstPath = statement.body;
        if (srcPath === null) return { status: 400, error: "COPY requires source path" };
        if (dstPath === null) return { status: 400, error: "COPY requires destination path (in body slot)" };
        return await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
    }

    async #handleMove(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "MOVE") throw new Error("unreachable");
        const srcPath = statement.path;
        const dstPath = statement.body;
        if (srcPath === null) return { status: 400, error: "MOVE requires source path" };

        const srcSchemeName = this.#schemeNameOf(srcPath);
        if (srcSchemeName === null) return { status: 400, error: "MOVE source must be a URL path with a scheme" };
        const srcHandler = this.#schemes.get(srcSchemeName) as SchemeWithCrud | undefined;
        if (srcHandler === undefined || typeof srcHandler.deleteEntry !== "function") return { status: 501 };

        // Null-body MOVE = delete the source entry (per SPEC §6.5)
        if (dstPath === null) {
            const srcPathname = pathnameFromPath(srcPath);
            const delResult = await srcHandler.deleteEntry(srcPathname, ctx);
            return { status: delResult.status };
        }

        // Relocation: COPY then DELETE source
        const copyResult = await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
        if (copyResult.status >= 400) return copyResult;
        const srcPathname = pathnameFromPath(srcPath);
        const delResult = await srcHandler.deleteEntry(srcPathname, ctx);
        if (delResult.status >= 400) return { status: delResult.status };
        return copyResult;
    }

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
        if (srcResult.status !== 200 || srcResult.entry === null) return { status: 404, error: `COPY/MOVE source not found: ${srcSchemeName}://${srcPathname}` };
        const entry = srcResult.entry;

        // Conflict check on destination
        if (typeof dstHandler.readEntry === "function") {
            const dstExists = await dstHandler.readEntry(dstPathname, ctx);
            if (dstExists.status === 200) return { status: 409, error: `COPY/MOVE destination exists: ${dstSchemeName}://${dstPathname}` };
        }

        // Mimetype compatibility check against the destination scheme's manifest
        const dstManifest = (dstHandler.constructor as { manifest?: SchemeManifest }).manifest;
        const dstChannels = dstManifest?.channels ?? {};
        for (const [channelName, channelData] of Object.entries(entry.channels)) {
            const expectedMimetype = dstChannels[channelName];
            if (expectedMimetype !== undefined && expectedMimetype !== channelData.mimetype) {
                return { status: 415, error: `mimetype mismatch on channel '${channelName}': ${channelData.mimetype} vs ${expectedMimetype}` };
            }
        }

        // Tag resolution: signal = replace; absent/empty = carry from source
        const tags = (Array.isArray(statement.signal) && statement.signal.length > 0)
            ? statement.signal
            : entry.tags;

        const writeResult = await dstHandler.writeEntry(dstPathname, { channels: entry.channels, tags }, ctx);
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
        return method.call(handler, statement, ctx);
    }

    // Bare paths default to the file scheme per plurnk.md (grammar sysprompt):
    // "Bare paths (no scheme) default to local relative project file paths."
    // file:// remains an optional explicit form for absolute paths.
    #schemeNameOf(path: ParsedPath | null): string | null {
        if (path === null) return null;
        if (path.kind === "url") return path.scheme;
        return "file";  // local (bare) → file
    }

    async #writeLog({
        statement, result, runId, loopId, turnId, actionIndex, origin,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        runId: number; loopId: number; turnId: number; actionIndex: number; origin: Origin;
    }): Promise<number> {
        const target = this.#extractTarget(statement.path);
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
        const attrs = (result.attrs !== undefined && result.attrs !== null)
            ? JSON.stringify(result.attrs)
            : "{}";
        const row = await (this.#db.engine_insert_log_entry as PrepMethod).get<{ id: number }>({
            run_id: runId,
            loop_id: loopId,
            turn_id: turnId,
            action_index: actionIndex,
            origin,
            op: statement.op,
            suffix: statement.suffix,
            signal: this.#signalToJson(statement.signal),
            target_scheme: target.scheme,
            target_username: target.username,
            target_password: target.password,
            target_hostname: target.hostname,
            target_port: target.port,
            target_pathname: target.pathname,
            target_params: target.params,
            target_fragment: target.fragment,
            lineMarker: lineMarkerJson,
            tx: JSON.stringify(statement),
            mimetype_tx: "application/json",
            rx: JSON.stringify(result),
            mimetype_rx: "application/json",
            status_rx: result.status,
            state: isProposed ? "proposed" : "resolved",
            outcome: null,
            attrs,
        });
        if (row === undefined) throw new Error("Engine.#writeLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    #extractTarget(path: ParsedPath | null): {
        scheme: string | null; username: string | null; password: string | null;
        hostname: string | null; port: number | null; pathname: string | null;
        params: string | null; fragment: string | null;
    } {
        if (path === null) return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, params: null, fragment: null };
        if (path.kind === "local") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: path.raw, params: null, fragment: null };
        return {
            scheme: path.scheme, username: path.username, password: path.password,
            hostname: path.hostname, port: path.port, pathname: path.pathname,
            params: JSON.stringify(path.params), fragment: path.fragment,
        };
    }

    #signalToJson(signal: unknown): string | null {
        if (signal === null || signal === undefined) return null;
        return JSON.stringify(signal);
    }
}
