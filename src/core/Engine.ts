import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement, ParsedPath, LineMarker, PlurnkOp } from "@plurnk/plurnk-grammar";
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "./Db.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";

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

type DispatchResult = { status: number; [key: string]: unknown };

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
        provider, messages, sessionId, runId, loopId,
        maxTurns = 50, maxStrikes = readMaxStrikes(),
        minCycles = readPositiveInt("PLURNK_MIN_CYCLES", DEFAULT_MIN_CYCLES),
        maxCyclePeriod = readPositiveInt("PLURNK_MAX_CYCLE_PERIOD", DEFAULT_MAX_CYCLE_PERIOD),
        origin = "model", signal, onDispatch,
    }: {
        provider: Provider;
        messages: ChatMessage[];
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

            const turn = await this.runTurn({ provider, messages, sessionId, runId, loopId, origin, signal, onDispatch });
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
        provider, messages, sessionId, runId, loopId, origin = "model", signal, onDispatch,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        sessionId: number; runId: number; loopId: number;
        origin?: Origin;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
    }): Promise<{ turnId: number; status: number; statuses: number[]; fingerprint: string }> {
        const response = await provider.generate({ messages, signal });

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
        // Build packet BEFORE pushing this turn's actionless failures so the
        // drain at packet-build sees only PRIOR turns' failures. THIS turn's
        // failures are buffered AFTER and surface in the next packet.
        const packet = await this.#buildPacket(messages, packetAssistant, response.assistantRaw, runId, loopId, provider);
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

    async #buildPacket(
        messages: ChatMessage[], assistant: PacketAssistant, assistantRaw: unknown,
        runId: number, loopId: number, provider: Provider,
    ): Promise<object> {
        const byRole = (role: ChatMessage["role"]): string =>
            messages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        const systemDef = byRole("system");
        const userPrompt = byRole("user");
        const index = await this.#buildIndex(runId);
        const log = await this.#buildLog(loopId);
        const telemetryErrors = await this.#buildTelemetryErrors(loopId);
        // Per-section render-cost subtotals via provider's tokenizer. Engine
        // approximates each section by tokenizing its serialized form — exact
        // wire-payload tokens may differ slightly because OpenAI-compat
        // serialization adds chat-template scaffolding, but the subtotal
        // tracks "what the model has to process" closely enough to drive
        // context-bloat diagnostics + packet.user.telemetry.budget.
        const systemTokens = provider.countTokens(systemDef) + provider.countTokens(JSON.stringify(index)) + provider.countTokens(JSON.stringify(log));
        const userTokens = provider.countTokens(userPrompt) + provider.countTokens(JSON.stringify(telemetryErrors));
        const assistantTokens = provider.countTokens(assistant.content);
        return {
            tokens: systemTokens + userTokens + assistantTokens,
            system: {
                tokens: systemTokens,
                system_definition: systemDef,
                persona: "",
                index,
                log,
            },
            user: {
                tokens: userTokens,
                prompt: userPrompt,
                telemetry: { budget: "", errors: telemetryErrors },
                system_requirements: "",
            },
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
    async #buildLog(loopId: number): Promise<object[]> {
        const rows = await (this.#db.engine_render_log as PrepMethod).all<{
            loop_seq: number; turn_seq: number; action_index: number;
            origin: string; op: string; suffix: string; signal: string | null;
            target_scheme: string | null; target_username: string | null; target_password: string | null;
            target_hostname: string | null; target_port: number | null; target_pathname: string | null;
            target_params: string | null; target_fragment: string | null;
            status_rx: number; rx: string; mimetype_rx: string;
        }>({ loop_id: loopId });
        return rows.map((r) => ({
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
        }));
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
        return result;
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

    #schemeNameOf(path: ParsedPath | null): string | null {
        if (path === null) return null;
        if (path.kind === "url") return path.scheme;
        return null;
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
