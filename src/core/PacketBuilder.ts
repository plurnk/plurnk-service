import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type TelemetryChannel from "./TelemetryChannel.ts";
import type { GitStatus } from "./git-state.ts";
import { renderAddress } from "./plurnk-uri.ts";
import { teachingLine, docsExcludeSet } from "./teaching.ts";
import { Policy } from "@plurnk/plurnk-execs";
import SessionSettings from "./session-settings.ts";
import { readPacketInject, readSystemPolicy, readProjectPolicy } from "./packet-inject.ts";
import { readFile } from "node:fs/promises";
import Paths from "../Paths.ts";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire, { type PacketSection } from "./packet-wire.ts";

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { Provider } from "@plurnk/plurnk-providers";

// Substituted into the budget readout after the assembled packet is measured
// (the figure depends on the packet's own rendered size — chicken/egg).
const TOKENS_FREE_PLACEHOLDER = "{{tokensFree}}";
const TOKEN_USAGE_PLACEHOLDER = "{{tokenUsage}}";
const TOKEN_PERCENT_PLACEHOLDER = "{{tokenPercent}}";

// §tokenomics-window-partition — the four partition numbers. REQUIRED (fail-hard, the
// providers-env convention): the ceiling is DERIVED from these, never set directly
// (PLURNK_BUDGET_CEILING is retired — a settable ceiling let policy contradict physics).
const readPartitionInt = (name: string, min: number): number => {
    const raw = process.env[name];
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

// Packet assembly (SPEC §packet-construction) + the budget grinder (§grinder):
// builds the spec'd request packet, measures it, and reclaims window on overflow.
export default class PacketBuilder {

    #db: Db;
    #schemes: SchemeRegistry;
    #telemetry: TelemetryChannel;
    // Boot-discovered runtime executors, late-injected on Engine after daemon
    // start() — read through a thunk so the post-construction set is visible.
    #executors: () => ExecutorRegistry | undefined;
    // §tokenomics-window-partition — policy max, reasoning reserve, content floor, template
    // overhead. Shipped defaults partition any ≥77Ki window to EXACTLY 65536 prompt tokens.
    #ctx: number;
    #reasoning: number;
    #assistant: number;
    #safety: number;

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
        this.#ctx = readPartitionInt("PLURNK_SERVICE_CTX", 1);
        this.#reasoning = readPartitionInt("PLURNK_SERVICE_REASONING", 0);
        this.#assistant = readPartitionInt("PLURNK_SERVICE_ASSISTANT", 0);
        this.#safety = readPartitionInt("PLURNK_SERVICE_SAFETY", 0);
    }

    // The generation envelope — REASONING + ASSISTANT, one undifferentiated pool, passed on
    // every generate({maxTokens}): no decode is unbounded (§tokenomics-window-partition).
    decodeBudget(): number {
        return this.#reasoning + this.#assistant;
    }

    // §tokenomics-window-partition ÷ §tokenomics-ceiling-calibrates-to-usage — the prompt ceiling
    // is DERIVED, never set: effectiveWindow = min(CTX, provider window; CTX alone when the
    // provider reports none) minus the reserves, divided by the loop's observed real/measured
    // token ratio (usage.prompt is ground truth; a heuristic ruler shipped a 65k-real packet into
    // a 49k window, #311). A fractional ceiling also budgeted the prompt against the window and
    // FORGOT the response lives there too. Reserves exceeding the window is a configuration
    // contradiction — fail hard. ratio floors at 1: an overcounting ruler never expands the budget.
    ceilingFor(provider: Provider, tokenRatio = 1): number {
        const effectiveWindow = provider.contextSize === null ? this.#ctx : Math.min(this.#ctx, provider.contextSize);
        const promptBudget = effectiveWindow - this.#reasoning - this.#assistant - this.#safety;
        if (promptBudget <= 0) throw new Error(`window partition contradiction: effective window ${effectiveWindow} <= reserves ${this.#reasoning}+${this.#assistant}+${this.#safety} (PLURNK_SERVICE_CTX/REASONING/ASSISTANT/SAFETY)`);
        return Math.floor(promptBudget / Math.max(1, tokenRatio));
    }

    // Assemble the request half of the spec'd packet (Packet.json §system
    // and §user) BEFORE the provider call. The same packet object is then
    // completed with assistant + assistantRaw after the model responds, so
    // the stored packet and the wire payload share one source of truth.
    async buildRequestPacket({
        initialMessages, requirements, sessionId, runId, loopId, currentTurnSeq, provider, gitStatus, tokenRatio = 1, telemetryErrors: presetTelemetry,
    }: {
        // The loop's observed real/measured token ratio (§tokenomics-ceiling-calibrates-to-usage).
        tokenRatio?: number;
        initialMessages: ChatMessage[];
        // Optional requirements override. Empty in practice — callers don't thread it;
        // the engine sources Paths.defaultRequirements itself (a non-empty value wins).
        requirements: string;
        gitStatus: GitStatus | null;
        sessionId: number; runId: number; loopId: number;
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
        // (plurnk:///prompt/<loop_id>/<N> for the highest N written to date).
        // This is what inject + the turn-1 foist write into. Falls back to
        // the runLoop caller's messages.user for tests that bypass the
        // foist mechanism entirely.
        const promptRows = (await (this.#db.drain_get_all_prompt_bodies_for_loop as PrepMethod).all<{ content: string; pathname: string }>({ pattern: `/prompt/${loopId}/%` }))
            .filter((r) => typeof r.content === "string" && r.content.length > 0);
        const promptCap = Number.parseInt(process.env.PLURNK_SERVICE_PROMPT_PREVIEW_CHARS ?? "", 10);
        const prompt = promptRows.length > 0
            ? PacketWire.renderActivePrompts(promptRows, Number.isInteger(promptCap) ? promptCap : -1)
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
        const log = await this.#buildLog(runId);
        const telemetryErrors = presetTelemetry ?? await this.buildTelemetryErrors(loopId, currentTurnSeq);
        const countTokens = (t: string): number => provider.countTokens(t); // §provider-surface-counttokens
        const tools = this.#collectTools(await this.#sessionEnabled(sessionId));
        // Budget readout (SPEC.md §tokenomics). Two-pass: render the budget from
        // the structured log's subtotals with a {{tokensFree}} placeholder, build
        // the section list, measure the assembled total, resolve free, substitute.
        // Subtotals come from the real log render — meta and fences included — not
        // a serialized approximation. ceiling is the provider's window ×
        // PLURNK_BUDGET_CEILING (null when no window is reported → headline
        // omitted, section lines still shown). §tokenomics-render-weight-budget
        const ceiling = this.ceilingFor(provider, tokenRatio);
        const budgetReadout = this.#renderBudget(PacketWire.measureLogBudget(log, countTokens), ceiling);
        // The default packet: an ordered list of addressable sections (§packet-construction).
        // `slot` is a TRUST boundary (and the prompt-cache boundary): system holds only
        // framework-authored, non-injectable sections — the static head (definition/tools/
        // schemes/policy) forms the cached prefix, then the volatile-but-trusted tail of
        // errors/git/budget; user holds injectable content (the log, the operator prompt) plus
        // the requirements footer. The budget section carries its {{tokensFree}} placeholders
        // here; they resolve below once the assembled total is known.
        const inject = await readPacketInject(); // #240 — operator section, per-turn, fail-hard on a broken path
        const sessionRoot = (await (this.#db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: sessionId }))?.project_root ?? null;
        const systemPolicy = await readSystemPolicy();              // ~/.plurnk/AGENTS.md (or PLURNK_SERVICE_POLICY)
        const projectPolicy = await readProjectPolicy(sessionRoot); // <projectRoot>/AGENTS.md (or PLURNK_SERVICE_PROJECT)
        // Child-orientation (§child-orientation): the live things THIS run holds — open streams +
        // unconcluded child runs — surfaced every turn as terse `* <status> <path>` pointers (same shape
        // as errors) just above the errors section. Orienting STATE so the model never loses track of
        // what it's holding (the premature-terminate trap), never advice on what to do. Empty → omitted.
        const childStreams = (await (this.#db.engine_child_streams_open as PrepMethod).all<{ scheme: string; pathname: string }>({ run_id: runId }))
            .map((s) => ({ status: "active", path: renderAddress(s.scheme, s.pathname) }));
        const childRuns = (await (this.#db.engine_child_runs_live as PrepMethod).all<{ name: string; status: number }>({ run_id: runId }))
            .map((r) => ({ status: r.status, path: `run://${r.name}` }));
        const defaults: PacketSection[] = [
            { name: "definition", slot: "system", header: null, content: system_definition, tokens: 0 },
            { name: "tools", slot: "system", header: null, content: tools.join("\n"), tokens: 0 }, // titleless — the examples flow on from plurnk.md (definition) directly above
            { name: "schemes", slot: "system", header: "Plurnk Service Schemes", content: this.#schemes.teach(), tokens: 0 },
            ...(inject !== null ? [{ name: "inject", slot: "system" as const, header: "Plurnk Operator Notes", content: inject, tokens: 0 }] : []),
            // policy: the client's privileged rules — ~/.plurnk/AGENTS.md (system) then <root>/AGENTS.md (project) — below grammar/tools/schemes, above budget-the-law. AGENTS is POLICY here, never a curatable READable entry. Empty content ⇒ section omitted.
            { name: "system-policy", slot: "system", header: "Plurnk Service Policy", content: systemPolicy ?? "", tokens: 0 },
            { name: "project-policy", slot: "system", header: "Project Policy", content: projectPolicy ?? "", tokens: 0 },
            // The packet split is a TRUST boundary: system carries only framework-authored, non-injectable
            // sections; anything that could carry attacker-reachable text (a READ result, exec output, the
            // model's own mirrored bytes) stays in user. errors + git are framework status — the errors
            // section is uri+status POINTERS (the error item + body live in the log), git is counts — so
            // neither is an injection surface; both sit at the bottom of system, just above budget-the-law.
            // child-orientation: what THIS run holds live — streams then runs — just above errors. Terse
            // pointers (the path is the actionable address the model READs/OPENs/KILLs), never advice. §child-orientation
            { name: "child-streams", slot: "system", header: "Plurnk Service Child Streams", content: PacketWire.renderChildPointers(childStreams), tokens: 0 },
            { name: "child-runs", slot: "system", header: "Plurnk Service Child Runs", content: PacketWire.renderChildPointers(childRuns), tokens: 0 },
            { name: "errors", slot: "system", header: "Plurnk Service Errors", content: PacketWire.renderErrors(telemetryErrors), tokens: 0 },
            { name: "git", slot: "system", header: "Plurnk Service Git Status", content: PacketWire.renderGit(gitStatus), tokens: 0 },
            // budget is the very last system line — LAW (a hard ceiling the model must obey), the final word before the model acts.
            { name: "budget", slot: "system", header: "Plurnk Service Budget", content: budgetReadout, tokens: 0 },
            // log in the user slot: injectable content (READ results, exec output, the model's own mirror) — data, never rules — kept at the action point so the model consults its history.
            { name: "log", slot: "user", header: "Plurnk Service Log", content: PacketWire.renderLog(log, countTokens), tokens: 0 },
            // the ACTIVE user prompts (all the current loop holds, in order — a loop admits injected
            // prompts) render at the BOTTOM, just above requirements — at the action point, closest to
            // the model's turn. Each is a bare heredoc (the fence is the link); §prompt-fold.
            { name: "prompt", slot: "user", header: "Plurnk Service Active User Prompts", content: prompt, tokens: 0 },
            // requirements renders LAST — the user-slot footer, the syntax contract closest to the model's turn (a recency carve-out for weak models).
            { name: "requirements", slot: "user", header: "Plurnk Service Requirements", content: baseRequirements, tokens: 0 },
        ];
        // Plugin packet control (§packet-construction): trusted schemes rewrite the
        // default list — add, remove, reorder — in-process, before measurement.
        const sections = await this.#schemes.transformSections(defaults);
        // Pass 1: measure the assembled total with the placeholder budget in
        // place, resolve free/percent, substitute into the budget section.
        let total = countTokens(PacketWire.renderSlot(sections, "system")) + countTokens(PacketWire.renderSlot(sections, "user"));
        {
            const budgetSec = sections.find((s) => s.name === "budget"); // a plugin may have removed it
            if (budgetSec) {
                // Curation pressure gates on OCCUPANCY (§tokenomics-pressure-gates-on-occupancy, #308):
                // the Turns/Heaviest tables are a standing FOLD-target list, and a high-headroom model
                // reads them as a todo — burning turns on token hygiene at 3% of a 64k window. Under
                // half-full, the headline's numbers stand alone (truncate at the first blank line) and
                // the total RE-measures — the substituted figures must reconcile with what ships.
                // A null ceiling can't calibrate, so the full readout stays.
                if ((total / ceiling) * 100 < 50) {
                    const cut = budgetSec.content.indexOf("\n\n");
                    if (cut !== -1) {
                        budgetSec.content = budgetSec.content.slice(0, cut);
                        total = countTokens(PacketWire.renderSlot(sections, "system")) + countTokens(PacketWire.renderSlot(sections, "user"));
                    }
                }
                const tokensFree = Math.max(0, ceiling - total); // free floors at 0 on overshoot — §tokenomics-over-budget-floor
                const percent = (total / ceiling) * 100; // usage as % of the ceiling — §tokenomics-context-percent
                budgetSec.content = budgetSec.content
                    .replace(TOKEN_USAGE_PLACEHOLDER, String(total))
                    // Any nonzero usage under 1% is "<1" — Math.round alone claimed "1%" from 0.51%,
                    // overstating a near-empty window.
                    .replace(TOKEN_PERCENT_PLACEHOLDER, total > 0 && percent < 1 ? "<1" : String(Math.round(percent)))
                    .replace(TOKENS_FREE_PLACEHOLDER, String(tokensFree));
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
        ceiling: number,
    ): string {
        const lines: string[] = [];
        lines.push(`Token Ceiling ${ceiling} · Token Usage ${TOKEN_USAGE_PLACEHOLDER} (${TOKEN_PERCENT_PLACEHOLDER}%) · Tokens Free ${TOKENS_FREE_PLACEHOLDER}`);
        if (log.entries > 0) {
            if (lines.length > 0) lines.push("");
            lines.push(`Log entries: ${log.entries} entries, ${log.tokens} tokens`);
            // Per-turn weight — chronological (oldest first); the turn is the grinder's
            // rollback unit and the rail folds the newest first (§tokenomics {§tokenomics-turn-totals}).
            if (log.byTurn.length > 0) {
                lines.push("", "Turns:", "| turn | tokens |", "|---|--:|");
                for (const t of log.byTurn) lines.push(`| ${t.turn} | ${t.tokens} |`);
            }
            // The heaviest individual log items — the FOLD targets behind the weight
            // (§tokenomics {§tokenomics-largest-entries}). "items", not "entries": the readout
            // lists log:/// rows (log items), distinct from catalog entries (plurnk.md: "EDIT
            // is only for entries. Do not attempt to edit log items.").
            if (log.largest.length > 0) {
                lines.push("", "Heaviest items:", "| item | tokens |", "|---|--:|");
                for (const e of log.largest) lines.push(`| ${e.path} | ${e.tokens} |`);
            }
        }
        return lines.join("\n");
    }

    // #328 — the per-session client execs policy narrows what the packet ADVERTISES, matching what
    // dispatch refuses: a session-disabled tag is absent from the capability sheet and the doc set,
    // never taught-then-refused. No policy (execs unset) → everything boot-registered shows.
    async #sessionEnabled(sessionId: number): Promise<(tag: string) => boolean> {
        const { execs } = await SessionSettings.read(this.#db, sessionId);
        if (execs === null) return () => true;
        return (tag: string) => Policy.isEnabled(tag, execs);
    }

    // The ## Plurnk Service Tools capability sheet (SPEC §tools). A hook: each enabled
    // capability contributes one line, rendered above Requirements so the model sees what
    // it can do before the rules. Each available executor tag contributes its self-documenting
    // example (plurnk-execs#7), retiring the blind EXEC.
    // The capability sheet — the live tool surface (wired executor tags). §tools-capability-sheet
    #collectTools(sessionEnabled: (tag: string) => boolean): string[] {
        const tools: string[] = [];
        // Each available runtime tag contributes its self-documenting example —
        // the example carries syntax + purpose, so there's no prose line. Tags
        // with no example (sh/node, covered by the core prompt) contribute
        // nothing; available-only, so the model never sees an unusable tag. `* `
        // bullets + bare op forms match the packet's list/op rendering (no `- `,
        // no backticks — see packet-wire.ts).
        const executors = this.#executors();
        if (executors !== undefined) {
            const excluded = docsExcludeSet();
            for (const tag of executors.availableRuntimes()) {
                if (excluded.has(tag)) continue; // #240 — PLURNK_SERVICE_DOCS_EXCLUDE drops the oneliner + the doc
                if (!sessionEnabled(tag)) continue; // #328 — session-disabled tags aren't advertised
                const entry = executors.entry(tag);
                // #240 — identical treatment with the scheme directory: the example IS the oneliner,
                // the fuller doc (materialized at plurnk://docs/<tag>.md) rides an inline link whose
                // token cost lives on that manifest entry. No example → no line (like a provisional scheme).
                if (entry?.example) tools.push(teachingLine(entry.example));
            }
        }
        return tools;
    }

    // #note12 — the daughter-provided reference docs (schemes' + execs' `documentation`),
    // materialized at plurnk:///docs/<name>.md by loop_run (like operator docs) so the
    // catalogue's doc-links READ and the manifest carries each doc's token cost.
    async docEntries(sessionId: number): Promise<Array<{ name: string; content: string }>> {
        const out = this.#schemes.docs(); // scheme docs already drop PLURNK_SERVICE_DOCS_EXCLUDE names
        const executors = this.#executors();
        if (executors !== undefined) {
            const excluded = docsExcludeSet();
            const sessionEnabled = await this.#sessionEnabled(sessionId); // #328 — no doc for a disabled tag
            for (const tag of executors.availableRuntimes()) {
                if (excluded.has(tag)) continue; // #240 — exec docs honor the same exclude
                if (!sessionEnabled(tag)) continue;
                const doc = executors.entry(tag)?.documentation;
                if (doc !== undefined && doc.length > 0) out.push({ name: tag, content: doc });
            }
        }
        return out;
    }

    // SPEC §grinder — the budget grinder. Runs pre-LLM (in runTurn, after the packet
    // is built, before provider.generate); fires only on actual overflow. One rule:
    // fold ALL the run's open log rows (errors exempt), strike, rebuild, re-measure.
    // Folds (never deletes). The strike it raises and the hard-stop it can signal
    // are returned to runLoop, which owns abandonment.
    // §grinder-overflow-only — fires only on actual overflow, never speculatively
    async enforceBudget({ packet, provider, runId, loopId, turnId, mintSequence, tokenRatio = 1, rebuild }: {
        packet: RequestPacket; provider: Provider;
        runId: number; loopId: number; turnId: number; mintSequence: number;
        tokenRatio?: number;
        rebuild: () => Promise<RequestPacket>;
    }): Promise<{ packet: RequestPacket; fit: boolean; struck: boolean }> {
        const ceiling = this.ceilingFor(provider, tokenRatio);
        const measure = (p: RequestPacket): number => p.tokens;
        if (measure(packet) <= ceiling) return { packet, fit: true, struck: false };

        // ONE rule, every turn — turn 1 and turn 101 alike (§grinder-layer1-rollback): fold ALL of
        // the run's still-open log rows (errors exempt), strike once, rebuild, re-measure. Folding is
        // reversible and every folded row stays listed at its coordinate, so nothing is lost — the
        // model re-OPENs precisely what it needs; the engine never guesses which subset to spare.
        // The teaching pressure is the STRIKE (§grinder-compaction-strikes), not engine restraint.
        // Mint the overflow as a terse op='error' log row BEFORE the rebuild, so the rebuild's
        // re-derived errors section surfaces it THIS turn — the warning lands at strike 1, not a
        // turn late. The row is grinder-exempt, so it stacks into a visible recurrence trail. It
        // sits at the turn's reserved running sequence (mintSequence) so it never collides with the
        // post-generate dispatch rows. §telemetry-uniform-error-channel, §grinder-overflow-error-row
        await this.#telemetry.mintEngineError("budget_overflow", { runId, loopId, turnId, sequence: mintSequence });
        await (this.#db.engine_grinder_fold_run_logs as PrepMethod).run({ run_id: runId });
        const current = await rebuild();
        return { packet: current, fit: measure(current) <= ceiling, struck: true };
    }

    // Complete the packet by adding the model's response. After this the
    // packet matches Packet.json fully and is ready for storage.
    completePacket(requestPacket: RequestPacket, assistant: PacketAssistant, assistantRaw: unknown, provider: Provider): object {
        const assistantTokens = provider.countTokens(assistant.content);
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
        const rows = await (this.#db.engine_render_telemetry_errors as PrepMethod).all<{
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
            tx: string; mimetype_tx: string; expanded: number; source: string | null; attrs: string | null;
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
            folded: r.expanded === 0,
            source: r.source,
            attrs: r.attrs === null ? null : JSON.parse(r.attrs),
        }));
    }
}
