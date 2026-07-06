import { PlurnkParser, PlurnkParseError } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement, EditStatement, ReadStatement, UrlPath, FindStatement, TelemetryEvent } from "@plurnk/plurnk-grammar";

// Internal-only — collected from PlurnkParser output, then translated to
// TelemetryEvent envelopes (per @plurnk/plurnk-grammar 0.17.0 protocol)
// before being pushed to the loop's telemetry buffer.
type ParseErrorInfo = { message: string; line: number; column: number; source: string };
import type SchemeRegistry from "./SchemeRegistry.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "./Db.ts";
import type { EntryData } from "../schemes/_entry-crud.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import EntryManifest from "../schemes/_entry-manifest.ts";
import TokenGauge from "./TokenGauge.ts";
import GitMembership, { type FsDivergence } from "./git-membership.ts";
import GitState from "./git-state.ts";
import SessionSettings from "./session-settings.ts";
import type { WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { RegistryEntry } from "./ExecutorRegistry.ts";
import type { StreamEventNotify, TelemetryEventNotify, WakeRunNotify, InjectRunNotify, CancelRunNotify } from "./ChannelWrite.ts";
import { editedSpan } from "../content/index.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
// Format: markdown (user pick over rummy's XML alternative, 2026-05-22).
import PacketWire from "./packet-wire.ts";

// The engine's collaborators — each owns one machine; Engine owns the loop/turn
// lifecycle and wires them together as the public facade.
import TelemetryChannel, { type EngineErrorKind } from "./TelemetryChannel.ts";
import StrikeRail from "./StrikeRail.ts";
import PacketBuilder, { type ChatMessage, type PacketAssistant } from "./PacketBuilder.ts";
import ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalResolution, ProposalPendingEvent } from "./ProposalLifecycle.ts";
import Dispatcher from "./Dispatcher.ts";
import type { DispatchContext, DispatchResult } from "./Dispatcher.ts";

// Proposal types are part of Engine's public API (resolveProposal/onProposalPending);
// their definitions live with the lifecycle.
export type { ProposalDecision, ProposalResolution, ProposalPendingEvent } from "./ProposalLifecycle.ts";

const DEFAULT_MAX_STRIKES = 3;
const DEFAULT_MAX_COMMANDS = 99;

const readMaxStrikes = (): number => {
    const raw = process.env.PLURNK_SERVICE_MAX_STRIKES;
    if (raw === undefined || raw.length === 0) return DEFAULT_MAX_STRIKES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STRIKES;
    return n;
};

const readMaxCommands = (): number => {
    const raw = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    if (raw === undefined || raw.length === 0) return DEFAULT_MAX_COMMANDS;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_COMMANDS;
    return n;
};

// PLURNK_SERVICE_FILES_ITEMS — the turn-0 manifest preview. null = off (no foist);
// -1 = the full manifest; positive N = the first N items. 0 / unset = off.
const normalizeFilesItems = (n: number): number | null => (!Number.isFinite(n) || n === 0 ? null : n < 0 ? -1 : n);
const readFilesItems = (): number | null => {
    const raw = process.env.PLURNK_SERVICE_FILES_ITEMS;
    if (raw === undefined || raw.length === 0) return null;
    return normalizeFilesItems(Number.parseInt(raw, 10));
};

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { Provider, ProviderResponse, ProviderUsage } from "@plurnk/plurnk-providers";
import { ProviderError } from "@plurnk/plurnk-providers";

// Split-out call-metadata that travels with the parsed packet but lands in
// Turn columns instead of packet.assistant.
type TurnCallMetadata = {
    usage: ProviderUsage;
    finishReason: string | null;
    model: string;
};

// Default turn.status when ops were emitted but no SEND. Model is implicitly
// continuing; loop.status stays 102 either way (only SEND broadcast advances
// loop terminal). No strike, no telemetry.
const TURN_STATUS_IMPLICIT_CONTINUE = 102;

// Status assigned to a turn that emitted NO ops at all. Strike-worthy; the
// action routes through telemetry.errors[] (§telemetry, §telemetry-no-error-scheme — never an error:// scheme).
const TURN_STATUS_NO_OPS = 422;

const DEFAULT_MIN_CYCLES = 3;
const DEFAULT_MAX_CYCLE_PERIOD = 4;

const readPositiveInt = (envVar: string, fallback: number): number => {
    const raw = process.env[envVar];
    if (raw === undefined || raw.length === 0) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return n;
};

