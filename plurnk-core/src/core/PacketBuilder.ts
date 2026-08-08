import type { Notice } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type ProblemLog from "./ProblemLog.ts";
import type { GitStatus } from "./git-state.ts";
import { renderAddress, promptLoopPrefix } from "./plurnk-uri.ts";
import { rulerCount } from "./token-ruler.ts";
import { docsExcludeSet } from "./teaching.ts";
import { Policy } from "@plurnk/plurnk-execs";
import WorkspaceSettings from "./workspace-settings.ts";
import LoopFlagsReader from "./LoopFlagsReader.ts";
import { readPacketInject, readSystemPolicy, readProjectPolicy } from "./packet-inject.ts";
import { readFile } from "node:fs/promises";
import Paths from "../Paths.ts";
import { readTeachingSource } from "./teaching-corpus.ts";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";
import type { RequestPacket, StoredPacketSection } from "./StoredPacket.ts";

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { ChatMessage, PromptTokenMeasurement, Provider } from "@plurnk/plurnk-providers";
import { assertPromptTokenMeasurement, scopeEnvToAlias, resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import BudgetOverflow from "./BudgetOverflow.ts";
import BudgetReadout from "./BudgetReadout.ts";

const trimHorizontal = (value: string): string => value.replace(/^[\t ]+|[\t ]+$/gu, "");

const tableCells = (line: string): string[] | null => {
    if (!line.startsWith("|") || !line.endsWith("|")) return null;
    const cells: string[] = [];
    let start = 1;
    for (let index = 1; index < line.length - 1; index += 1) {
        if (line[index] !== "|") continue;
        let escapes = 0;
        for (let previous = index - 1; previous >= start && line[previous] === "\\"; previous -= 1) escapes += 1;
        if (escapes % 2 === 1) continue;
        cells.push(line.slice(start, index));
        start = index + 1;
    }
    cells.push(line.slice(start, -1));
    return cells;
};

const isTableDivider = (cells: readonly string[]): boolean =>
    cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(trimHorizontal(cell)));

