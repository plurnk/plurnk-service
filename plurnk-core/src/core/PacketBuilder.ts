import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type TelemetryChannel from "./TelemetryChannel.ts";
import type { GitStatus } from "./git-state.ts";
import { renderAddress, promptLoopPrefix } from "./plurnk-uri.ts";
import { rulerCount } from "./token-ruler.ts";
import { docsExcludeSet } from "./teaching.ts";
import { Policy } from "@plurnk/plurnk-execs";
import WorkspaceSettings from "./workspace-settings.ts";
import { DEFAULT_LOOP_FLAGS } from "./scheme-types.ts";
import type { LoopFlags } from "./types.ts";
import { readPacketInject, readSystemPolicy, readProjectPolicy } from "./packet-inject.ts";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import Paths from "../Paths.ts";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire, { type PacketSection } from "./packet-wire.ts";

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { Provider } from "@plurnk/plurnk-providers";
import { scopeEnvToAlias, resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";

// Substituted into the budget readout after the assembled packet is measured
// (the figure depends on the packet's own rendered size — chicken/egg).
const TOKENS_FREE_PLACEHOLDER = "{{tokensFree}}";
const TOKEN_USAGE_PLACEHOLDER = "{{tokenUsage}}";
const TOKEN_PERCENT_PLACEHOLDER = "{{tokenPercent}}";
const SYSTEM_CTX_PLACEHOLDER = "{{systemCtx}}"; // #440 — treemap's non-turn overhead = total − Σturns, known only post-assembly

// §tokenomics-window-partition — the four partition numbers. REQUIRED (fail-hard, the
// providers-env convention): the ceiling is DERIVED from these, never set directly
// (PLURNK_BUDGET_CEILING is retired — a settable ceiling let policy contradict physics).
const readPartitionIntFrom = (env: NodeJS.ProcessEnv, name: string, min: number): number => {
    const raw = env[name];
    const n = Number.parseInt(raw ?? "", 10);
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be an integer >= ${min}; got ${raw}`);
    return n;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// packet.assistant shape per plurnk-grammar 0.6.0 Packet.json. Wire-level
// call-metadata (usage, finishReason, model) is NOT here — those are
// properties of the call and live on the Turn row, alongside Turn.usage.
export type PacketAssistant = {
    content: string;
    ops: PlurnkStatement[];
    reasoning: string | null;
};

// The request half of the packet — an ordered list of sections — sans the
// assistant + assistantRaw fields, which aren't known until the provider
// responds. Engine builds this before the call (so the wire projection has a
// source) and completes it with the response after. Two consumers: serialized
// to ChatMessage[] via PacketWire.packetToWireMessages, and stored in
// turns.packet (via completePacket) as the canonical record of the exchange.
export type RequestPacket = {
    tokens: number;
    sections: PacketSection[];
    // The turn's structured telemetry events (parse errors, budget_overflow,
    // strikes, …) — the engine's alert record, ALSO stored on the completed
    // packet (packet.telemetryErrors). The buffer is ephemeral (drains on read),
    // so the packet is their only persistent home; the `errors` SECTION is their
    // rendered, model-facing view. The grinder threads them through its rebuild
    // so a destructive re-drain can't swallow them.
    telemetryErrors: object[];
};

// Packet assembly (SPEC §packet-assembly) + the budget grinder (§grinder):
// builds the spec'd request packet, measures it, and reclaims window on overflow.
export default class PacketBuilder {

    #db: Db;
    #schemes: SchemeRegistry;
    #telemetry: TelemetryChannel;
    // Boot-discovered runtime executors, late-injected on Engine after daemon
    // start() — read through a thunk so the post-construction set is visible.
    #executors: () => ExecutorRegistry | undefined;
    // §tokenomics-window-partition — the partition is PER-ALIAS (#352), resolved per provider in
    // #partitionFor and cached by alias; no boot-time global read.

    constructor({ db, schemes, telemetry, executors }: {
        db: Db;
        schemes: SchemeRegistry;
        telemetry: TelemetryChannel;
        executors: () => ExecutorRegistry | undefined;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#telemetry = telemetry;
        this.#executors = executors;
        // #507 — the envelope rides the provider; construction only runs the retired-knob shed
        // so a stale operator .env fails at BOOT, not first use.
        this.#safetyFor(resolveActiveAlias(process.env)?.alias ?? "");
    }

    // #352 — the generation envelope is PER-ALIAS: gemma keeps its measured llama-server policy
    // envelope (n_predict honored to the context wall — the cap MUST bound it, providers#10);
    // cloud aliases get a generous default and the backend self-clamps to its true output limit.
    // scopeEnvToAlias resolves PLURNK_SERVICE_*_<alias> over the bare fallback with providers' own
    // battle-tested suffix parser. Cached per alias; the boot-global case falls back to the active
    // alias when a provider carries no side-table entry (a test Mock).
    // #507 (owner-ruled full migration): the generation envelope is PROVIDER-owned — the window
    // and both reserves ride the Provider surface (contextWindow/reasoningReserve/completionReserve,
    // ingested or PLURNK_PROVIDERS_*-pinned in the provider tier). Core keeps ONE knob: SAFETY,
    // the ruler's own packing margin — a service fact, not a model fact.
    static #KNOBS = ["PLURNK_SERVICE_SAFETY"] as const;
    #shedChecked = false;

    #safetyFor(alias: string): number {
        // #507 hard shed (the #472 pattern): the three misprefixed partition knobs moved to the
        // provider tier; a stale operator .env must never silently lose its envelope to the move.
        if (!this.#shedChecked) {
            this.#shedChecked = true;
            const MOVED: Record<string, string> = {
                CTX: "PLURNK_PROVIDERS_CONTEXT_WINDOW", CONTEXT_WINDOW: "PLURNK_PROVIDERS_CONTEXT_WINDOW",
                REASONING: "PLURNK_PROVIDERS_REASONING_RESERVE",
                ASSISTANT: "PLURNK_PROVIDERS_COMPLETION_RESERVE", COMPLETION: "PLURNK_PROVIDERS_COMPLETION_RESERVE",
            };
            for (const k of Object.keys(process.env)) {
                const m = /^PLURNK_SERVICE_(CTX|CONTEXT_WINDOW|REASONING|ASSISTANT|COMPLETION)(_.*)?$/.exec(k);
                if (m !== null) throw new Error(`${k} is retired (#507): the envelope is provider-owned — the knob is ${MOVED[m[1]]}${m[2] ?? ""}.`);
            }
        }
        const view = scopeEnvToAlias(process.env, alias, PacketBuilder.#KNOBS);
        return readPartitionIntFrom(view, "PLURNK_SERVICE_SAFETY", 0);
    }

    // #421 — §tokenomics-window-unpollable-deliberate: provider.contextWindow null (env/probe/catalog
    // all missed, provider-tier pins included) is genuinely-unknown — nobody chose an envelope. The
    // budget/ceiling short-circuit to NO-CAP rather than substitute a stand-in the operator never chose.
    #isUnboundedWindow(provider: Provider): boolean {
        return provider.contextWindow === null;
    }

    #partitionFor(provider: Provider): { reasoning: number | null; completion: number | null; safety: number } {
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(process.env)?.alias ?? "";
        return { reasoning: provider.reasoningReserve ?? null, completion: provider.completionReserve ?? null, safety: this.#safetyFor(alias) };
    }

    // #528 — the operator's CONTEXT_WINDOW pin is the LOG-budget cap, core-composed: the provider
    // reports its natural window (construction strips the pin), and the cap tightens only the
    // prompt — never the reserves, which stay task-natural. Alias-scoped else bare; garbage fails hard.
    #capFor(provider: Provider): number | null {
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(process.env)?.alias ?? "";
        const raw = scopeEnvToAlias(process.env, alias).PLURNK_PROVIDERS_CONTEXT_WINDOW;
        if (raw === undefined || raw.length === 0) return null;
        const cap = Number.parseInt(raw, 10);
        if (!Number.isInteger(cap) || cap <= 0) throw new Error(`PLURNK_PROVIDERS_CONTEXT_WINDOW must be a positive integer, got '${raw}'`);
        return cap;
    }

    // The generation envelope — REASONING + COMPLETION, one undifferentiated pool, passed on
    // every generate({maxTokens}): no decode is unbounded (§tokenomics-window-partition). Per
    // alias (#352): gemma's measured envelope; a cloud alias's generous default the backend clamps.
    maxTokensFor(provider: Provider): number | null {
        const { reasoning, completion } = this.#partitionFor(provider);
        if (reasoning === null || completion === null) return null; // #421 — unknown envelope, no cap; the backend clamps
        return reasoning + completion;
    }

    // §tokenomics-window-partition — the prompt ceiling
    // is DERIVED, never set: effectiveWindow = min(CONTEXT_WINDOW, provider window; CONTEXT_WINDOW alone when the
    // provider reports none) minus the reserves, divided by the loop's observed real/measured
    // token ratio (usage.prompt is ground truth; a heuristic ruler shipped a 65k-real packet into
    // a 49k window, #311). A fractional ceiling also budgeted the prompt against the window and
    // FORGOT the response lives there too. Reserves exceeding the window is a configuration
    // contradiction — fail hard. ratio floors at 1: an overcounting ruler never expands the budget.
    // #274/#312 follow-up (owner): the CLIENT-facing gauge denominator — the prompt budget the
    // packet actually lives under (effective window minus the partition reserves), in REAL token
    // space (usage.prompt, the numerator, is real; the calibration ratio maps measured→real and
    // has no business here). The raw n_ctx overstates usable room by the reserve total.
    promptBudgetFor(provider: Provider): number | null {
        return this.ceilingFor(provider); // ONE derivation (#528) — the gauge denominator IS the grinder ceiling
    }

    // §tokenomics-agnostic-ruler — the ceiling is the real window partition (window − reserves),
    // NO calibration ratio: the model-facing measure is the chars/2 ruler (an over-count for
    // typical text), so comparing ruler-weight to the real-token ceiling is itself the conservative
    // bias — the model curates against less room than it has and never overflows for typical
    // content; the exact provider count guards the pathological tail at the materialization gate.
    ceilingFor(provider: Provider): number | null {
        if (this.#isUnboundedWindow(provider) || provider.contextWindow === null) return null; // #421 — no cap: the gauge headline is omitted
        const { reasoning, completion, safety } = this.#partitionFor(provider);
        if (reasoning === null || completion === null) return null; // #421 — unknown reserves, no ceiling
        const naturalBudget = provider.contextWindow - reasoning - completion - safety;
        if (naturalBudget <= 0) {
            const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(process.env)?.alias ?? "";
            // #507 — post-migration this contradiction has ONE cause: pinned absolute reserves
            // exceeding the window the provider detected (percent reserves derive and cannot contradict).
            throw new Error(`window partition contradiction for alias '${alias}': window ${provider.contextWindow} <= reserves ${reasoning}+${completion}+${safety}. Pinned PLURNK_PROVIDERS_{REASONING,COMPLETION}_RESERVE absolutes exceed the detected window — repin them under it, or use percent reserves, which derive from the window.`);
        }
        // #528 — the operator's cap tightens the PROMPT alone (reserves above are off the natural
        // window). A cap tighter than the reserves is deliberate tightening, not a contradiction —
        // the budget floors at 1 (0 and 1 force the same every-packet-413; the usage record needs
        // a positive denominator). ONE derivation: the grinder ceiling IS the gauge denominator.
        const cap = this.#capFor(provider);
        if (cap === null) return naturalBudget;
        return Math.max(1, Math.min(cap, provider.contextWindow) - reasoning - completion - safety);
    }

    // Assemble the request half of the spec'd packet (Packet.json system
    // and §user) BEFORE the provider call. The same packet object is then
    // completed with assistant + assistantRaw after the model responds, so
    // the stored packet and the wire payload share one source of truth.
    async buildRequestPacket({
        initialMessages, requirements, workspaceId, workerId, loopId, currentTurnSeq, provider, gitStatus, telemetryErrors: presetTelemetry,
    }: {
        initialMessages: ChatMessage[];
        // Optional requirements override. Empty in practice — callers don't thread it;
        // the engine sources Paths.defaultRequirements itself (a non-empty value wins).
        requirements: string;
        gitStatus: GitStatus | null;
        workspaceId: number; workerId: number; loopId: number;
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
        // plurnk.md (grammar/dialects) ONLY — the definition is the hot-path grammar.
        // The scheme catalogue is its own `schemes` section below tools (§schemes-directory),
        // NOT appended here: grammar 0.49+ is scheme-agnostic, so the service advertises
        // the scheme set at packet-time (grammar#239 item 7) via SchemeRegistry.teach().
        const system_definition = byRole("system");
        // the prompt section sources from the loop's most recent prompt entry first
        // (plurnk://prompt/<run>/<loop>/<N> for the highest N written to date).
        // This is what inject + the turn-1 foist write into. Falls back to
        // the runLoop caller's messages.user for tests that bypass the
        // foist mechanism entirely.
        const loopSeqRow = await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId });
        const promptRows = (await this.#db.drain_get_all_prompt_bodies_for_loop.all<{ content: string; pathname: string }>({ owner_id: workerId, pattern: `${promptLoopPrefix(loopSeqRow?.sequence ?? loopId)}%` }))
            .filter((r) => typeof r.content === "string" && r.content.length > 0);
        // §prompt-auto-read (owner): the section is a PATHS list (the errors shape — no bodies);
        // each prompt's content reaches the model through its foisted auto-READ in the log, and
        // prior prompts stay READable by the listed address — never silently lost, never an
        // unfair curation imposition. Fallback: callers that bypass the foist (bare messages)
        // still get their user text rendered directly.
        const prompt = promptRows.length > 0
            ? promptRows.map((r) => `* prompt://${r.pathname}`).join("\n")
            : byRole("user");
        // Requirements is engine-sourced, NOT threaded from callers — that threading is
        // exactly how it went missing (callers read the sysprompt but never the
        // requirements). Read Paths.defaultRequirements (PLURNK_SERVICE_REQUIREMENTS env →
        // requirements.md) fresh each build so edits take effect; a non-empty param wins.
        const baseRequirements = requirements.length > 0 ? requirements : await readFile(Paths.defaultRequirements, "utf8");
        // No injected syntax line: the grammar already headlines the system definition (§Syntax) and
        // leads requirements.md, so a third copy here was pure duplication in the model's packet. PLAN
        // is mandated unconditionally by plurnk.md §Imperatives (grammar 0.70 requires every turn to
        // lead with PLAN), so the service injects no separate plan directive either.
        const log = await this.#buildLog(workerId);
        const telemetryErrors = presetTelemetry ?? await this.buildTelemetryErrors(loopId, currentTurnSeq);
        const countTokens = rulerCount; // §tokenomics-agnostic-ruler — the ONE model-facing ruler (chars/2), not the provider
        // #367 — the capability sheet must reflect the LOOP MODE, not just workspace-enablement: an
        // ask-mode loop advertises only what its dispatch gate (resolveForLoop) will accept, so the
        // model is never taught a tag it'll then be 403'd on (the taught→emitted→rejected→508 spiral).
        const activeSchemes = this.#schemes.resolveForLoop(await this.#loadLoopFlags(loopId));
        const tools = this.#collectTools(await this.#workspaceEnabled(workspaceId), await WorkspaceSettings.questionsEnabled(this.#db, workspaceId), activeSchemes);
        // Budget readout (SPEC.md §tokenomics). Two-pass: render the budget from
        // the structured log's subtotals with a {{tokensFree}} placeholder, build
        // the section list, measure the assembled total, resolve free, substitute.
        // Subtotals come from the real log render — meta and fences included — not
        // a serialized approximation. ceiling is the provider's window ×
        // PLURNK_BUDGET_CEILING (null when no window is reported → headline
        // omitted, section lines still shown). §tokenomics-render-weight-budget
        const ceiling = this.ceilingFor(provider);
        const logBudget = PacketWire.measureLogBudget(log, countTokens);
        const budgetReadout = this.#renderBudget(logBudget, ceiling);
        // The default packet: an ordered list of addressable sections (§packet-assembly).
        // `slot` is the MESSAGE boundary — and therefore the cache breakpoint every serving
        // stack keys on. The wire is monotone in volatility ({§packet-cache-monotone}, #531):
        // system = the timeless (definition/tools/schemes/policy — byte-stable doctrine), user
        // = the situated (append-mostly log → per-turn status clump → recap), so the prefix
        // cache survives through the log's frozen head instead of dying at the first gauge
        // digit. Trust is the one-way ADMISSION rule, not the slot: system admits only
        // framework-authored, non-injectable content; engine-authored status may ride user;
        // attacker-reachable text may never ride system. The budget section carries its
        // {{tokensFree}} placeholders here; they resolve below once the assembled total is known.
        const inject = await readPacketInject(); // #240 — operator section, per-turn, fail-hard on a broken path
        const workspaceRoot = (await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId }))?.project_root ?? null;
        const systemPolicy = await readSystemPolicy();              // ~/.plurnk/AGENTS.md (or PLURNK_SERVICE_POLICY)
        const projectPolicy = await readProjectPolicy(workspaceRoot); // <projectRoot>/AGENTS.md (or PLURNK_SERVICE_PROJECT)
        // Child-orientation (§child-orientation): the live things THIS run holds — open streams +
        // unconcluded child workers — surfaced every turn as terse `* <status> <path>` pointers (same shape
        // as errors) just above the errors section. Orienting STATE so the model never loses track of
        // what it's holding (the premature-terminate trap), never advice on what to do. Empty → omitted.
        const childStreams = (await this.#db.engine_child_streams_open.all<{ scheme: string; pathname: string }>({ worker_id: workerId }))
            .map((s) => ({ status: "active", path: renderAddress(s.scheme, s.pathname) }));
        const childWorkers = (await this.#db.engine_child_workers_live.all<{ name: string; status: number }>({ worker_id: workerId }))
            .map((r) => ({ status: r.status, path: `worker://${r.name}` }));
        const defaults: PacketSection[] = [
            { name: "definition", slot: "system", header: null, content: system_definition, tokens: 0 },
            { name: "tools", slot: "system", header: "Registered Executable Tools", content: tools.executors, tokens: 0 },
            ...(tools.optionalOperations.length > 0
                ? [{ name: "optional-operations", slot: "system" as const, header: "Enabled Optional Operations", content: tools.optionalOperations, tokens: 0 }]
                : []),
            { name: "schemes", slot: "system", header: "Schemes", content: this.#schemes.teach(), tokens: 0 },
            ...(inject !== null ? [{ name: "inject", slot: "system" as const, header: "Operator Notes", content: inject, tokens: 0 }] : []),
            // policy: the client's privileged rules — ~/.plurnk/AGENTS.md (system) then <root>/AGENTS.md (project) — below grammar/tools/schemes, above budget-the-law. AGENTS is POLICY here, never a curatable READable entry. Empty content ⇒ section omitted.
            { name: "system-policy", slot: "system", header: "Policy", content: systemPolicy ?? "", tokens: 0 },
            { name: "project-policy", slot: "system", header: "Project Policy", content: projectPolicy ?? "", tokens: 0 },
            // log leads the user slot: injectable content (READ results, exec output, the model's own mirror) — data, never rules — its frozen head extends the cache prefix ({§packet-cache-monotone}).
            { name: "log", slot: "user", header: "Log", content: PacketWire.renderLog(log, countTokens), tokens: 0 },
            // The status clump — every per-turn-volatile section, quarantined between the log and
            // the recap ({§packet-cache-monotone}, #531): after the append-only log so its churn
            // never invalidates the log's cache prefix, and nearest the generation point (the
            // dashboard reads freshest exactly where the model acts). Engine-authored riding the
            // user slot is the legal trust direction; errors are uri+status POINTERS (the item +
            // body live in the log), git is counts — no injection surface either way.
            // child-orientation: what THIS run holds live — streams then runs — just above errors. Terse
            // pointers (the path is the actionable address the model READs/OPENs/KILLs), never advice. §child-orientation
            { name: "child-streams", slot: "user", header: "Child Streams", content: PacketWire.renderChildPointers(childStreams), tokens: 0 },
            { name: "child-workers", slot: "user", header: "Active Child Workers", content: PacketWire.renderChildPointers(childWorkers), tokens: 0 },
            { name: "errors", slot: "user", header: "Errors", content: PacketWire.renderErrors(telemetryErrors), tokens: 0 },
            { name: "git", slot: "user", header: "Git Status", content: PacketWire.renderGit(gitStatus), tokens: 0 },
            // budget — LAW (a hard ceiling the model must obey).
            { name: "budget", slot: "user", header: "Budget", content: budgetReadout, tokens: 0 },
            // §prompt-auto-read (owner): the prompts section closes the status clump —
            // a paths-only list (the errors shape); bodies arrive via the foisted auto-READ.
            { name: "prompt", slot: "user", header: "User Prompts", content: prompt, tokens: 0 },
            // requirements renders LAST — the user-slot footer, the syntax contract closest to the model's turn (a recency carve-out for weak models).
            { name: "requirements", slot: "user", header: "Recap", content: baseRequirements, tokens: 0 },
        ];
        // Plugin packet control (§packet-assembly): trusted schemes rewrite the
        // default list — add, remove, reorder — in-process, before measurement.
        const sections = await this.#schemes.transformSections(defaults);
        // Pass 1: measure the assembled total with the placeholder budget in
        // place, resolve free/percent, substitute into the budget section.
        let total = countTokens(PacketWire.renderSlot(sections, "system")) + countTokens(PacketWire.renderSlot(sections, "user"));
        {
            const budgetSec = sections.find((s) => s.name === "budget"); // a plugin may have removed it
            // A null ceiling (#421 — unbounded window) has no headline to calibrate: no truncation, no
            // percent/free substitution. #renderBudget already omitted the headline, so nothing to do.
            if (budgetSec && ceiling !== null) {
                // Curation pressure gates on OCCUPANCY (§tokenomics-pressure-gates-on-occupancy, #308):
                // the Turns/Heaviest tables are a standing FOLD-target list, and a high-headroom model
                // reads them as a todo — burning turns on token hygiene at 3% of a 64k window. Under
                // half-full, the headline's numbers stand alone (truncate at the first blank line) and
                // the total RE-measures — the substituted figures must reconcile with what ships.
                // A null ceiling can't calibrate, so the full readout stays.
                // A mermaid budget (#440) self-scales to pressure, so it is never truncated — the calm
                // low-usage view IS the point; only the tabular readout collapses under half-full.
                if (!budgetSec.content.includes("```mermaid") && (total / ceiling) * 100 < 50) {
                    const cut = budgetSec.content.indexOf("\n\n");
                    if (cut !== -1) {
                        budgetSec.content = budgetSec.content.slice(0, cut);
                        total = countTokens(PacketWire.renderSlot(sections, "system")) + countTokens(PacketWire.renderSlot(sections, "user"));
                    }
                }
                const tokensFree = Math.max(0, ceiling - total); // free floors at 0 on overshoot — §tokenomics-over-budget-floor
                const percent = (total / ceiling) * 100; // usage as % of the ceiling — §tokenomics-context-percent
                const sumTurns = logBudget.byTurn.reduce((s, t) => s + t.tokens, 0); // #440 — treemap non-turn box = total − Σturns
                const systemCtx = Math.max(0, total - sumTurns);
                // replaceAll: a mermaid budget recurs free/used across the headline + treemap + pie, so a
                // single .replace would leave the diagrams carrying literal {{…}} placeholders.
                budgetSec.content = budgetSec.content
                    .replaceAll(TOKEN_USAGE_PLACEHOLDER, String(total))
                    // Any nonzero usage under 1% is "<1" — Math.round alone claimed "1%" from 0.51%,
                    // overstating a near-empty window.
                    .replaceAll(TOKEN_PERCENT_PLACEHOLDER, total > 0 && percent < 1 ? "<1" : String(Math.round(percent)))
                    .replaceAll(TOKENS_FREE_PLACEHOLDER, String(tokensFree))
                    .replaceAll(SYSTEM_CTX_PLACEHOLDER, String(systemCtx));
            }
        }
        // Pass 2: per-section render-weight + the assembled packet total (post
        // substitution — the placeholder/number length delta is negligible).
        for (const s of sections) s.tokens = countTokens(PacketWire.renderSection(s));
        const packetTokens = countTokens(PacketWire.renderSlot(sections, "system")) + countTokens(PacketWire.renderSlot(sections, "user"));
        return { tokens: packetTokens, sections, telemetryErrors };
    }

    // Budget readout body, rendered into the `## Plurnk Service Budget` section.
    // Headline `ceiling/free` only when a ceiling exists; section lines for the
    // curatable index/log weight the model can FOLD back. tokensFree is a
    // placeholder here — buildRequestPacket substitutes it after measuring the packet.
    #renderBudget(
        log: {
            entries: number; tokens: number;
            byTurn: Array<{ turn: string; tokens: number }>;
            largest: Array<{ path: string; tokens: number }>;
        },
        ceiling: number | null,
    ): string {
        const lines: string[] = [];
        // #421 — no ceiling (unbounded window): omit the headline entirely; the section lines below
        // stay so the model keeps its FOLD-target surface, just with no percent it can't compute.
        if (ceiling !== null) lines.push(`Token Ceiling ${ceiling} · Token Usage ${TOKEN_USAGE_PLACEHOLDER} (${TOKEN_PERCENT_PLACEHOLDER}%) · Tokens Free ${TOKENS_FREE_PLACEHOLDER}`);
        // #440 {§budget-mermaid} — the enriched visual Budget (default on). With a ceiling to scale
        // against, the treemap REPLACES the Turns table (per-turn composition) + a pie gauge; the
        // heaviest-items list stays a table (#450). Self-scaled to pressure (calm→urgent), never <50%-truncated.
        // Set PLURNK_SERVICE_BUDGET_MERMAID=off to A/B against the tabular baseline (#440's before/after).
        if (process.env.PLURNK_SERVICE_BUDGET_MERMAID !== "off" && ceiling !== null && log.entries > 0) {
            if (lines.length > 0) lines.push("");
            lines.push(PacketBuilder.#renderBudgetMermaid(log, ceiling));
            // #450 — the heaviest items stay a plain ranked list (a ranking isn't a composition, no
            // treemap; two mermaid diagrams are enough visual examples) — the same table as the tabular budget.
            lines.push(...PacketBuilder.#heaviestItemsLines(log.largest));
            return lines.join("\n");
        }
        if (log.entries > 0) {
            if (lines.length > 0) lines.push("");
            lines.push(`Log entries: ${log.entries} entries, ${log.tokens} tokens`);
            // Per-turn weight — chronological (oldest first); the turn is the grinder's
            // rollback unit and the rail folds the newest first (§tokenomics {§tokenomics-turn-totals}).
            if (log.byTurn.length > 0) {
                lines.push("", "Turns:", "| turn | tokens |", "|---|--:|");
                for (const t of log.byTurn) lines.push(`| ${t.turn} | ${t.tokens} |`);
            }
            lines.push(...PacketBuilder.#heaviestItemsLines(log.largest));
        }
        return lines.join("\n");
    }

    // The heaviest individual log items — the FOLD targets behind the weight, a ranked LIST in both the
    // mermaid and tabular budgets (#450: a ranking isn't a composition, so it's never a chart). "items",
    // not "entries": log:/// rows, distinct from catalog entries (plurnk.md: "EDIT is only for entries").
    // {§tokenomics-largest-entries}
    static #heaviestItemsLines(largest: Array<{ path: string; tokens: number }>): string[] {
        if (largest.length === 0) return [];
        return ["", "Heaviest items (FOLD targets — folding reclaims their tokens):", "| item | tokens |", "|---|--:|",
            ...largest.map((e) => `| ${e.path} | ${e.tokens} |`)];
    }

    // #440 {§budget-mermaid} — the Budget as two budget-scaled mermaid diagrams (validated to render on
    // GitHub; syntax: plurnk-plurnkdown/demo/budget-mermaid.md). Both scaled to the CEILING, so salience
    // tracks pressure: `free` dominates at low usage (calm), turn boxes fill as it climbs (urgent).
    // free/used/system+context are placeholders — the post-assembly total resolves them. (#450 cut the xychart.)
    static #renderBudgetMermaid(
        log: { byTurn: Array<{ turn: string; tokens: number }> },
        ceiling: number,
    ): string {
        // Turn composition → treemap: turn boxes + system+context + free compose the whole ceiling —
        // the per-turn FOLD surface (which turns are heavy, labeled `turn L/T`) the headline can't give.
        const treemap = [
            "```mermaid",
            "treemap-beta",
            `"Budget — ceiling ${ceiling}"`,
            `    "free": ${TOKENS_FREE_PLACEHOLDER}`,
            `    "system + context": ${SYSTEM_CTX_PLACEHOLDER}`,
            ...log.byTurn.map((t) => `    "turn ${t.turn}": ${t.tokens}`),
            "```",
        ].join("\n");
        // Gauge → pie: used vs free, budget-scaled (used + free = ceiling); also a visual exemplar for
        // the model's own user-facing SENDs. (#450 cut the heaviest-items xychart — its bare-coordinate
        // labels a floor model can't decode, and the treemap already surfaces per-turn heaviness.)
        const pie = [
            "```mermaid",
            "pie showData",
            `    title Budget — used vs free (ceiling ${ceiling})`,
            `    "used" : ${TOKEN_USAGE_PLACEHOLDER}`,
            `    "free" : ${TOKENS_FREE_PLACEHOLDER}`,
            "```",
        ].join("\n");
        return [treemap, pie].join("\n\n");
    }

    // #328 — the per-workspace client execs policy narrows what the packet ADVERTISES, matching what
    // dispatch refuses: a workspace-disabled tag is absent from the capability sheet and the doc set,
    // never taught-then-refused. No policy (execs unset) → everything boot-registered shows.
    async #workspaceEnabled(workspaceId: number): Promise<(tag: string) => boolean> {
        const { execs } = await WorkspaceSettings.read(this.#db, workspaceId);
        if (execs === null) return () => true;
        return (tag: string) => Policy.isEnabled(tag, execs);
    }

    // The ## Registered Executable Tools capability sheet (SPEC §tools). Each available executor
    // tag contributes its self-documenting example (plurnk-execs#7); the closed heading distinguishes
    // registered selectors from the open-ended general examples above it. §tools-capability-sheet
    // Mirror of Dispatcher.#loadLoopFlags — the packet reads the SAME persisted flags the gate does.
    async #loadLoopFlags(loopId: number): Promise<LoopFlags> {
        const row = await this.#db.engine_get_loop_flags.get<{ flags: string }>({ loop_id: loopId });
        if (row === undefined) return DEFAULT_LOOP_FLAGS;
        try { return { ...DEFAULT_LOOP_FLAGS, ...JSON.parse(row.flags) as Partial<LoopFlags> }; }
        catch { return DEFAULT_LOOP_FLAGS; }
    }

    #collectTools(
        workspaceEnabled: (tag: string) => boolean,
        questionsOn = false,
        activeSchemes?: Set<string>,
    ): { executors: string; optionalOperations: string } {
        // §PACKET Tools (#441) — registered executor examples form a closed, explicitly titled
        // catalogue. Optional non-EXEC operations are separate so the heading remains truthful.
        const executorOps: string[] = [];
        const notices: string[] = [];
        // §send-300-choices — the one-liner rides ONLY where questions are enabled (allowed +
        // client-requested); the fuller questions.md doc injects through docEntries the same way.
        const optionalOperations = questionsOn
            ? "```plurnk\n<<SEND[300]:Deploy where?;staging;production:SEND\n```"
            : "";
        const executors = this.#executors();
        if (executors !== undefined) {
            const excluded = docsExcludeSet();
            const runtimes = executors.availableRuntimes();
            // execs#24 / #367: the sheet's lines are EXEC-usage examples, keyed on the 'exec' scheme
            // (the op face, excludedInAsk). When inactive, say so POSITIVELY (a prose notice): plurnk.md
            // still teaches EXEC as language, and silent absence measurably invites confabulated runtimes.
            const execActive = activeSchemes === undefined || activeSchemes.has("exec");
            if (runtimes.length > 0 && !execActive) {
                notices.push("EXEC operations are disabled for this loop — do not run commands; answer or advise directly");
            } else {
                for (const tag of runtimes) {
                    if (excluded.has(tag)) continue; // #240 — PLURNK_SERVICE_DOCS_EXCLUDE drops the oneliner + the doc
                    if (!workspaceEnabled(tag)) continue; // #328 — workspace-disabled tags aren't advertised
                    const entry = executors.entry(tag);
                    // #240 — the example IS the oneliner (a bare op, fenced below); the fuller doc
                    // materializes at plurnk://docs/<tag>.md. No example → no line.
                    if (entry?.example) executorOps.push(entry.example);
                }
            }
        }
        const parts: string[] = [...notices];
        if (executorOps.length > 0) parts.push(`\`\`\`plurnk\n${executorOps.join("\n")}\n\`\`\``);
        return { executors: parts.join("\n\n"), optionalOperations };
    }

    // #note12 — the plugin-provided reference docs (schemes' + execs' `documentation`),
    // materialized at plurnk:///docs/<name>.md by loop_run (like operator docs) so the
    // catalogue's doc-links READ and the manifest carries each doc's token weight.
    async docEntries(workspaceId: number): Promise<Array<{ name: string; content: string }>> {
        const out = this.#schemes.docs(); // scheme docs already drop PLURNK_SERVICE_DOCS_EXCLUDE names
        // §send-300-choices — the conditional teaching: questions.md (from the docs corpus)
        // materializes ONLY for enabled workspaces — the same conditional-doc mechanism as the EXEC
        // plugin docs below. An un-enabled workspace is never taught the op it can't use.
        if (await WorkspaceSettings.questionsEnabled(this.#db, workspaceId)) {
            try {
                const q = await readFile(resolvePath(Paths.schemeDocs, "questions.md"), "utf8");
                if (q.length > 0) out.push({ name: "questions", content: q });
            } catch { /* docs package without questions.md — nothing to inject */ }
        }
        const executors = this.#executors();
        if (executors !== undefined) {
            const excluded = docsExcludeSet();
            const workspaceEnabled = await this.#workspaceEnabled(workspaceId); // #328 — no doc for a disabled tag
            for (const tag of executors.availableRuntimes()) {
                if (excluded.has(tag)) continue; // #240 — exec docs honor the same exclude
                if (!workspaceEnabled(tag)) continue;
                const doc = executors.entry(tag)?.documentation;
                if (doc !== undefined && doc.length > 0) out.push({ name: tag, content: doc });
            }
        }
        return out;
    }

    // SPEC §grinder — the budget grinder. Runs pre-LLM (in runTurn, after the packet
    // is built, before provider.generate); fires only on actual overflow. One rule:
    // fold the NEWEST turn boundary's open rows (errors exempt) — never history —
    // strike, rebuild, re-measure. Folds (never deletes). The strike it raises and
    // the hard-stop it can signal are returned to runLoop, which owns abandonment.
    // §grinder-overflow-only — fires only on actual overflow, never speculatively
    async enforceBudget({ packet, provider, workerId, loopId, turnId, mintSequence, rebuild }: {
        packet: RequestPacket; provider: Provider;
        workerId: number; loopId: number; turnId: number; mintSequence: number;
        rebuild: () => Promise<RequestPacket>;
    }): Promise<{ packet: RequestPacket; fit: boolean; struck: boolean }> {
        const ceiling = this.ceilingFor(provider);
        const measure = (p: RequestPacket): number => p.tokens;
        // #421 — a null ceiling is an unbounded window: always fit, never fold or strike (the backend
        // clamps; this mirrors Engine's physicallySendable, which treats a null contextWindow as sendable).
        if (ceiling === null || measure(packet) <= ceiling) return { packet, fit: true, struck: false };

        // ONE rule, every turn — turn 1 and turn 101 alike (§grinder-layer1-rollback): fold the
        // NEWEST turn boundary's still-open rows (the prior turn's emissions + this turn's
        // pre-model rows; errors exempt) in one set-op, strike once, rebuild, re-measure.
        // THE DOCTRINE: the log is the model's memory and the model ALONE curates history — the
        // grinder never reaches back; it only blocks NEW memories from landing when there is no
        // room, forcing the model to do its own housekeeping (the strike is the escalation,
        // §grinder-compaction-strikes; a model that won't curate hard-413s/strikes out).
        // Mint the overflow as a terse op='error' log row BEFORE the rebuild, so the rebuild's
        // re-derived errors section surfaces it THIS turn — the warning lands at strike 1, not a
        // turn late. The row is grinder-exempt, so it stacks into a visible recurrence trail. It
        // sits at the turn's reserved running sequence (mintSequence) so it never collides with the
        // post-generate dispatch rows. §telemetry-uniform-error-channel, §grinder-overflow-error-row
        await this.#telemetry.mintEngineError("budget_overflow", { workerId, loopId, turnId, sequence: mintSequence });
        await this.#db.engine_grinder_fold_newest_turn.run({ loop_id: loopId, turn_id: turnId });
        const current = await rebuild();
        return { packet: current, fit: measure(current) <= ceiling, struck: true };
    }

    // §tokenomics-agnostic-ruler — the EXACT materialization measure: the provider's own token
    // count of the assembled packet, the ONE place per-model exactness is used (once per turn, at
    // the fit-gate). The model-facing render-weight (packet.tokens) stays the ruler; this is the
    // physics check that the real bytes fit the real window.
    exactPacketTokens(packet: RequestPacket, provider: Provider): number {
        return provider.countTokens(PacketWire.renderSlot(packet.sections, "system"))
            + provider.countTokens(PacketWire.renderSlot(packet.sections, "user"));
    }

    // Complete the packet by adding the model's response. After this the
    // packet matches Packet.json fully and is ready for storage.
    completePacket(requestPacket: RequestPacket, assistant: PacketAssistant, assistantRaw: unknown, provider: Provider): object {
        const assistantTokens = rulerCount(assistant.content); // §tokenomics-agnostic-ruler — render-weight in ruler units (usage_* keep the provider's real count)
        return {
            tokens: requestPacket.tokens + assistantTokens,
            sections: requestPacket.sections,
            telemetryErrors: requestPacket.telemetryErrors,
            assistant,
            assistantRaw,
        };
    }

    // SPEC §telemetry: model-facing alert surface.
    // Two sources, merged on each packet build:
    //   1. Previous-turn action-bound failures (status_rx >= 400 on log_entries).
    //   2. Engine-buffered actionless failures (no_send, parse, watchdog, rails).
    // Buffer drains on read — each error appears in exactly one packet.
    async buildTelemetryErrors(loopId: number, currentTurnSeq: number): Promise<object[]> {
        // The uniform error channel (§telemetry-uniform-error-channel): every 4xx/5xx log row
        // becomes a LogCoordinate-positioned TelemetryEvent — a terse pointer; the model READs the
        // row for its term + detail. Buffer events that point at the model's own emission keep their
        // ContentOffset position. info-level notices (progress) are not errors and never surface here.
        const rows = await this.#db.engine_render_telemetry_errors.all<{
            op: string; sequence: number; status_rx: number;
            turn_seq: number; loop_seq: number;
        }>({ loop_id: loopId, current_turn_seq: currentTurnSeq });
        const logErrors = rows.map((r) => ({
            source: "engine:rail",
            kind: "log_error",
            level: "error",
            status: r.status_rx,
            position: { type: "log-coordinate", coordinate: `${r.loop_seq}/${r.turn_seq}/${r.sequence}/${r.op}` },
        }));
        const bufferEvents = this.#telemetry.drain(loopId).filter((e) => (e as { level?: string }).level !== "info");
        return [...bufferEvents, ...logErrors];
    }

    // SPEC §packet the log section — chronological action-entries for the loop.
    // Snapshot is taken at packet build (pre-dispatch this turn), so it
    // reflects "what has happened before this turn." Each row carries a
    // log:///<loop_seq>/<turn_seq>/<sequence> coordinate the model can READ.
    async #buildLog(workerId: number): Promise<object[]> {
        // SPEC §packet-terms: runs own log entries — log is the worker's history,
        // not the loop's. Span all loops in the worker so the model sees
        // earlier loops' work as conversational memory.
        //
        // User prompts are first-class log entries: runTurn writes a
        // client-origin SEND[200] row at sequence=0 of each new
        // turn-1. Prompts thus surface naturally in this query — no
        // synthetic / shim layer.
        const rows = await this.#db.engine_render_log.all<{
            loop_seq: number; turn_seq: number; sequence: number;
            origin: string; op: string; suffix: string; signal: string | null;
            scheme: string | null; username: string | null; password: string | null;
            hostname: string | null; port: number | null; pathname: string | null;
            params: string | null; fragment: string | null;
            status_rx: number; rx: string; mimetype_rx: string;
            tx: string; mimetype_tx: string; expanded: number; source: string | null; attrs: string | null;
        }>({ worker_id: workerId });
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
            folded: r.expanded === 0,
            source: r.source,
            attrs: r.attrs === null ? null : JSON.parse(r.attrs),
        }));
    }
}