// §operator-config-loop-timeout — the loop's wall-clock budget (PLURNK_SERVICE_LOOP_TIMEOUT).
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
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    // Write-time tokenizer (SPEC §tokenomics). Synchronous per the provider
    // contract (§provider-surface). Populated from the active provider's countTokens via
    // the Daemon; a divisor tripwire stands in only for bare/standalone
    // construction before a provider is wired (same boot affordance as
    // Mimetypes, §mimetype-surface). Real counts come from provider.countTokens.
    #tokenize: (text: string) => number;
    // Boot-discovered runtime executors. Daemon builds + sets via
    // setExecutors at start(); undefined until then (and in bare tests).
    #executors: ExecutorRegistry | undefined;
    // §send-premature-terminate/[102]<T> — park deadlines by loopId, written at dispatch (the
    // marker's seconds; -1 = indefinite), consumed by the daemon's drain park-exit to schedule
    // the deadline wake. In-memory: a daemon restart drops pending deadlines (documented).
    readonly parkDeadlines: Map<number, number> = new Map();

    // The collaborators. Engine constructs them (they share its deps via
    // thunks where the value is late-injected — executors, loop signals)
    // and fronts their public surface.
    #telemetry: TelemetryChannel;
    #strikes: StrikeRail;
    #packets: PacketBuilder;
    #proposals: ProposalLifecycle;
    #dispatcher: Dispatcher;

    // Per-loop AbortController for cancellation propagation into scheme
    // ctx.signal. runLoop creates one at entry, cleans up at end. Engine
    // cancellation paths (strikes, max_turns, external) abort it.
    // Streaming schemes (exec) chain their per-spawn controllers off
    // ctx.signal so cancelled loops tear down their background spawns.
    #loopAborts = new Map<number, AbortController>();
    // §tokenomics-ceiling-calibrates-to-usage (#311) — the loop's observed real/measured token
    // ratio (provider usage.prompt ÷ our measured packet tokens), monotone max so the ceiling
    // only tightens. A chars/4 heuristic ruler undercounts escaped-JSON logs ~1.5×; calibrating
    // against the provider's own count makes a real context overflow unreachable past turn 1.
    #tokenRatios = new Map<number, number>();
    // §derivation-off-hot-path — the background derivation chain: the per-turn pump and the
    // session warm ride it instead of the turn (a 2-CPU container CPU-embedding a 335-entry
    // ingest starved every loop for ~28min, #316). Serialized (never two pumps interleaved),
    // drained at daemon stop (never racing db close), failures logged (never swallowed).
    // A turn never waits on an embedding; a ~query warms its own candidate slice inline
    // (§semantic-cold-query-full-fidelity), so cold sessions still get full-fidelity search.
    #derivationChain: Promise<void> = Promise.resolve();

    #queueDerivation(job: () => Promise<void>): Promise<void> {
        const run = this.#derivationChain.then(job).catch((err: unknown) => {
            process.stderr.write(`plurnk-engine: background derivation failed: ${err instanceof Error ? err.message : String(err)}\n`);
        });
        this.#derivationChain = run;
        return run;
    }

    // Awaited by Daemon.stop before the db closes.
    async drainDerivations(): Promise<void> {
        await this.#derivationChain;
    }

    #streamEventNotify: StreamEventNotify | undefined;
    #wakeRunNotify: WakeRunNotify | undefined;

    // Cached plurnk GBNF — read once on the first constrained generate (#189).
    #gbnfCache: string | null = null;

    constructor({ db, schemes, mimetypes, streamEventNotify, wakeRunNotify, injectRun, cancelRun, telemetryEventNotify, tokenize }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes?: Mimetypes;
        streamEventNotify?: StreamEventNotify;
        wakeRunNotify?: WakeRunNotify;
        injectRun?: InjectRunNotify;
        cancelRun?: CancelRunNotify;
        telemetryEventNotify?: TelemetryEventNotify;
        tokenize?: (text: string) => number;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeRunNotify = wakeRunNotify;
        // Default to empty discovery — standalone Engine construction (in
        // tests) gets no handlers, and content flows through the framework's
        // raw-content fitContent fallback. Daemon-managed Engine receives a
        // production-configured Mimetypes via the constructor arg.
        this.#mimetypes = mimetypes ?? new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map() },
        });
        // Tripwire default matches the Mimetypes boot affordance (SPEC §mimetype-surface):
        // the divisor stands in only until the provider-backed tokenizer is
        // wired by the Daemon. Real counts come from provider.countTokens.
        this.#tokenize = tokenize ?? ((text) => Math.ceil(text.length / 4));

        const executors = (): ExecutorRegistry | undefined => this.#executors;
        const loopSignal = (loopId: number): AbortSignal | undefined => this.#loopAborts.get(loopId)?.signal;
        this.#telemetry = new TelemetryChannel({ db, notify: telemetryEventNotify });
        this.#strikes = new StrikeRail();
        this.#packets = new PacketBuilder({ db, schemes, telemetry: this.#telemetry, executors });
        this.#proposals = new ProposalLifecycle({
            db, schemes, telemetry: this.#telemetry,
            streamEventNotify, wakeRunNotify,
            tokenize: this.#tokenize, executors, loopSignal,
        });
        this.#dispatcher = new Dispatcher({
            db, schemes, mimetypes: this.#mimetypes,
            tokenize: this.#tokenize,
            telemetry: this.#telemetry, proposals: this.#proposals,
            executors, loopSignal,
            streamEventNotify, wakeRunNotify, injectRun, cancelRun,
            parkDeadlines: this.parkDeadlines,
        });
    }

    // Late injection: the executor registry is async-built at daemon start()
    // (discover + probe), after Engine construction.
    setExecutors(executors: ExecutorRegistry): void {
        this.#executors = executors;
    }

    // Runtime hotload (#289) — register an executor TAG live, after boot (the /mcp route: an MCP
    // server connected at runtime becomes EXEC[<server>]). Registers on BOTH registries the boot path
    // wires: the ExecutorRegistry (dispatch resolves the tag; the tools sheet, rebuilt per packet, then
    // offers it to the model) and the SchemeRegistry face (the tag's READ/FIND/KILL scheme), sharing the
    // same reserved/cross-family arbitration boot uses. Fail-hard if the registry isn't wired yet — a
    // hotload before daemon start() is a caller bug, not a silent no-op.
    hotloadRuntime(tag: string, entry: RegistryEntry): void {
        if (this.#executors === undefined) throw new Error("hotloadRuntime: executor registry not wired yet (call after daemon start)");
        // Scheme face FIRST — it is the arbitration gate (reserved / cross-family collision, #240) and
        // throws before we mutate the executor registry, so a rejected tag leaves neither registry
        // half-written. A brand-new tag registers on both; a reserved/claimed tag throws here untouched.
        this.#schemes.registerRuntimeScheme(tag, entry.executor);
        this.#executors.register(tag, entry);
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
    async loopUsage(loopId: number): Promise<{ promptTokens: number; completionTokens: number; costPico: number; contextTokens: number; contextSize: number | null; meta: Record<string, unknown> }> {
        const row = await (this.#db.engine_loop_usage as PrepMethod).get<{ prompt: number; completion: number; cost_pico: number; context: number | null; context_size: number | null; meta: string | null }>({ loop_id: loopId });
        return {
            promptTokens: row?.prompt ?? 0,
            completionTokens: row?.completion ?? 0,
            costPico: row?.cost_pico ?? 0,
            // #263 — the last turn's prompt tokens = current window occupancy (gauge numerator), NOT the
            // summed promptTokens above, which overcounts a context that grows across turns.
            contextTokens: row?.context ?? 0,
            // #274 — the last turn's model window (denominator); null when the provider reports none.
            contextSize: row?.context_size ?? null,
            // #252 — the latest turn's opaque provider blob, parsed for the wire. Empty {} when the
            // provider returned no meta. The service forwards it; it never reads a field within.
            meta: JSON.parse(row?.meta ?? "{}") as Record<string, unknown>,
        };
    }

    // A @plurnk/gbnf divergence position (providers#24) is a CODE-POINT offset into the
    // model's content; the snippet/telemetry surface speaks 1-based line + 0-based column.
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
        provider, messages, requirements = "", sessionId, runId, loopId,
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
        sessionId: number; runId: number; loopId: number;
        maxTurns?: number;
        maxStrikes?: number;
        minCycles?: number;
        maxCyclePeriod?: number;
        origin?: WriterTier;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
    }): Promise<{ turnIds: number[]; finalStatus: number; hitMaxTurns: boolean; reason: "max_turns" | "strike_threshold" | "budget_overflow" | "loop_timeout" | "external" | null }> {
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

        // §operator-config-loop-timeout — the wall-clock budget. Expiry aborts the loop signal, so a
        // mid-flight provider call (generate rides this signal) and in-flight spawns tear down; the
        // loop terminates 504 (kin to the exec <T> reap's 504, §exec-timeout) — a legible engine
        // terminal, never an outside kill. unref'd: the wall never holds the process open.
        const wall = setTimeout(() => loopAbort.abort(LOOP_TIMEOUT_REASON), readLoopTimeoutMs());
        wall.unref();
        const timedOut = (): boolean => loopAbort.signal.aborted && loopAbort.signal.reason === LOOP_TIMEOUT_REASON;
        const ruleTimeout = async (): Promise<{ turnIds: number[]; finalStatus: number; hitMaxTurns: boolean; reason: "loop_timeout" }> => {
            await (this.#db.engine_loop_set_status as PrepMethod).run({ loop_id: loopId, status: 504, message: "loop_timeout" });
            cleanup("forceful", "loop_timeout");
            return { turnIds, finalStatus: 504, hitMaxTurns: false, reason: "loop_timeout" };
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
            this.#telemetry.delete(loopId);
            this.#tokenRatios.delete(loopId);
        };

        while (true) {
            // The wall fired between turns — rule 504 before anything else reads the loop.
            if (timedOut()) return await ruleTimeout();
            signal?.throwIfAborted();

            const row = await (this.#db.engine_loop_status as PrepMethod).get<{ status: number }>({ loop_id: loopId });
            if (row === undefined) throw new Error(`Engine.runLoop: loop ${loopId} not found`);
            if (row.status === 100) {
                // NOT a terminal — a wake re-queued this loop while its own live drain was
                // between turns (a child concluded in the gap between our 202 write and this
                // check, §run-lifecycle-wake-requeue-not-terminal). The wake's intent is KEEP
                // RUNNING: re-claim atomically and continue — the injected prompt is already
                // this loop's next turn. Returning it as "external" broadcast a QUEUED loop
                // as loop/terminated {finalStatus: 100} — the delegation-flags flake.
                await (this.#db.engine_reclaim_queued_loop as PrepMethod).run({ loop_id: loopId });
                continue; // claimed (or a racer flipped it first — the re-read decides)
            }
            if (row.status !== 102) {
                // Only 202 (Accepted) lets spawns outlive — it IS the async wake
                // contract (E.4). Every other terminal, 200 included, reaps: "done"
                // must not leak running execs. Trust the code's declared intent.
                cleanup(row.status === 202 ? "graceful" : "forceful", `loop_terminal_${row.status}`);
                return { turnIds, finalStatus: row.status, hitMaxTurns: false, reason: "external" };
            }

            if (maxTurns >= 0 && turnIds.length >= maxTurns) {
                // §loop-terminals — the turn ceiling is exhausted: 429 Too Many Requests
                // (kin to the soft sudden-death 429 warnings that precede it).
                await (this.#db.engine_loop_set_status as PrepMethod).run({ loop_id: loopId, status: 429, message: "max_turns" });
                cleanup("forceful", "max_turns");
                return { turnIds, finalStatus: 429, hitMaxTurns: true, reason: "max_turns" };
            }

            // PLURNK_SERVICE_EXEC_WAIT_MS — a post-EXEC breath: if a spawn from the prior turn
            // is still in flight, give it a tunable beat to land in THIS turn's packet
            // before we assemble it. A fixed grace beat, never a wait-for-completion;
            // 0/unset = off. Abortable with the loop signal.
            const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (runId: number) => boolean; hasActiveHoldSpawns?: (runId: number, holdSet: ReadonlySet<string>) => boolean } | undefined;
            // §exec-hold-until-concluded — the turn-hold exception (owner ruling): for runtimes in
            // the operator's HOLD set (the search family — streams we know and control: one final
            // JSON digest, seconds-bounded), the cycle PAUSES here until the stream concludes, so
            // the model never gets a turn it can only waste asking "are we there yet". Bounded by
            // PLURNK_SERVICE_EXEC_HOLD_MS and FAIL-OPEN: at the cap the standard cycle resumes
            // (the stream stays live; parks/wakes/polls all still apply). Zero grammar or teaching
            // change — the model emits EXEC + SEND[102] as ever; the next packet simply contains
            // the finished digest, open and final.
            const holdSet = new Set((process.env.PLURNK_SERVICE_EXEC_HOLD ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0));
            const holdCapMs = Number(process.env.PLURNK_SERVICE_EXEC_HOLD_MS ?? "45000");
            if (holdSet.size > 0 && holdCapMs > 0 && execHandler?.hasActiveHoldSpawns !== undefined) {
                const holdStart = Date.now();
                while (execHandler.hasActiveHoldSpawns(runId, holdSet) && Date.now() - holdStart < holdCapMs) {
                    await delay(150, undefined, { signal });
                }
            }
            const execWaitMs = Number(process.env.PLURNK_SERVICE_EXEC_WAIT_MS ?? "0");
            if (execWaitMs > 0) {
                if (execHandler?.hasActiveSpawns?.(runId) === true) await delay(execWaitMs, undefined, { signal });
            }

            let turn;
            try {
                turn = await this.runTurn({
                    provider, messages, requirements, sessionId, runId, loopId, origin, signal, onDispatch,
                    turnNumber: turnIds.length + 1, maxTurns,
                });
            } catch (err) {
                // The wall fired mid-turn — the abort tore the turn down (generate rides the loop
                // signal); rule the legible 504, never a generic drain error.
                if (timedOut()) return await ruleTimeout();
                throw err;
            }
            turnIds.push(turn.turnId);

            // SPEC §grinder: budget hard-stop — packet won't fit even collapsed → abandon.
            if (turn.budgetHardStop) {
                // §loop-terminals — the packet won't fit even collapsed: 413 Content Too Large.
                await (this.#db.engine_loop_set_status as PrepMethod).run({ loop_id: loopId, status: 413, message: "budget_overflow" });
                cleanup("forceful", "budget_overflow");
                return { turnIds, finalStatus: 413, hitMaxTurns: false, reason: "budget_overflow" };
            }

            // Rails #38/#39 — per-turn strike accounting (cycle detection, the
            // grinder/steer coupling, hard-failure statuses). StrikeRail owns the
            // bookkeeping; runLoop owns abandonment.
            const verdict = this.#strikes.assess(loopId, {
                fingerprint: turn.fingerprint,
                statuses: turn.statuses,
                noOps: turn.status === TURN_STATUS_NO_OPS,
                budgetStruck: turn.budgetStruck,
                steerStruck: turn.steerStruck,
                minCycles, maxCyclePeriod, maxStrikes,
            });
            if (verdict.thresholdCrossed) {
                // §loop-terminals — a cycle-driven strike is the model spinning in place
                // (508 Loop Detected); a failure/no-op strike is the model failing (500
                // Internal Server Error). The straw that crossed the threshold picks it.
                const status = verdict.cycleDetected ? 508 : 500;
                await (this.#db.engine_loop_set_status as PrepMethod).run({ loop_id: loopId, status, message: "strike_threshold" });
                cleanup("forceful", "strike_threshold");
                return { turnIds, finalStatus: status, hitMaxTurns: false, reason: "strike_threshold" };
            }

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
    }): Promise<{ turnId: number; status: number; statuses: number[]; fingerprint: string; budgetStruck: boolean; budgetHardStop: boolean; steerStruck: boolean }> {
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
        // #269 — loops.sequence is the loop's ordinal WITHIN the run. Turn-0 foists that belong to the
        // RUN (manifest preview, AGENTS, operator docs) gate on the run's FIRST loop, not every loop's
        // first turn; per-loop foists (the prompt, @file) still fire each loop. Read once, turn-1 only.
        const loopRow = seq === 1
            ? await (this.#db.engine_get_loop_prompt as PrepMethod).get<{ prompt: string; sequence: number }>({ loop_id: loopId })
            : undefined;
        const runFirstLoop = (loopRow?.sequence ?? 0) === 1;
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
        // §model-entry — the run's first turn opens with the model's own turn-0, mirrored OPEN: a
        // worked turn PLAN → the environment FINDs the foist ACTUALLY dispatches → SEND[102]. Built
        // from the real ops below (not a static print — we lean into the genuine echo paradigm) and
        // written at sequence 1, so it reads first as the emission with the foisted results following.
        const turnZeroMoves: string[] = [];
        if (seq === 1) {
            if (runFirstLoop) nextActionIndex = 2;  // reserve sequence 1 for the turn-0 echo
            // Operator doc READs (PLURNK_SERVICE_MD_<ALIAS>, §actor-boundary-doc-injection). The docs were materialized
            // as plurnk:///<entry> entries by the plurnk run (loop_run, via the
            // §actor-boundary keystone); foist a READ of each into THIS turn-0 so the model
            // reads them inline. It sees only the READ — the materializing EDIT
            // lives in the plurnk run's log, never the model's.
            // #231 — env docs (PLURNK_SERVICE_MD_*) UNION the session's client docs; foist a READ of
            // each materialized plurnk:///<alias>.md (loop_run materialized the same set).
            const { mdDocs } = await SessionSettings.read(this.#db, sessionId);
            // #269 — operator docs are run-once; foist them only on the run's first loop.
            for (const doc of runFirstLoop ? await SessionSettings.resolveDocs(mdDocs) : []) {
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
            const promptRow = loopRow; // #269 — already read above (per-loop; fires every loop's turn 1)
            if (promptRow !== undefined && typeof promptRow.prompt === "string" && promptRow.prompt.length > 0) {
                const promptPath: UrlPath = {
                    kind: "url", raw: `plurnk://prompt/${loopId}/${seq}`,
                    scheme: "plurnk", username: null, password: null,
                    hostname: "prompt", port: null,
                    pathname: `/${loopId}/${seq}`, params: {}, fragment: null,
                };
                const promptStmt: EditStatement = {
                    op: "EDIT", suffix: "", signal: null,
                    target: promptPath, lineMarker: null,
                    body: promptRow.prompt, position: { line: 1, column: 1 },
                };
                let promptLogId: number | undefined;
                await this.dispatch({
                    statement: promptStmt, sessionId, runId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk",
                    onDispatch: (id) => { promptLogId = id; onDispatch?.(id); },
                });
                // §prompt-fold: the prompt EDIT's row is folded — the body reaches the model
                // through the auto-READ below; the EDIT stays forensic, re-OPENable.
                if (promptLogId !== undefined) await (this.#db.engine_fold_log_entry as PrepMethod).run({ id: promptLogId });
                nextActionIndex++;
                // §prompt-auto-read (owner): the prompt's body reaches the model as a foisted
                // READ of its own entry — first 12 lines (<1,12>), or the whole prompt (<1,-1>)
                // when it runs fewer than 12 (whole-read form doubles as teaching). Prior prompts
                // stay listed by path in the system packet's User Prompts section — reachable,
                // never silently lost.
                const promptLineCount = promptRow.prompt.split("\n").length;
                const promptRead: ReadStatement = {
                    op: "READ", suffix: "", signal: null, target: promptPath,
                    lineMarker: { marks: promptLineCount >= 12 ? [1, 12] : [1, -1] },
                    body: null, position: { line: 1, column: 1 },
                };
                await this.dispatch({
                    statement: promptRead, sessionId, runId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk", onDispatch,
                });
                nextActionIndex++;
            }
        }

        // §prompt-auto-read, the mid-loop half (owner): an inject writes a prompt entry for
        // THIS turn's slot between turns — foist the same auto-READ so an injected prompt
        // arrives exactly like the first one (first 12 lines, or whole when fewer).
        if (seq > 1) {
            const injected = await (this.#db.drain_get_all_prompt_bodies_for_loop as PrepMethod).all<{ content: string; pathname: string }>({ pattern: `/prompt/${loopId}/${seq}` });
            const injectedRow = injected.find((r) => typeof r.content === "string" && r.content.length > 0);
            if (injectedRow !== undefined) {
                const lineCount = injectedRow.content.split("\n").length;
                const injTarget: UrlPath = {
                    kind: "url", raw: `plurnk://prompt/${loopId}/${seq}`,
                    scheme: "plurnk", username: null, password: null,
                    hostname: "prompt", port: null,
                    pathname: `/${loopId}/${seq}`, params: {}, fragment: null,
                };
                const injRead: ReadStatement = {
                    op: "READ", suffix: "", signal: null, target: injTarget,
                    lineMarker: { marks: lineCount >= 12 ? [1, 12] : [1, -1] },
                    body: null, position: { line: 1, column: 1 },
                };
                await this.dispatch({
                    statement: injRead, sessionId, runId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk", onDispatch,
                });
                nextActionIndex++;
            }
        }

        // The per-turn derivation pump (_entry-manifest.maintainDerivations) — refreshes
        // every entry's deep channels (symbols/refs/embeddings/FTS, deep_hash-gated) so the
        // catalog and FIND read current data. NOT an action: no log entry, no sequence slot,
        // not dispatched. There is no plurnk:///manifest.json entry — the catalog is served
        // on demand by FIND(scheme:///**), foisted into the run's first turn below.
        // #312 — the turn's token gauge: the ACTIVE provider's tokenizer identity + exact counter
        // (mimetypes seam; provider upper bound surfaced as tokenizer_unavailable when inexact).
        // Threaded per turn — never engine state — so concurrent loops on different providers
        // each read their own honest numbers.
        const gauge = await TokenGauge.resolve(this.#mimetypes, provider, (event: TelemetryEvent) => this.#telemetry.push(sessionId, loopId, event));
        const systemCtx: PlurnkSchemeContext = {
            db: this.#db, sessionId, runId, loopId, turnId,
            writer: "plurnk",
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeRunNotify: this.#wakeRunNotify,
            tokenize: this.#tokenize,
            gauge,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s),
            pushTelemetry: (event) => this.#telemetry.push(sessionId, loopId, event),
        };
        // SPEC §membership D4/D5 — git-ls-files workspace membership, resolved at
        // prompt-composition (EMI is eager + exhaustive — git is the only bound). When the
        // session's project_root is a git working tree, tracked files are
        // members without a client `add`; active members are materialized
        // (disk → body channel) so they appear in the catalog. No-ops
        // on headless / non-git sessions. Runs BEFORE the derivation pump so
        // this turn's packet reflects them.
        const fsDivergences = await GitMembership.indexGitMembership(systemCtx);
        await this.#logFsFictions(sessionId, fsDivergences);

        this.#queueDerivation(() => EntryManifest.maintainDerivations(systemCtx)); // §derivation-off-hot-path — the turn proceeds; ~queries warm their own slice

        // Turn-0 catalog preview (PLURNK_SERVICE_FILES_ITEMS, §actor-boundary-catalog-preview):
        // one FIND(scheme:///**) per scheme that holds entries, foisted into the run's first
        // model turn so it opens with its catalog (the per-scheme arrays that replaced the
        // single manifest.json). -1 → each scheme's whole catalog; N → its first N rows
        // (clamped to the scheme's count so FIND's strict <L> never 416s); off by default.
        if (seq === 1) {
            // #231 — a session's client-chosen filesItems REPLACES the env default outright.
            const { filesItems: sessionMI } = await SessionSettings.read(this.#db, sessionId);
            const filesItems = sessionMI !== null ? normalizeFilesItems(sessionMI) : readFilesItems();
            if (filesItems !== null && runFirstLoop) { // #269 — catalog preview is run-once
                // engine_scheme_catalog_summary is the scheme source: session-scoped, ordered,
                // one row per scheme that has entries (scheme=null → file). log:// is absent —
                // it lives in log_entries, not the catalog (present-mode, the # Log section).
                const catalogSchemes = await (this.#db.engine_scheme_catalog_summary as PrepMethod).all<{ scheme: string | null; entries: number }>({ session_id: sessionId });
                // known:/// + unknown:/// + file ALWAYS foist, even at zero entries — else the
                // model burns a turn running the FIND itself, assuming the catalog is merely
                // being withheld. An empty FIND(**) is orienting, not noise (owner): it tells
                // the model NOT to look there. Other schemes keep the with-entries default.
                const foistSchemes = [...catalogSchemes];
                for (const always of ["known", "unknown", null] as const) {
                    if (!foistSchemes.some((c) => c.scheme === always)) foistSchemes.push({ scheme: always, entries: 0 });
                }
                for (const { scheme, entries } of foistSchemes) {
                    const schemeName = scheme ?? "file";
                    // plurnk → its docs subtree (FIND(plurnk://docs/**), uncapped) — the self-
                    // documenting surface. The prompt is shown in # Prompt, so the plurnk catalog
                    // the model orients on IS the docs; doc links are no longer rendered inline (#270).
                    const isPlurnk = schemeName === "plurnk";
                    const isFile = schemeName === "file";
                    // Only the FILE list is cappable (PLURNK_SERVICE_FILES_ITEMS first-N): the tracked-file
                    // tree is external and arbitrarily large. Every other scheme — known/unknown
                    // (memory), run (scratch), plurnk (docs) — foists FULL, never truncated: a partial
                    // view of the model's own memory reads as withheld. file at -1, or any non-file
                    // scheme → no cap. (file in this loop always has entries>0, so no degenerate <1,0>.)
                    const cap = isFile && filesItems > 0 ? Math.min(filesItems, entries) : null;
                    // The file survey foists as the BARE relative glob — the path shape plurnk.md
                    // teaches (`src/**`, `**/notes.md`; bare = project-relative) — so the turn-0
                    // exemplar and the log rows the model reads never train a leading-slash or
                    // file:/// habit the rest of the teaching contradicts.
                    const catalogFind: FindStatement = {
                        op: "FIND", suffix: "", signal: null,
                        target: isFile ? { kind: "local", raw: "**" } : {
                            kind: "url",
                            raw: isPlurnk ? "plurnk://docs/**" : `${schemeName}:///**`,
                            scheme: schemeName,
                            username: null, password: null, hostname: null, port: null,
                            pathname: isPlurnk ? "/docs/**" : "/**",
                            params: {}, fragment: null,
                        },
                        body: null,
                        lineMarker: cap === null ? null : { marks: [1, cap] },
                        position: { line: 1, column: 1 },
                    };
                    await this.dispatch({
                        statement: catalogFind, sessionId, runId, loopId, turnId,
                        sequence: nextActionIndex, origin: "plurnk", onDispatch,
                    });
                    nextActionIndex++;
                    // §model-entry — the same FIND, rendered back to DSL for the turn-0 echo (the model's
                    // own survey, mirrored OPEN). The <L> cap rides as `<1,N>`, exactly as the model would type it.
                    turnZeroMoves.push(`<<FIND(${isPlurnk ? "plurnk://docs/**" : isFile ? "**" : `${schemeName}:///**`})${cap === null ? "" : `<1,${cap}>`}::FIND`);
                }
                // §run-scheme — Manifest(run) = session-scope ∪ THIS run's run-scope. Foist the
                // building run's OWN scratch (run://self/**, uncapped — a run needs the full view to
                // manage its private workspace) so it's catalogued in ITS perspective alone; other
                // runs reach it only via explicit FIND(run://<name>/**). A run with no scratch foists nothing.
                const selfRun = await (this.#db.run_name_by_id as PrepMethod).get<{ name: string }>({ run_id: runId });
                const scratch = selfRun === undefined ? 0 : (await (this.#db.engine_run_scratch_count as PrepMethod).get<{ entries: number }>({ session_id: sessionId, owner_prefix: `/${selfRun.name}/*` }))?.entries ?? 0;
                if (scratch > 0) {
                    const runFind: FindStatement = {
                        op: "FIND", suffix: "", signal: null,
                        target: { kind: "url", raw: "run://self/**", scheme: "run", username: null, password: null, hostname: "self", port: null, pathname: "/**", params: {}, fragment: null },
                        body: null, lineMarker: null, position: { line: 1, column: 1 },
                    };
                    await this.dispatch({ statement: runFind, sessionId, runId, loopId, turnId, sequence: nextActionIndex, origin: "plurnk", onDispatch });
                    nextActionIndex++;
                    turnZeroMoves.push("<<FIND(run://self/**)::FIND");  // §model-entry — the run-scope survey, into the turn-0 echo
                }
            }
            // #260 — foist a turn-0 READ of each client-passed @file path so its content sits in front
            // of the model. Daemon owns the workspace → a normal file:/// member READ; a missing or
            // non-member path surfaces its READ outcome (4xx) in the log, visible to the model.
            const openPathsRow = await (this.#db.engine_get_loop_open_paths as PrepMethod).get<{ open_paths: string }>({ loop_id: loopId });
            for (const raw of JSON.parse(openPathsRow?.open_paths ?? "[]") as string[]) {
                const pathname = raw.startsWith("/") ? raw : `/${raw}`;
                const fileRead: ReadStatement = {
                    op: "READ", suffix: "", signal: null, lineMarker: null,
                    target: {
                        kind: "url", raw: `file://${pathname}`, scheme: "file",
                        username: null, password: null, hostname: null, port: null,
                        pathname, params: {}, fragment: null,
                    },
                    body: null, position: { line: 1, column: 1 },
                };
                await this.dispatch({
                    statement: fileRead, sessionId, runId, loopId, turnId,
                    sequence: nextActionIndex, origin: "plurnk", onDispatch,
                });
                nextActionIndex++;
            }
            // §model-entry — mirror the model's turn-0 OPEN at sequence 1: PLAN → the FINDs actually
            // foisted above (real, their results already in the log) → SEND[102]. Dynamic — it reflects
            // the true survey, never a frozen print — and OPEN: the worked example the model orients on,
            // so the grammar can stay thin. Subsequent turns mirror the model's real output, folded.
            if (runFirstLoop) {
                const emission = ["<<PLAN:Initialize:PLAN", ...turnZeroMoves, "<<SEND[102]:Initialized:SEND"].join("\n");
                await this.#dispatcher.writeModelEntry({ verbatim: emission, runId, loopId, turnId, sequence: 1, folded: false, origin: "plurnk" });
            }
        }

        // §env-delta — pre-seed the run's ambient observations (what changed since
        // it last looked) as foisted rows before the packet composes; advance the action index
        // past them so model ops continue after. Two instances of one machine: env-delta (sibling
        // edits · timestamp cursor · always folded) and exec streams (channel bytes · byte cursor ·
        // terminal delta opens). §env-delta §exec-stream
        // §exec-poll — EXEC `<0>` is turn-scoped: reap the run's open turn-scoped streams (necessarily
        // from a prior turn — this runs before the turn's own spawns) so a `<0>` never survives into
        // the subsequent turn. The terminal output then surfaces born-OPEN via the stream-delta path.
        await this.#reapTurnScopedStreams(runId);
        nextActionIndex += await this.#materializeEnvironmentDeltas({ sessionId, runId, loopId, turnId, fromSequence: nextActionIndex });
        nextActionIndex += await this.#materializeStreamDeltas({ runId, loopId, turnId, fromSequence: nextActionIndex });

        // SPEC §telemetry — git working-tree state for the telemetry section, read once
        // (a service-side `git status` shell-out) and threaded into the budget
        // rebuild too so it isn't re-shelled on overflow.
        const gitStatus = await GitState.status(this.#db, sessionId, this.#loopAborts.get(loopId)?.signal);

        // Build the spec'd packet (Packet.json) request half. The log build
        // queries log_entries scoped to the run — the prompt entry just
        // written (if turn 1) is part of that query result.
        const tokenRatio = this.#tokenRatios.get(loopId) ?? 1;
        let requestPacket = await this.#packets.buildRequestPacket({
            initialMessages: messages, requirements, sessionId, runId, loopId,
            currentTurnSeq: seq, provider, gitStatus, tokenRatio,
        });
        // SPEC §grinder — budget grinder, pre-LLM: reclaim window on actual overflow.
        const enforced = await this.#packets.enforceBudget({
            packet: requestPacket, provider, runId, loopId, turnId, tokenRatio,
            // The overflow error row is minted at the turn's running sequence (nextActionIndex), pre-generate;
            // runTurn advances the counter past it below so the post-generate dispatch rows never collide.
            mintSequence: nextActionIndex,
            // No preset telemetry — the rebuild RE-DERIVES the errors section from log≥400 so the
            // overflow row just minted surfaces THIS turn (§grinder-overflow-error-row). Safe: the
            // ephemeral buffer is empty pre-generate (events drain on the next turn's build).
            rebuild: () => this.#packets.buildRequestPacket({
                initialMessages: messages, requirements, sessionId, runId, loopId,
                currentTurnSeq: seq, provider, gitStatus, tokenRatio,
            }),
        });
        if (enforced.struck) nextActionIndex += 1; // the budget-overflow error row consumed a sequence
        requestPacket = enforced.packet;
        if (!enforced.fit) {
            // Hard 413: won't fit even with only the manifest left. Skip the LLM,
            // close the turn, and let runLoop abandon (499).
            const hardPacket = this.#packets.completePacket(requestPacket, { content: "", ops: [], reasoning: null }, null, provider);
            await (this.#db.engine_close_turn as PrepMethod).run({
                id: turnId, status: 413, packet: JSON.stringify(hardPacket),
                usage_prompt: 0, usage_completion: 0, usage_reasoning: 0, usage_cached: 0, usage_cost_pico: 0,
                usage_context_size: this.#packets.promptBudgetFor(provider), // #274 — the PROMPT BUDGET (window − reserves), even on a hard-413 turn: the gauge denominator the packet actually lives under
                finish_reason: "budget_hard_stop", model: provider.model, meta: "{}",
            });
            return { turnId, status: 413, statuses: [], fingerprint: "", budgetStruck: enforced.struck, budgetHardStop: true, steerStruck: false };
        }
        const modelMessages = PacketWire.packetToWireMessages(requestPacket) as ChatMessage[];
        // No decode cap. Our budget governs the TRANSMISSION packet (the grinder folds
        // the input under the ceiling); the model's decode — reasoning + emission — is
        // out of band, owned by the provider's own context window. Deriving a maxTokens
        // from our budget conflated the two and guillotined a reasoning model's
        // out-of-band thinking as the packet filled (`ceiling - packet` → near-zero
        // decode → finish=length mid-reasoning → no emission → strike spiral). The
        // provider enforces its physical wall on its own.
        let response: ProviderResponse;
        // #249 — plugin attribution tags onto the per-turn generate() wire. Value is the
        // active-plugin set (placeholder); real per-turn grounding is deferred.
        const attributions = [...new Set([...this.#schemes.attributions(), ...(this.#executors?.attributions() ?? [])])].toSorted();
        // #249 — tag the loop (the activity) with its active plugins' attribution tags, write-once.
        if (attributions.length > 0) await (this.#db.engine_tag_loop_attributions as PrepMethod).run({ loop_id: loopId, attributions: JSON.stringify(attributions) });
        // #249 — session-stable frontend id, forwarded as Plurnk-Client by the plurnk provider only.
        const { client } = await SessionSettings.read(this.#db, sessionId);
        try {
            // §turn-lifecycle (#301) — the provider call is the long, opaque window (submit → first
            // committed op is provider latency + a full first-turn generation, ~70s local): a static
            // screen there is indistinguishable from a hang. Bracket generate() with two telemetry beats
            // so a client can show "awaiting model" the instant the turn starts and flip to "parsing" when
            // ops are about to land. Base telemetry/event channel (the embed_progress precedent, §tokenomics
            // clients already render it unconditionally); the abort guard keeps a cancelled loop silent.
            if (!signal?.aborted) this.#telemetry.push(sessionId, loopId, { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" });
            // generate rides the LOOP signal (already chained from the caller's), so a loop-level
            // abort — the §operator-config-loop-timeout wall — cancels a stuck provider call, not
            // just the schemes. Bare runTurn (no runLoop) has no loop entry → the caller's signal.
            response = await provider.generate({ messages: modelMessages, runId: String(runId), signal: this.#loopAborts.get(loopId)?.signal ?? signal, grammar: await this.#grammarConstraint(), maxTokens: this.#packets.decodeBudget(), strikes: this.#strikes.streak(loopId), attributions: attributions.length > 0 ? attributions : undefined, client: client ?? undefined }); // strikes: first-party routing signal, 0 sent explicitly (#313) // §provider-surface-generate §provider-guarantees-single-call §provider-guarantees-signal-wired §attribution-plurnk-namespace-reserved §client-telemetry
            if (!signal?.aborted) this.#telemetry.push(sessionId, loopId, { source: "engine:turn", kind: "turn_generated", level: "info", message: "parsing model response" });
        } catch (err) {
            // §turn-never-blank — a ProviderError is an INFRASTRUCTURE failure (auth, network
            // beyond retries, rate limit): no completed exchange exists, so no turn exists —
            // telemetry the cause and DIE legibly (the drain writes the loop terminal 500 with
            // the message). Grammar conformance never arrives here: providers 0.32 retired the
            // constrained-path throw — a completed exchange ALWAYS returns, bytes in assistant,
            // the conformance verdict riding response.telemetry as an OBSERVATION (the engine's
            // ANTLR parse is the judge; the provider transports and observes, never adjudicates).
            // The old fallback fabricated an empty emission here and laundered a provider
            // adjudication into a model-behavior 422 — a state the system otherwise forbids,
            // a record that lied, and days of forensics pointed at the wrong suspect.
            if (err instanceof ProviderError) {
                this.#telemetry.push(sessionId, loopId, { source: "provider", kind: err.kind, message: err.message, level: "error" });
            }
            throw err;
        }

        // Engine splits wire-level response: emission (content, reasoning,
        // parsed ops) → packet.assistant per Packet.json assistant section;
        // call-metadata (usage, finishReason, model) → Turn columns per
        // Turn.json. Mixing the two on packet.assistant was the wrong layer.
        const { packetAssistant, callMetadata, parseErrors } = this.#splitResponse(response); // raw assistant content is opaque — split, never interpreted — §provider-guarantees-assistantraw-opaque
        // §tokenomics-ceiling-calibrates-to-usage — learn the loop's real/measured ratio from the
        // provider's OWN prompt count (ground truth for the whole wire request, template overhead
        // included). Monotone max within the loop. An EXACT ruler floors at 1 (never expands);
        // a certified upper-bound ruler calibrates to observed truth in BOTH directions — the
        // worst-observed packing wins, and expansion toward ground truth cannot overshoot the
        // window (owner-ruled; run24: the unconditional floor halved gbuild's effective budget).
        if (callMetadata.usage.prompt > 0 && requestPacket.tokens > 0) {
            const observed = callMetadata.usage.prompt / requestPacket.tokens;
            const prior = this.#tokenRatios.get(loopId) ?? (gauge.exact ? 1 : observed);
            if (observed >= prior) this.#tokenRatios.set(loopId, observed);
        }
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
        // Parse errors are LOG ITEMS now (§telemetry — one budget surface): each failed-to-parse
        // emission records an actionless `error` row below, after the turn's dispatched ops are
        // sequenced (see the parse-error log write past the dispatch loop). The errors section
        // derives a pointer to it from log≥400, uniform with action_failure.
        // providers#24 / #275: non-fatal provider telemetry on a SUCCESSFUL turn. In GBNF-filter
        // mode the provider no longer THROWS grammar_unenforced — it returns the model's bytes
        // (here, packetAssistant.content) and attaches the conflict as a telemetry event carrying
        // the divergence code-point position. Forward each event with a content-offset `line:col`;
        // the model resolves it against its own emission — READ the folded `model` mirror row at the
        // cited lines (§model-entry) — not an embedded snippet that would duplicate the emission.
        for (const event of response.telemetry ?? []) {
            const located = typeof event.position === "number"
                ? this.#offsetToLineColumn(packetAssistant.content, event.position)
                : null;
            this.#telemetry.push(sessionId, loopId, {
                source: event.source,
                kind: event.kind,
                message: event.message ?? "",
                level: (event as { level?: TelemetryEvent["level"] }).level ?? "warn", // forward the producer's severity; default for a producer predating the field
                ...(located !== null
                    ? { position: { type: "content-offset", line: located.line, column: located.column } }
                    : {}),
            });
        }
        const opsCount = packetAssistant.ops.length;
        // PLAN (reasoning) and informational SEND[103] are no-ops, not actions: both are
        // excluded from the real-op count so a PLAN-only or prose-only turn still strikes
        // as no-ops, and the terminal scan ignores 1xx so they never set turnStatus.
        const realOpsCount = packetAssistant.ops.filter(
            (op) => op.op !== "PLAN" && !(op.op === "SEND" && op.signal === 103 && op.target === null),
        ).length;
        const sendOp = packetAssistant.ops.findLast(
            (op): op is PlurnkStatement & { op: "SEND"; signal: number } =>
                op.op === "SEND" && typeof op.signal === "number" && op.signal >= 200,
        );
        // §send the terminal contract — two engine error states verify a terminal claim against run
        // state, never trusting the model's code. Both strike via turn.steerStruck (turnErrors,
        // §grinder-strike-coupling): the loop continues, the model sees the steering hint not the strike
        // count, and a non-resolver spins out to the engine's 500.
        let steerStruck = false;
        // Engine errors raised this turn, minted as op='error' log rows after dispatch (they share the
        // post-dispatch sequence counter). §telemetry-uniform-error-channel
        const pendingEngineErrors: EngineErrorKind[] = [];

        // Terminal adjudication moved to the DISPATCHER (§send-premature-terminate, the unified
        // pending set): the terminal SEND is judged AT ITS OWN DISPATCH — after the emission's
        // earlier ops executed — so a same-turn KILL+[200] repairs in one turn and a same-turn
        // WORK+[200] is caught. A refused terminal (409) strikes via the dispatch-loop check below.

        // Rail #41 (revised): the per-turn requirement is "emit at least one op," not "emit a terminal
        // SEND." SEND is purely a signal verb; many turns pass without one. An empty op list strikes.
        // Provisional here — a terminal REFUSED at dispatch (the pending-set 409, only knowable
        // post-dispatch) demotes the turn back to a continue below: the SEND's signal stays on the
        // row (the un-erased record), but the loop never went terminal, so the turn didn't either.
        let turnStatus = sendOp !== undefined
            ? sendOp.signal
            : realOpsCount === 0 ? TURN_STATUS_NO_OPS : TURN_STATUS_IMPLICIT_CONTINUE;

        // Idle turn: an implicit-continue (102) that did no WORK — its ops are only PLAN/SEND, no mid op.
        // The model continued with nothing to do. (Skipped when premature already steered this turn.)
        const midOpsCount = packetAssistant.ops.filter((op) => op.op !== "PLAN" && op.op !== "SEND").length;
        if (!steerStruck && turnStatus === TURN_STATUS_IMPLICIT_CONTINUE && midOpsCount === 0) {
            steerStruck = true;
            pendingEngineErrors.push("idle_turn");
        }

        // Close the turn with the final packet, status, and usage stats.
        const packet = this.#packets.completePacket(requestPacket, packetAssistant, response.assistantRaw, provider);
        const { usage, finishReason, model } = callMetadata;
        await (this.#db.engine_close_turn as PrepMethod).run({
            id: turnId,
            status: turnStatus,
            packet: JSON.stringify(packet),
            usage_prompt: usage.prompt,
            usage_completion: usage.completion,
            usage_reasoning: usage.reasoning,
            usage_cached: usage.cached,
            usage_cost_pico: provider.costFor(usage), // §provider-surface-costfor
            usage_context_size: this.#packets.promptBudgetFor(provider), // #274 — the PROMPT BUDGET (window − reserves): the raw n_ctx overstated usable room by the reserve total
            finish_reason: finishReason,
            model,
            // #252 — opaque provider→client metadata passthrough (e.g. balancePico the
            // provider normalized). Stored verbatim, unenforced; the service never reads a field.
            meta: JSON.stringify(response.meta ?? {}),
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
        // #232 — a session's maxCommands is a tighten-only ceiling: min() the env ceiling.
        const maxCommands = Math.min(readMaxCommands(), (await SessionSettings.read(this.#db, sessionId)).maxCommands ?? Number.POSITIVE_INFINITY);
        // PLAN (reasoning) and a terminal SEND (signal ≥ 200, the conclusion) are not
        // actions — they always dispatch and never count against the cap. maxCommands
        // bounds real actions only; maxCommands:0 still admits a plan and a conclusion
        // (the PLAN/SEND ops, zero actions), which is its only coherent meaning.
        let realCommands = 0;
        const opsToDispatch = packetAssistant.ops.filter(
            (op) =>
                op.op === "PLAN"
                || (op.op === "SEND" && typeof op.signal === "number" && op.signal >= 200)
                || realCommands++ < maxCommands,
        );
        const droppedCount = opsCount - opsToDispatch.length;
        const statuses: number[] = [];
        // Running counter — a multi-file READ writes N rows from one statement (rowsWritten),
        // so the next op's sequence picks up after them. Collapses to nextActionIndex+i when
        // every op writes one row (the common case).
        let rowSeq = nextActionIndex;
        for (const statement of opsToDispatch) {
            const result = await this.dispatch({
                statement, sessionId, runId, loopId, turnId,
                sequence: rowSeq,
                origin, onDispatch, gauge,
            });
            statuses.push(result.status);
            // A refused terminal (the pending-set 409) demotes the turn to a continue: the loop
            // never went terminal, so the turn didn't either (the close persisted the provisional
            // status BEFORE dispatch — run20's T3 stored 200 with a 409-refused SEND). Whether it
            // ALSO strikes is kind-specific (owner ruling): a retrievals-only refusal teaches
            // without striking — atomic-turn-pretrained models pair fetch-and-answer by habit,
            // the refusal is correct each time, and maxTurns bounds the walk; striking executed
            // converging behavior (jumbo/admins specimens: 3 correct refusals → 500 mid-adapt).
            // Streams/children refusals keep the strike — discarding live work stays serious.
            if (statement === sendOp && result.status === 409) {
                if ((result.attrs as { retrievalOnly?: boolean } | undefined)?.retrievalOnly !== true) steerStruck = true;
                turnStatus = TURN_STATUS_IMPLICIT_CONTINUE;
                await (this.#db.engine_demote_turn_status as PrepMethod).run({ id: turnId, status: turnStatus });
            }
            rowSeq += (result.rowsWritten as number | undefined) ?? 1;
        }
        // §telemetry-uniform-error-channel — every engine + parse failure mints as an op='error'
        // log row at the turn's next free sequence (after every dispatched row, incl. a multi-file
        // READ's fan-out). One channel: the errors section derives a LogCoordinate pointer from log≥400.
        let errSeq = rowSeq;
        // max_commands_exceeded IS model-facing: dropped ops the model emitted that didn't run.
        if (droppedCount > 0) pendingEngineErrors.push("max_commands_exceeded");
        for (const kind of pendingEngineErrors) await this.#telemetry.mintEngineError(kind, { runId, loopId, turnId, sequence: errSeq++ });
        // Parse errors carry the parser message + a content-offset line:col (a ContentOffset position),
        // resolved against the model's folded mirror row (§model-entry) — origin 'model', not engine.
        for (const { message, line, column, source } of parseErrors ?? []) {
            await (this.#db.engine_insert_log_entry as PrepMethod).get({
                run_id: runId, loop_id: loopId, turn_id: turnId, sequence: errSeq++,
                origin: "model", source: "grammar", op: "error", suffix: "", signal: null,
                scheme: null, username: null, password: null, hostname: null, port: null,
                pathname: null, params: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/plain",
                // The error carries the parser message + a content-offset `line:col`; the model READs
                // its own folded mirror row (§model-entry) at the cited lines, so no snippet is
                // embedded. The derived errors-section pointer stays minimal (status + coordinate).
                rx: JSON.stringify({ message, position: { type: "content-offset", line, column }, parserSource: source }),
                mimetype_rx: "application/json",
                status_rx: 400, tokens: 0, state: "resolved", outcome: null, attrs: "{}",
            });
        }

        // §model-entry — mirror this turn's verbatim emission back as a `model` row, so the NEXT
        // packet shows the model exactly what it last produced. ALWAYS born FOLDED — the old
        // born-OPEN-on-error auto-trigger was conditional helpfulness that bred its own hazards
        // (a 24k-char ramble mirrored open re-injects itself into the next packet: cost,
        // contamination, pressure feedback). An error's line:col resolves the same way anything
        // else does: the model that cares READs the folded row at the lines it wants — and can
        // introspect any prior emission of its own the same way. Empty emissions (a struck/
        // silent turn) write nothing — no prior output to mirror.
        if (packetAssistant.content.trim().length > 0) {
            await this.#dispatcher.writeModelEntry({ verbatim: packetAssistant.content, runId, loopId, turnId, sequence: errSeq++, folded: true });
        }

        // Zero ops is NOT an error to report — the model knows it emitted
        // nothing. Strike accounting (engine-internal) treats it as a
        // struck turn; the model just sees an empty packet next turn.
        // Per SPEC §telemetry gamification policy.

        return { turnId, status: turnStatus, statuses, fingerprint: StrikeRail.fingerprintTurn(packetAssistant.ops), budgetStruck: enforced.struck, budgetHardStop: false, steerStruck };
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
        // PLAN is an ordinary op — emitted by the model, dispatched, and passed to the
        // client as a log entry. No special hoisting into the reasoning field (that
        // legacy paradigm is abandoned). Interstitial free text is DROPPED — the prior
        // #free-text-capture synthesis of SEND[103] log ops was retired as tech debt
        // (grammar 0.70 forbids free text between ops, so a prose-only turn strikes 422).
        // Full PlurnkParseError context (line/column/source) is preserved
        // here so runTurn can build TelemetryEvent envelopes per the
        // grammar 0.17.0 protocol — model needs position info to locate
        // its own offending content on the next turn.
        const parseErrors: ParseErrorInfo[] = [];
        if (preParsedOps !== undefined) {
            ops.push(...preParsedOps);
        } else {
            const parsed = PlurnkParser.parse(assistant.content);
            for (const item of parsed.items) {
                if (item.kind === "statement") {
                    ops.push(item.statement);
                }
                // Free text (kind "text") is dropped — #free-text-capture retired (above).
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
        const reasoning = assistant.reasoning ?? null;
        return {
            packetAssistant: { content: assistant.content, ops, reasoning },
            callMetadata: { usage: assistant.usage, finishReason: assistant.finishReason, model: assistant.model },
            parseErrors,
        };
    }

    // #note12 — the daughter-provided reference docs (schemes' + execs' `documentation`),
    // materialized at plurnk:///docs/<name>.md by loop_run (like operator docs).
    docEntries(sessionId: number): Promise<Array<{ name: string; content: string }>> {
        return this.#packets.docEntries(sessionId);
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
        // §run-scheme — loop-terminations: a sibling's loop reaching terminal surfaces the
        // same way an entry-change does, carrying its deliverable (the SEND body) or the
        // abandonment reason. Folded, attributed to the terminated run.
        const terms = await (this.#db.engine_pull_loop_terminations as PrepMethod).all<{
            run_id: number; run_name: string; status: number; prompt: string; terminal_message: string | null;
        }>({ session_id: sessionId, run_id: runId, since });
        for (const t of terms) {
            await (this.#db.engine_insert_loop_termination_delta as PrepMethod).run({
                run_id: runId, loop_id: loopId, turn_id: turnId, sequence: fromSequence + written,
                source: String(t.run_id), pathname: `/${t.run_name}`,
                rx: t.terminal_message ?? `loop "${t.prompt}" ended (${t.status})`,
                status: t.status,
            });
            written++;
        }
        return written;
    }

    // §exec-poll — EXEC `<0>` is turn-scoped: abort the run's open turn-scoped streams via their
    // owning scheme (the same registry-routed abort the total reap uses). Called at each pre-turn
    // before the turn's own spawns, so every open turn-scoped sub here is from a prior turn — it
    // never survives into the subsequent turn. Fire-and-forget: the spawn finalizes async and its
    // terminal output surfaces born-OPEN through the stream-delta path (§exec-stream).
    async #reapTurnScopedStreams(runId: number): Promise<void> {
        const open = await (this.#db.find_open_turn_scoped_subscriptions_for_run as PrepMethod).all<{ id: number; scheme: string }>({ run_id: runId });
        for (const { id, scheme } of open) {
            const handler = this.#schemes.get(scheme) as { abortSubscription?: (subscriptionId: number) => void } | undefined;
            handler?.abortSubscription?.(id);
        }
    }

    // §env-delta — exec streams as an instance of the ambient-observe machine:
    // each turn, emit each owned channel's unshown byte-delta as a foisted READ@200 row. Folded
    // while the channel streams; the terminal delta (channel closed) auto-OPENs. The cursor is the
    // streamEnd recorded on the channel's prior delta — no exec-specific surfacing, just the
    // env-observe loop with a byte cursor where env-delta uses a timestamp. §exec-stream
    async #materializeStreamDeltas(args: {
        runId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number> {
        const { runId, loopId, turnId, fromSequence } = args;
        const channels = await (this.#db.engine_run_stream_channels as PrepMethod).all<{
            subscription_id: number; runtime: string; coord: string; channel: string; content: string; state: string;
        }>({ run_id: runId });
        let written = 0;
        for (const ch of channels) {
            const prior = await (this.#db.engine_stream_cursor as PrepMethod).get<{ attrs: string }>({
                run_id: runId, scheme: ch.runtime, pathname: ch.coord, fragment: ch.channel,
            });
            const cursor = prior !== undefined ? ((JSON.parse(prior.attrs) as { streamEnd?: number }).streamEnd ?? 0) : 0;
            if (ch.content.length <= cursor) continue;  // nothing new to show this turn
            const closed = ch.state === "closed" || ch.state === "errored";
            // startLine continues the line count across turns: a multi-turn stream's deltas number
            // into one sequence (lines N..M, then M+1..), not N independent "1:" restarts. §exec-stream
            const startLine = (ch.content.slice(0, cursor).match(/\n/g)?.length ?? 0) + 1;
            await (this.#db.engine_insert_stream_delta as PrepMethod).run({
                run_id: runId, loop_id: loopId, turn_id: turnId, sequence: fromSequence + written,
                scheme: ch.runtime, pathname: ch.coord, fragment: ch.channel,
                rx: JSON.stringify({ status: 200, content: ch.content.slice(cursor), mimetype: "text/stream", startLine }),
                attrs: JSON.stringify({ streamEnd: ch.content.length }),
                expanded: closed ? 1 : 0,  // §exec-stream — terminal delta auto-OPENs; ongoing folds
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
        return this.#dispatcher.dispatch(context);
    }

    // op.look (#283) — resolve a READ and return its content WITHOUT writing a
    // log_entries row: the client's off-run inspection primitive. {§op-look}
    async look(context: {
        statement: PlurnkStatement;
        sessionId: number; runId: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        return this.#dispatcher.look(context);
    }

    // External API to feed a resolution into a pending proposal — the loop/resolve
    // RPC handler, the in-tree YOLO listener, or the timeout watcher.
    resolveProposal(logEntryId: number, resolution: ProposalResolution): void {
        this.#proposals.resolve(logEntryId, resolution);
    }

    // Snapshot of pending proposals (for diagnostic / RPC listings).
    pendingProposalIds(): number[] {
        return this.#proposals.pendingIds();
    }

    // Subscribe to proposal-pending events. Daemon registers a listener
    // that broadcasts the loop/proposal WS notification; YOLO listener
    // registers one that auto-resolves.
    onProposalPending(listener: (event: ProposalPendingEvent) => void): void {
        this.#proposals.onPending(listener);
    }

    // Used by wake-on-completion (daemon side): "is there any loop in this
    // run still accepting turns?" If yes, skip the wake — the active loop
    // will pick up the channel transition at its next turn boundary. If no,
    // the daemon opens a fresh loop with the wake prompt.
    async hasActiveLoopForRun(runId: number): Promise<boolean> {
        const row = await (this.#db.engine_count_active_loops_for_run as PrepMethod).get<{ n: number }>({ run_id: runId });
        return (row?.n ?? 0) > 0;
    }

    // #290 — run the derivation pump (deep channels: symbols/refs/FTS +
    // embeddings, deep_hash-gated) at SESSION-SCOPE, off the per-turn path, so a freshly-created
    // session's corpus warms DURING the client's startup window instead of freezing the first
    // loop.run. session.create fires this and returns immediately; embed_progress live-fans-out as it
    // runs. Idempotent + deep_hash-gated, so turn 1's pump finds the work done (or harmlessly re-runs);
    // a no-embedder build derives the cheap symbols/refs/FTS channels and skips the embed pass. Has no
    // loop yet — telemetry fans out live only (loopId 0), never buffered to a loop that never drains.
    async warmSessionDerivations(sessionId: number): Promise<void> {
        const ctx: PlurnkSchemeContext = {
            db: this.#db, sessionId, runId: 0, loopId: 0, turnId: 0,
            writer: "plurnk",
            signal: undefined,
            streamEventNotify: this.#streamEventNotify,
            wakeRunNotify: this.#wakeRunNotify,
            tokenize: this.#tokenize,
            mimetypes: this.#mimetypes,
            defaultChannelFor: (s) => this.#schemes.defaultChannelFor(s),
            pushTelemetry: (event) => this.#telemetry.notify(sessionId, 0, event),
        };
        await this.#queueDerivation(() => EntryManifest.maintainDerivations(ctx)); // §derivation-off-hot-path
    }

    // Inject a prompt into the run's currently-executing loop. Writes a
    // plurnk:///prompt/<loop_id>/<next-turn> entry whose body becomes the
    // prompt section at the next turn boundary. Last-wins: if two
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
        const pathname = `/prompt/${loopId}/${turnSeq}`; // canonical storage form (leading slash), matching the turn-1 foist
        const ctx: PlurnkSchemeContext = {
            db: this.#db, sessionId: sessionRow.session_id, runId, loopId,
            turnId: 0,                   // no turn open at inject time; entries don't pin turnId
            writer: "plurnk",
            signal: this.#loopAborts.get(loopId)?.signal,
            streamEventNotify: this.#streamEventNotify,
            wakeRunNotify: this.#wakeRunNotify,
            tokenize: this.#tokenize,
            pushTelemetry: (event) => this.#telemetry.push(sessionRow.session_id, loopId, event),
        };
        const entry: EntryData = {
            channels: { body: { content: prompt, mimetype: "text/markdown" } },
            tags: [],
        };
        await EntryCrud.writeEntry(pathname, entry, ctx, "plurnk");
        return { loopId, turnSeq };
    }

    //  — can this op open a wake edge mid-turn? The grounding scan for a
    // same-turn spawn-then-hibernate: an EXEC (stream conclusion / poll cadence wakes), a COPY to
    // run:// (child-conclusion wake, §run-lifecycle-child-wake), a directed SEND to run:// (irc — the
    // addressee can act and conclude back), or an http READ (a web fetch streams into a subscription).
    // Conservative on purpose: a false PERMIT risks a dead park only in the spawn-failed corner; a
    // false REFUSE breaks legitimate hibernation.

    // A run "holds a live thing" iff it has an open stream/spawn (subscription registry or an
    // exec spawn) OR a non-terminal child run — the structured-concurrency invariant a terminal
    // SEND must respect (§send-premature-terminate,  §run-lifecycle:
    // children and streams are the same kind of live thing a run holds).
}