// {§definition-table-projection} — plurnk.md remains spacious for human editing;
// only its well-formed Markdown tables lose authoring alignment on the packet wire.
const compactDefinitionTables = (markdown: string): string => {
    const lines = markdown.split("\n");
    let fence: { marker: "`" | "~"; length: number } | null = null;
    let inTable = false;
    let dividerIndex = -1;

    return lines.map((rawLine, index) => {
        const carriageReturn = rawLine.endsWith("\r") ? "\r" : "";
        const line = carriageReturn.length > 0 ? rawLine.slice(0, -1) : rawLine;
        const fenceRun = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
        if (fence !== null) {
            const closingRun = line.match(/^ {0,3}(`+|~+)[\t ]*$/u)?.[1];
            if (closingRun?.[0] === fence.marker && closingRun.length >= fence.length) fence = null;
            return rawLine;
        }
        if (fenceRun !== undefined) {
            fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
            inTable = false;
            dividerIndex = -1;
            return rawLine;
        }

        const cells = tableCells(line);
        if (!inTable) {
            const nextRawLine = lines[index + 1] ?? "";
            const nextLine = nextRawLine.endsWith("\r") ? nextRawLine.slice(0, -1) : nextRawLine;
            const dividerCells = tableCells(nextLine);
            if (cells === null || dividerCells === null || cells.length !== dividerCells.length || !isTableDivider(dividerCells)) return rawLine;
            inTable = true;
            dividerIndex = index + 1;
        } else if (cells === null) {
            inTable = false;
            dividerIndex = -1;
            return rawLine;
        }

        if (index === dividerIndex) {
            const divider = cells.map((cell) => {
                const value = trimHorizontal(cell);
                return `${value.startsWith(":") ? ":" : ""}---${value.endsWith(":") ? ":" : ""}`;
            });
            return `|${divider.join("|")}|${carriageReturn}`;
        }
        return `| ${cells.map(trimHorizontal).join(" | ")} |${carriageReturn}`;
    }).join("\n");
};

// {§tokenomics-window-partition} — the four partition numbers. REQUIRED (fail-hard, the
// providers-env convention): the ceiling is DERIVED from these, never set directly
// (PLURNK_BUDGET_CEILING is retired — a settable ceiling let policy contradict physics).
const readPartitionIntFrom = (env: NodeJS.ProcessEnv, name: string, min: number): number => {
    const raw = env[name];
    const n = Number.parseInt(raw ?? "", 10);
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be an integer >= ${min}; got ${raw}`);
    return n;
};

const readOptionalPositiveIntFrom = (env: NodeJS.ProcessEnv, name: string): number | null => {
    const raw = env[name];
    if (raw === undefined || raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer; got ${raw}`);
    return n;
};

export type { ChatMessage } from "@plurnk/plurnk-providers";

export type PhysicalPromptAdmission =
    | {
        readonly admitted: true;
        readonly capacity: number;
        readonly measurement: PromptTokenMeasurement;
    }
    | {
        readonly admitted: false;
        readonly reason: "unknown_context_window" | "unknown_output_envelope" | "estimate" | "over_capacity";
        readonly detail: string;
        readonly capacity: number | null;
        readonly measurement?: PromptTokenMeasurement;
    };

// Packet assembly (SPEC {§packet-assembly}) + the budget grinder ({§grinder}):
// builds the spec'd request packet, measures it, and reclaims window on overflow.
export default class PacketBuilder {

    #db: Db;
    #schemes: SchemeRegistry;
    #problems: ProblemLog;
    // Boot-discovered runtime executors, late-injected on Engine after daemon
    // start() — read through a thunk so the post-construction set is visible.
    #executors: () => ExecutorRegistry | undefined;
    // {§tokenomics-window-partition} — the partition is PER-ALIAS, resolved per provider in
    // #partitionFor and cached by alias; no boot-time global read.

    constructor({ db, schemes, problems, executors }: {
        db: Db;
        schemes: SchemeRegistry;
        problems: ProblemLog;
        executors: () => ExecutorRegistry | undefined;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#problems = problems;
        this.#executors = executors;
        // {§tokenomics-window-partition} — the envelope rides the provider; construction only runs the retired-knob shed
        // so a stale operator .env fails at BOOT, not first use.
        const bootAlias = resolveActiveAlias(process.env)?.alias ?? "";
        this.#safetyFor(bootAlias);
        this.#promptBudgetCapFor(bootAlias);
    }

    // {§tokenomics-window-partition} — provider generation settings and core packet policy both resolve per alias.
    // scopeEnvToAlias resolves PLURNK_SERVICE_*_<alias> over the bare fallback with providers' own
    // battle-tested suffix parser. Cached per alias; the boot-global case falls back to the active
    // alias when a provider carries no side-table entry (a test Mock).
    // Provider context and response reserves remain provider-owned. Core owns only its virtual
    // prompt budget and the ruler's packing-safety margin.
    static #KNOBS = ["PLURNK_SERVICE_PROMPT_BUDGET", "PLURNK_SERVICE_SAFETY"] as const;
    #shedChecked = false;

    #safetyFor(alias: string): number {
        // {§tokenomics-window-partition} hard shed: the three misprefixed partition knobs moved to the
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
                if (m !== null) throw new Error(`${k} is retired: the envelope is provider-owned — the knob is ${MOVED[m[1]]}${m[2] ?? ""}.`);
            }
        }
        const view = scopeEnvToAlias(process.env, alias, PacketBuilder.#KNOBS);
        return readPartitionIntFrom(view, "PLURNK_SERVICE_SAFETY", 0);
    }

    #promptBudgetCapFor(alias: string): number | null {
        const view = scopeEnvToAlias(process.env, alias, PacketBuilder.#KNOBS);
        return readOptionalPositiveIntFrom(view, "PLURNK_SERVICE_PROMPT_BUDGET");
    }

    #partitionFor(provider: Provider): { reasoning: number | null; completion: number | null; safety: number } {
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(process.env)?.alias ?? "";
        return { reasoning: provider.reasoningReserve ?? null, completion: provider.completionReserve ?? null, safety: this.#safetyFor(alias) };
    }

    // The generation envelope — REASONING + COMPLETION, one undifferentiated pool, passed on
    // every generate({maxTokens}): no decode is unbounded ({§tokenomics-window-partition}). Per
    // alias: gemma's measured envelope; a cloud alias's generous default the backend clamps.
    maxTokensFor(provider: Provider): number | null {
        const { reasoning, completion } = this.#partitionFor(provider);
        if (reasoning === null || completion === null) return null; // {§tokenomics-window-unpollable-deliberate}: unknown envelope, no cap; the backend clamps
        return reasoning + completion;
    }

    // {§tokenomics-window-partition} — the natural prompt ceiling is the provider's
    // effective context window minus its response reserves and the service's ruler
    // safety. An optional service prompt budget may only tighten that result. It is
    // model-facing grinder policy, never provider physics or a generation setting.
    // The client-facing gauge, grinder ceiling, and persisted promptBudget use this one value.
    promptBudgetFor(provider: Provider): number | null {
        return this.ceilingFor(provider); // ONE derivation — the gauge denominator IS the grinder ceiling
    }

    // {§tokenomics-agnostic-ruler} — the ceiling is the real window partition (window − reserves),
    // NO calibration ratio: the model-facing measure is the chars/2 ruler (an over-count for
    // typical text), so comparing ruler-weight to the real-token ceiling is itself the conservative
    // bias - the packet reports less room than the provider usually has; authoritative
    // provider request evidence guards the pathological tail at recovery admission.
    ceilingFor(provider: Provider): number | null {
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(process.env)?.alias ?? "";
        const operatorCap = this.#promptBudgetCapFor(alias);
        // Unknown provider physics stays unknown; an explicit virtual ceiling still bounds
        // PLURNK's packet without pretending to describe the backend.
        if (provider.contextWindow === null) return operatorCap;
        const { reasoning, completion, safety } = this.#partitionFor(provider);
        if (reasoning === null || completion === null) return operatorCap;
        const naturalBudget = provider.contextWindow - reasoning - completion - safety;
        if (naturalBudget <= 0) {
            // {§tokenomics-window-partition} — this contradiction has one cause: pinned absolute reserves
            // exceeding the window the provider detected (percent reserves derive and cannot contradict).
            throw new Error(`window partition contradiction for alias '${alias}': window ${provider.contextWindow} <= reserves ${reasoning}+${completion}+${safety}. Pinned PLURNK_PROVIDERS_{REASONING,COMPLETION}_RESERVE absolutes exceed the detected window — repin them under it, or use percent reserves, which derive from the window.`);
        }
        return operatorCap === null ? naturalBudget : Math.min(operatorCap, naturalBudget);
    }

    // {§packet-stored-shape} — assemble the system/user request before the
    // provider call; complete the same record with the provider response.
    async buildRequestPacket({
        initialMessages, requirements, workspaceId, workerId, loopId, currentTurnSeq, provider, gitStatus, notices = [],
        transientOpenLogEntryId = null,
    }: {
        initialMessages: ChatMessage[];
        // Optional requirements override. Empty in practice — callers don't thread it;
        // the engine sources Paths.defaultRequirements itself (a non-empty value wins).
        requirements: string;
        gitStatus: GitStatus | null;
        workspaceId: number; workerId: number; loopId: number;
        // DB-level turn sequence for "look at the previous turn" queries.
        currentTurnSeq: number;
        provider: Provider;
        // Model-facing observations queued by the engine before this packet
        // build. Operation failures never ride this path; they derive from the
        // durable log below.
        notices?: readonly Notice[];
        // One packet may project a durably folded row OPEN without mutating its
        // curation state ({§invalid-emission-attempts}).
        transientOpenLogEntryId?: number | null;
    }): Promise<RequestPacket> {
        const byRole = (role: ChatMessage["role"]): string =>
            initialMessages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        // plurnk.md (grammar/dialects) ONLY — the definition is the hot-path grammar.
        // The scheme catalogue is its own `schemes` section below tools ({§schemes-directory}),
        // NOT appended here: the language teaching is scheme-agnostic, so the service advertises
        // the installed scheme set at packet-time via SchemeRegistry.teach().
        const system_definition = compactDefinitionTables(byRole("system"));
        // The prompt section sources the loop's prompt:///<loop>/<N> entries.
        // Inject and turn-1 initialization write them. Bare callers that
        // bypass prompt persistence fall back to messages.user.
        const loopSeqRow = await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId });
        const promptPrefix = promptLoopPrefix(loopSeqRow?.sequence ?? loopId);
        const promptRows = (await this.#db.drain_get_all_prompt_bodies_for_loop.all<{ content: string; pathname: string }>({
            owner_id: workerId,
            pattern: `${promptPrefix}%`,
            prefix_len: promptPrefix.length,
        }))
            .filter((r) => typeof r.content === "string" && r.content.length > 0);
        // The section is a paths list (the errors shape - no bodies);
        // each prompt's content reaches the model through its actionless prompt row, and
        // prior prompts stay READable by the listed address - never silently lost, never an
        // unfair curation imposition. Fallback: callers that bypass persistence (bare messages)
        // still get their user text rendered directly.
        const prompt = promptRows.length > 0
            ? promptRows.map((r) => `* prompt://${r.pathname}`).join("\n")
            : byRole("user");
        // Requirements is engine-sourced, NOT threaded from callers — that threading is
        // exactly how it went missing (callers read the sysprompt but never the
        // requirements). Read Paths.defaultRequirements (PLURNK_SERVICE_REQUIREMENTS env →
        // requirements.md) fresh each build so edits take effect; a non-empty param wins.
        const baseRequirements = requirements.length > 0
            ? requirements
            : Paths.defaultRequirementsTeachingSource === null
                ? await readFile(Paths.defaultRequirements, "utf8")
                : await readTeachingSource(Paths.defaultRequirementsTeachingSource);
        // {§emission-admission}: the definition owns PLAN framing, so the packet
        // injects no duplicate syntax or plan directive.
        const log = await this.#buildLog(workerId, transientOpenLogEntryId);
        const failures = await this.buildFailurePointers(loopId, currentTurnSeq);
        const countTokens = rulerCount; // {§tokenomics-agnostic-ruler} — the ONE model-facing ruler (chars/2), not the provider
        // {§tools-loop-affinity}: teaching and dispatch resolve the same loop flags.
        const activeSchemes = this.#schemes.resolveForLoop(await LoopFlagsReader.read(this.#db, loopId));
        const tools = this.#collectTools(await this.#workspaceEnabled(workspaceId), await WorkspaceSettings.questionsEnabled(this.#db, workspaceId), activeSchemes);
        const ceiling = this.ceilingFor(provider);
        const budgetReadout = BudgetReadout.draft(ceiling);
        // The canonical default order, trust boundary, and cache-locality bias are
        // specified at {§packet-cache-monotone}. Budget placeholders resolve only
        // after trusted whole-list transforms establish the packet being measured.
        const inject = await readPacketInject(); // {§packet-inject} — per-turn; a broken configured path fails hard
        const workspaceRoot = (await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId }))?.project_root ?? null;
        const systemPolicy = await readSystemPolicy();              // ~/.plurnk/AGENTS.md (or PLURNK_SERVICE_POLICY)
        const projectPolicy = await readProjectPolicy(workspaceRoot); // <projectRoot>/AGENTS.md (or PLURNK_SERVICE_PROJECT)
        // Child-orientation ({§child-orientation}): the live things this worker holds — open streams +
        // unconcluded child workers — surfaced every turn as terse `* <status> <path>` pointers (same shape
        // as errors) just above the errors section. Orienting STATE so the model never loses track of
        // what it's holding (the premature-terminate trap), never advice on what to do. Empty → omitted.
        const childStreams = (await this.#db.engine_child_streams_open.all<{ scheme: string; pathname: string }>({ worker_id: workerId }))
            .map((s) => ({ status: "active", path: renderAddress(s.scheme, s.pathname) }));
        const childWorkers = (await this.#db.engine_child_workers_live.all<{ name: string; status: number }>({ worker_id: workerId }))
            .map((r) => ({ status: r.status, path: `worker://${r.name}` }));
        const defaults: PacketSectionDraft[] = [
            { name: "definition", slot: "system", header: null, content: system_definition },
            { name: "tools", slot: "system", header: "Registered Executable Tools", content: tools.executors },
            ...(tools.optionalOperations.length > 0
                ? [{ name: "optional-operations", slot: "system" as const, header: "Enabled Optional Operations", content: tools.optionalOperations }]
                : []),
            { name: "schemes", slot: "system", header: "Schemes", content: this.#schemes.teach() },
            ...(inject !== null ? [{ name: "inject", slot: "system" as const, header: "Operator Notes", content: inject }] : []),
            // policy: the client's privileged rules — ~/.plurnk/AGENTS.md (system) then <root>/AGENTS.md (project) — below grammar/tools/schemes, above budget-the-law. AGENTS is POLICY here, never a curatable READable entry. Empty content ⇒ section omitted.
            { name: "system-policy", slot: "system", header: "Policy", content: systemPolicy ?? "" },
            { name: "project-policy", slot: "system", header: "Project Policy", content: projectPolicy ?? "" },
            // The append-mostly log leads volatile user status ({§packet-cache-monotone}).
            { name: "log", slot: "user", header: "Log", content: PacketWire.renderLog(log, countTokens) },
            // The per-turn status clump sits between log and recap ({§packet-cache-monotone}).
            // child-orientation: what this worker holds live — streams then child workers — just above errors. Terse
            // pointers (the path is the actionable address the model READs/OPENs/KILLs), never advice. {§child-orientation}
            { name: "child-streams", slot: "user", header: "Child Streams", content: PacketWire.renderChildPointers(childStreams) },
            { name: "child-workers", slot: "user", header: "Active Child Workers", content: PacketWire.renderChildPointers(childWorkers) },
            { name: "errors", slot: "user", header: "Errors", content: PacketWire.renderFailurePointers(failures) },
            { name: "notices", slot: "user", header: "Notices", content: PacketWire.renderNotices(notices) },
            { name: "git", slot: "user", header: "Git Status", content: PacketWire.renderGit(gitStatus) },
            // budget — LAW (a hard ceiling the model must obey).
            { name: "budget", slot: "user", header: "Budget", content: budgetReadout },
            // The prompts section closes the status clump as a paths-only list;
            // bodies arrive through first-class prompt rows.
            { name: "prompt", slot: "user", header: "User Prompts", content: prompt },
            // requirements renders LAST — the user-slot footer, the syntax contract closest to the model's turn (a recency carve-out for weak models).
            { name: "requirements", slot: "user", header: "Recap", content: baseRequirements },
        ];
        // Plugin packet control ({§packet-assembly}): trusted schemes rewrite the
        // default list — add, remove, reorder — in-process, before measurement.
        let drafts = await this.#schemes.transformSections(defaults);
        const budgetSection = drafts.find((section) => section.name === "budget");
        if (budgetSection !== undefined && ceiling !== null) {
            const content = BudgetReadout.resolve(budgetSection.content, ceiling, (candidate) => {
                const candidateDrafts = drafts.map((section) =>
                    section === budgetSection ? { ...section, content: candidate } : section);
                return countTokens(PacketWire.renderSlot(candidateDrafts, "system"))
                    + countTokens(PacketWire.renderSlot(candidateDrafts, "user"));
            });
            drafts = drafts.map((section) => section === budgetSection ? { ...section, content } : section);
        }
        // Core alone turns validated drafts into measured durable sections.
        const sections = drafts.map((section): StoredPacketSection => ({
            ...section,
            tokens: countTokens(PacketWire.renderSection(section)),
        }));
        const packetTokens = countTokens(PacketWire.renderSlot(sections, "system")) + countTokens(PacketWire.renderSlot(sections, "user"));
        return { tokens: packetTokens, sections, attributions: [] };
    }

    // {§operator-config-workspace-execs} — the capability sheet and executor
    // documents share one workspace predicate with dispatch.
    async #workspaceEnabled(workspaceId: number): Promise<(tag: string) => boolean> {
        const { execs } = await WorkspaceSettings.read(this.#db, workspaceId);
        if (execs === null) return () => true;
        return (tag: string) => Policy.isEnabled(tag, execs);
    }

    // The ## Registered Executable Tools capability sheet. Each available executor
    // tag contributes its self-documenting example; the closed heading distinguishes
    // registered selectors from the open-ended general examples above it. {§tools-capability-sheet}
    #collectTools(
        workspaceEnabled: (tag: string) => boolean,
        questionsOn = false,
        activeSchemes?: Set<string>,
    ): { executors: string; optionalOperations: string } {
        // Registered executors and optional operations remain distinct fenced sheets.
        // {§tools-capability-sheet} {§packet-operation-fences}
        const executorOps: string[] = [];
        const notices: string[] = [];
        // {§send-300-choices} — the one-liner rides ONLY where questions are enabled (allowed +
        // client-requested); the fuller questions.md doc injects through docEntries the same way.
        const optionalOperations = questionsOn
            ? "```plurnk\n<<SEND[300]:Deploy where?;staging;production:SEND\n```"
            : "";
        const executors = this.#executors();
        if (executors !== undefined) {
            const excluded = docsExcludeSet();
            const runtimes = executors.availableRuntimes();
            // {§tools-capability-sheet} The sheet's lines are EXEC-usage examples, keyed on the 'exec' scheme
            // (the op face, excludedInAsk). When inactive, say so POSITIVELY (a prose notice): plurnk.md
            // still teaches EXEC as language, and silent absence measurably invites confabulated runtimes.
            const execActive = activeSchemes === undefined || activeSchemes.has("exec");
            if (runtimes.length > 0 && !execActive) {
                notices.push("EXEC operations are disabled for this loop — do not run commands; answer or advise directly");
            } else {
                for (const tag of runtimes) {
                    if (excluded.has(tag)) continue; // {§tools-capability-sheet} — exclude drops the example and doc
                    if (!workspaceEnabled(tag)) continue; // {§operator-config-workspace-execs}
                    const entry = executors.entry(tag);
                    // {§tools-capability-sheet} — the example is the bare op fenced below; the fuller doc
                    // materializes at worker://plurnk/docs/<tag>.md. No example → no line.
                    if (entry?.example) executorOps.push(entry.example);
                }
            }
        }
        const parts: string[] = [...notices];
        if (executorOps.length > 0) parts.push(`\`\`\`plurnk\n${executorOps.join("\n")}\n\`\`\``);
        return { executors: parts.join("\n\n"), optionalOperations };
    }

    // #note12 — the plugin-provided reference docs (schemes' + execs' `documentation`),
    // materialized at worker://plurnk/docs/<name>.md by LoopDocs (like operator
    // docs) so the catalog can expose each doc's token weight.
    async docEntries(workspaceId: number): Promise<Array<{ name: string; content: string }>> {
        const out = await this.#schemes.docs(); // scheme docs already drop PLURNK_SERVICE_DOCS_EXCLUDE names
        // {§send-300-choices} {§teaching-corpus} — the conditional teaching: questions.md
        // materializes ONLY for enabled workspaces — the same conditional-doc mechanism as the EXEC
        // plugin docs below. An un-enabled workspace is never taught the op it can't use.
        if (await WorkspaceSettings.questionsEnabled(this.#db, workspaceId)) {
            const q = await this.#schemes.questionsDoc();
            if (q.length > 0) out.push({ name: "questions", content: q });
        }
        const executors = this.#executors();
        if (executors !== undefined) {
            const excluded = docsExcludeSet();
            const workspaceEnabled = await this.#workspaceEnabled(workspaceId); // {§operator-config-workspace-execs}
            for (const tag of executors.availableRuntimes()) {
                if (excluded.has(tag)) continue; // {§tools-capability-sheet} — exec docs honor the same exclude
                if (!workspaceEnabled(tag)) continue;
                const doc = executors.entry(tag)?.documentation;
                if (doc !== undefined && doc.length > 0) out.push({ name: tag, content: doc });
            }
        }
        return out;
    }

    // SPEC {§grinder} — the budget grinder. Runs pre-LLM (in runTurn, after the packet
    // is built, before provider.generate); fires only on actual overflow. One rule:
    // fold the NEWEST turn boundary's open rows (errors exempt) — never history —
    // strike, rebuild, re-measure. Folds (never deletes). The strike it raises and
    // the hard-stop it can signal are returned to runLoop, which owns abandonment.
    // {§grinder-overflow-only} — fires only on actual overflow, never speculatively
    async enforceBudget({ packet, provider, workerId, loopId, turnId, mintSequence, rebuild }: {
        packet: RequestPacket; provider: Provider;
        workerId: number; loopId: number; turnId: number; mintSequence: number;
        rebuild: () => Promise<RequestPacket>;
    }): Promise<{ packet: RequestPacket; fit: boolean; struck: boolean; recorded: boolean }> {
        const ceiling = this.ceilingFor(provider);
        const measure = (p: RequestPacket): number => p.tokens;
        // {§tokenomics-window-unpollable-deliberate} — a null policy ceiling never triggers grinding. If a virtual ceiling
        // does trigger recovery while provider physics is unknown, physical admission
        // separately fails closed under {§tokenomics-physical-admission}.
        if (ceiling === null || measure(packet) <= ceiling) {
            return { packet, fit: true, struck: false, recorded: false };
        }

        // ONE rule, every turn — turn 1 and turn 101 alike ({§grinder-layer1-rollback}): fold the
        // NEWEST turn boundary's still-open rows (the prior turn's emissions + this turn's
        // pre-model rows; errors exempt) in one set-op, strike once, rebuild, re-measure.
        // The model owns history visibility. The grinder never reaches back; it folds only the
        // newest boundary required to produce a physically valid packet. Continued overflow
        // follows the explicit recovery/hard-stop contract ({§grinder-fold-strikes}).
        const usage = measure(packet);
        await this.#db.engine_grinder_fold_newest_turn({ loop_id: loopId, turn_id: turnId });
        let current = await rebuild();
        if (measure(current) > ceiling) {
            // Engine owns the hard-overflow branch and records its one occurrence with
            // the enforced recovery constraint (or terminal physics), so this layer does
            // not mint a second, weaker account of the same failure.
            return { packet: current, fit: false, struck: true, recorded: false };
        }

        // The fold recovered the request. Preserve the triggering measurements on one
        // actionless row and rebuild once so its Problem surfaces in this same packet.
        await this.#problems.record({
            workerId,
            loopId,
            turnId,
            sequence: mintSequence,
            origin: "plurnk",
            source: "rail",
            result: BudgetOverflow.foldedResult(usage, ceiling),
        });
        current = await rebuild();
        return {
            packet: current,
            fit: measure(current) <= ceiling,
            struck: true,
            recorded: true,
        };
    }

    // {§tokenomics-physical-admission}: one request-shaped physical predicate.
    // The exact PacketWire messages used for dispatch are the measurement input;
    // empirical estimates cannot authorize recovery against a hard window.
    async physicalAdmission(
        packet: RequestPacket,
        provider: Provider,
        signal?: AbortSignal,
    ): Promise<PhysicalPromptAdmission> {
        if (provider.contextWindow === null) {
            return {
                admitted: false,
                reason: "unknown_context_window",
                detail: `provider ${JSON.stringify(provider.model)} reports no physical context window`,
                capacity: null,
            };
        }
        const maxTokens = this.maxTokensFor(provider);
        if (maxTokens === null) {
            return {
                admitted: false,
                reason: "unknown_output_envelope",
                detail: `provider ${JSON.stringify(provider.model)} reports no resolved output envelope`,
                capacity: null,
            };
        }
        const capacity = provider.contextWindow - maxTokens;
        const measurement = assertPromptTokenMeasurement(
            await provider.countPromptTokens(
                PacketWire.packetToWireMessages(packet) as ChatMessage[],
                signal,
            ),
            `provider ${JSON.stringify(provider.model)}`,
        );
        if (measurement.kind === "estimate") {
            return {
                admitted: false,
                reason: "estimate",
                detail: `${measurement.source} is an empirical estimate and cannot authorize physical recovery: ${measurement.detail}`,
                capacity,
                measurement,
            };
        }
        if (measurement.tokens > capacity) {
            return {
                admitted: false,
                reason: "over_capacity",
                detail: `${measurement.kind} prompt measurement ${measurement.tokens} exceeds physical prompt capacity ${capacity}`,
                capacity,
                measurement,
            };
        }
        return { admitted: true, capacity, measurement };
    }

    // Every prior-turn operation failure is durable before packet assembly.
    // The model-facing Errors section is only a terse projection of those rows;
    // it never reconstructs failure truth from an in-memory event.
    async buildFailurePointers(loopId: number, currentTurnSeq: number): Promise<Array<{
        status: number;
        coordinate: string;
    }>> {
        const rows = await this.#db.engine_render_errors.all<{
            op: string; sequence: number; status_rx: number;
            turn_seq: number; loop_seq: number;
        }>({ loop_id: loopId, current_turn_seq: currentTurnSeq });
        return rows.map((r) => ({
            status: r.status_rx,
            coordinate: `${r.loop_seq}/${r.turn_seq}/${r.sequence}/${r.op}`,
        }));
    }

    // SPEC {§packet} the log section — chronological action-entries for the loop.
    // Snapshot is taken at packet build (pre-dispatch this turn), so it
    // reflects "what has happened before this turn." Each row carries a
    // log:///<loop_seq>/<turn_seq>/<sequence> coordinate the model can READ.
    async #buildLog(workerId: number, transientOpenLogEntryId: number | null): Promise<object[]> {
        // SPEC {§packet-terms}: workers own log entries — log is the worker's history,
        // not the loop's. Span all loops in the worker so the model sees
        // earlier loops' work as conversational memory.
        //
        // User prompts are first-class actionless log entries written by
        // runTurn. They surface naturally in this query without synthetic
        // EDIT/READ delivery rows.
        const rows = await this.#db.engine_render_log.all<{
            id: number; loop_seq: number; turn_seq: number; sequence: number;
            origin: string; op: string | null; suffix: string; signal: string | null;
            scheme: string | null; username: string | null; password: string | null;
            hostname: string | null; port: number | null; pathname: string | null;
            query: string | null; fragment: string | null;
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
                query: r.query,
                fragment: r.fragment,
            },
            status: r.status_rx,
            rx: r.mimetype_rx === "application/json" ? JSON.parse(r.rx) : r.rx,
            mimetype_rx: r.mimetype_rx,
            tx: r.mimetype_tx === "application/json" ? JSON.parse(r.tx) : r.tx,
            mimetype_tx: r.mimetype_tx,
            folded: r.expanded === 0 && r.id !== transientOpenLogEntryId,
            source: r.source,
            attrs: r.attrs === null ? null : JSON.parse(r.attrs),
        }));
    }
}
