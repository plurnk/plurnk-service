import type { Notice } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { GitStatus } from "./git-state.ts";
import { renderAddress, promptLoopPrefix } from "./plurnk-uri.ts";
import { contentWeight } from "./content-weight.ts";
import { Policy } from "@plurnk/plurnk-execs";
import WorkspaceSettings from "./workspace-settings.ts";
import LoopFlagsReader from "./LoopFlagsReader.ts";
import { readPacketInject, readSystemPolicy } from "./packet-inject.ts";
import { readFile } from "node:fs/promises";
import Paths from "../Paths.ts";
import { readTeachingSource } from "./teaching-corpus.ts";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import type { RequestPacket, StoredPacketSection } from "./StoredPacket.ts";

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { ChatMessage, Provider } from "@plurnk/plurnk-providers";
import { scopeEnvToAlias, resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import BudgetReadout from "./BudgetReadout.ts";
import LineAnchors from "../content/line-anchors.ts";
import ToolResources from "./ToolResources.ts";
import LogVisibility from "./LogVisibility.ts";
import LogBody from "./LogBody.ts";

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

// {§tokenomics-prompt-projection-share} — the required alias-scoped share of
// provider-derived input capacity used only for automatic prompt projection.
const readRequiredPercentFrom = (env: NodeJS.ProcessEnv, name: string): number => {
    const raw = env[name];
    const match = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(raw ?? "");
    const percent = Number(match?.[1]);
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
        throw new Error(`${name} must be a percentage in (0, 100); got ${JSON.stringify(raw)}`);
    }
    return percent / 100;
};

export type { ChatMessage } from "@plurnk/plurnk-providers";

export interface CurationOverflow {
    readonly weight: number;
    readonly budget: number;
    readonly excess: number;
}

// Packet assembly (SPEC {§packet-assembly}) + the budget grinder ({§grinder}):
// builds the spec'd request packet, measures it, and reclaims window on overflow.
export default class PacketBuilder {

    #db: Db;
    #schemes: SchemeRegistry;
    // Boot-discovered runtime executors, late-injected on Engine after daemon
    // start() — read through a thunk so the post-construction set is visible.
    #executors: () => ExecutorRegistry | undefined;
    // {§tokenomics-prompt-projection-share} — prompt projection is alias-scoped
    // through the same environment contract as provider configuration.

    constructor({ db, schemes, executors }: {
        db: Db;
        schemes: SchemeRegistry;
        executors: () => ExecutorRegistry | undefined;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#executors = executors;
        // Retired capacity knobs fail at boot rather than silently becoming inert.
        const bootAlias = resolveActiveAlias(process.env)?.alias ?? "";
        this.#shedRetiredCapacityKnobs();
        this.#promptProjectionFor(bootAlias);
    }

    // Prompt projection is Core policy, scoped through the same alias contract as providers.
    static #KNOBS = ["PLURNK_SERVICE_PROMPT_PROJECTION"] as const;

    #shedRetiredCapacityKnobs(): void {
        const retired: Record<string, string> = {
            PLURNK_SERVICE_PROMPT_BUDGET: "provider input capacity is derived from context and output budgets",
            PLURNK_SERVICE_SAFETY: "provider request-shaped capacity admission owns physical headroom",
        };
        for (const key of Object.keys(process.env)) {
            const match = /^(PLURNK_SERVICE_PROMPT_BUDGET|PLURNK_SERVICE_SAFETY)(?:_.*)?$/u.exec(key);
            const reason = match === null ? undefined : retired[match[1]!];
            if (reason !== undefined) throw new Error(`${key} is retired: ${reason}.`);
        }
        const moved: Record<string, string> = {
            CTX: "PLURNK_PROVIDERS_CONTEXT_WINDOW",
            CONTEXT_WINDOW: "PLURNK_PROVIDERS_CONTEXT_WINDOW",
            REASONING: "PLURNK_PROVIDERS_REASONING_BUDGET",
            ASSISTANT: "PLURNK_PROVIDERS_OUTPUT_BUDGET",
            COMPLETION: "PLURNK_PROVIDERS_OUTPUT_BUDGET",
        };
        for (const key of Object.keys(process.env)) {
            const match = /^PLURNK_SERVICE_(CTX|CONTEXT_WINDOW|REASONING|ASSISTANT|COMPLETION)(_.*)?$/u.exec(key);
            if (match !== null) throw new Error(`${key} is retired: the provider-owned knob is ${moved[match[1]!]}${match[2] ?? ""}.`);
        }
    }

    #promptProjectionFor(alias: string): number {
        const view = scopeEnvToAlias(process.env, alias, PacketBuilder.#KNOBS);
        return readRequiredPercentFrom(view, "PLURNK_SERVICE_PROMPT_PROJECTION");
    }

    curationBudgetFor(provider: Provider): number | null {
        return provider.inputCapacity;
    }

    // {§packet-stored-shape} — assemble the system/user request before the
    // provider call; complete the same record with the provider response.
    async buildRequestPacket({
        initialMessages, requirements = "", workspaceId, workerId, loopId, currentTurnSeq, provider, gitStatus, notices = [],
        transientOpenLogEntryId = null,
        promptProjection = "automatic",
    }: {
        initialMessages: ChatMessage[];
        // A non-empty caller value overrides the default Recap source.
        requirements?: string;
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
        // Capacity recovery may withhold automatic prompt bodies while keeping
        // their complete prompt:/// entries addressable.
        promptProjection?: "automatic" | "withheld";
    }): Promise<RequestPacket> {
        // {§loop-flags-effective-read} Validate active-loop policy before any
        // packet assembly or provider spend, independently of its presentation.
        await LoopFlagsReader.read(this.#db, loopId);
        const byRole = (role: ChatMessage["role"]): string =>
            initialMessages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        // plurnk.md (grammar/dialects) ONLY — the definition is the hot-path grammar.
        // The resource catalogue is its own `schemes` section ({§schemes-directory}),
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
        // {§requirements}: a non-empty override wins; otherwise read the meta-owned source per packet.
        const recap = requirements.length > 0
            ? requirements
            : Paths.defaultRequirementsTeachingSource === null
                ? await readFile(Paths.defaultRequirements, "utf8")
                : await readTeachingSource(Paths.defaultRequirementsTeachingSource);
        // {§emission-admission}: the definition remains the complete language authority.
        const log = await this.#buildLog(workerId, transientOpenLogEntryId);
        const failures = await this.buildFailurePointers(loopId, currentTurnSeq);
        const weighContent = contentWeight;
        const curationBudget = this.curationBudgetFor(provider);
        const alias = ProviderInstantiate.aliasOf(provider) ?? resolveActiveAlias(process.env)?.alias ?? "";
        const promptProjectionWeight = promptProjection === "withheld"
            ? 0
            : curationBudget === null
                ? null
                : Math.floor(curationBudget * this.#promptProjectionFor(alias));
        const budgetReadout = BudgetReadout.draft(curationBudget);
        // The canonical default order, trust boundary, and cache-locality bias are
        // specified at {§packet-cache-monotone}. Budget placeholders resolve only
        // after trusted whole-list transforms establish the packet being measured.
        const inject = await readPacketInject(); // {§packet-inject} — per-turn; a broken configured path fails hard
        const systemPolicy = await readSystemPolicy(); // ~/.plurnk/AGENTS.md (or PLURNK_SERVICE_POLICY)
        // {§turn0-agents-stunt} — the PROJECT AGENTS.md rides turn 0 as a foisted
        // READ (LoopDocs → worker://plurnk/agents.md), not the system prompt.
        // {§packet-git-status}/{§worker-branch-batch-return} — only the direct,
        // currently running branch-batch child receives the transaction's
        // commit-and-clean return condition. Ordinary Git state remains purely
        // descriptive for every other worker.
        const branchAssignment = await this.#db.branch_batch_active_for_worker.get<{ branch: string }>({ worker_id: workerId });
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
            // Stable privileged policy leads capability teaching for
            // prefix-cache locality. Empty policy sections simply disappear.
            { name: "system-policy", slot: "system", header: "Policy", content: systemPolicy ?? "" },

            { name: "schemes", slot: "system", header: "Resources", content: this.#schemes.teach(workspaceId) },
            ...(inject !== null ? [{ name: "inject", slot: "system" as const, header: "Operator Notes", content: inject }] : []),
            // The append-mostly log leads volatile user status ({§packet-cache-monotone}).
            {
                name: "log",
                slot: "user",
                header: "Log",
                content: PacketWire.renderLog(
                    log,
                    weighContent,
                    promptProjectionWeight === null ? {} : { promptProjectionWeight },
                ),
            },
            // The per-turn status clump follows the log ({§packet-cache-monotone}).
            // child-orientation: what this worker holds live — streams then child workers — just above errors. Terse
            // pointers (the path is the actionable address the model READs/OPENs/KILLs), never advice. {§child-orientation}
            { name: "child-streams", slot: "user", header: "Child Streams", content: PacketWire.renderChildPointers(childStreams) },
            { name: "child-workers", slot: "user", header: "Active Child Workers", content: PacketWire.renderChildPointers(childWorkers) },
            { name: "errors", slot: "user", header: "Errors", content: PacketWire.renderFailurePointers(failures) },
            { name: "notices", slot: "user", header: "Notices", content: PacketWire.renderNotices(notices) },
            { name: "git", slot: "user", header: "Git Status", content: PacketWire.renderGit(gitStatus, branchAssignment?.branch ?? null) },
            // Familiar token language is a deliberate final model projection;
            // internally this is curation weight, never provider admission.
            { name: "budget", slot: "user", header: "Budget", content: budgetReadout },
            // The prompts section closes the status clump as a paths-only list;
            // bodies arrive through first-class prompt rows.
            { name: "prompt", slot: "user", header: "Active User Prompts", content: prompt },
            { name: "requirements", slot: "user", header: "Recap", content: recap },
        ];
        // Plugin packet control ({§packet-assembly}): trusted schemes rewrite the
        // default list — add, remove, reorder — in-process, before measurement.
        let drafts = await this.#schemes.transformSections(defaults, workspaceId);
        const budgetSection = drafts.find((section) => section.name === "budget");
        if (budgetSection !== undefined && curationBudget !== null) {
            const content = BudgetReadout.resolve(budgetSection.content, curationBudget, (candidate) => {
                const candidateDrafts = drafts.map((section) =>
                    section === budgetSection ? { ...section, content: candidate } : section);
                return weighContent(PacketWire.renderSlot(candidateDrafts, "system"))
                    + weighContent(PacketWire.renderSlot(candidateDrafts, "user"));
            });
            drafts = drafts.map((section) => section === budgetSection ? { ...section, content } : section);
        }
        // Core alone turns validated drafts into measured durable sections.
        const sections = drafts.map((section): StoredPacketSection => ({
            ...section,
            weight: weighContent(PacketWire.renderSection(section)),
        }));
        const renderWeight = weighContent(PacketWire.renderSlot(sections, "system")) + weighContent(PacketWire.renderSlot(sections, "user"));
        return { weight: renderWeight, sections, attributions: [] };
    }

    // {§operator-config-workspace-execs} — tool resources and dispatch share one
    // workspace predicate.
    async #workspaceEnabled(workspaceId: number): Promise<(tag: string) => boolean> {
        const { execs } = await WorkspaceSettings.read(this.#db, workspaceId);
        if (execs === null) return () => true;
        return (tag: string) => Policy.isEnabled(tag, execs);
    }

    // {§schemes-self-doc-materialization} {§tools-resource-materialization} —
    // one reserved reference set, materialized by LoopDocs.
    async referenceEntries(workspaceId: number): Promise<Array<{ pathname: string; content: string }>> {
        const out = (await this.#schemes.docs(workspaceId)).map(({ name, content }) => ({
            pathname: `/skills/plurnk/${name}.md`,
            content,
        }));
        const executors = this.#executors();
        if (executors !== undefined) {
            const workspaceEnabled = await this.#workspaceEnabled(workspaceId); // {§operator-config-workspace-execs}
            for (const tag of executors.availableRuntimes(workspaceId)) {
                if (!workspaceEnabled(tag)) continue;
                const entry = executors.entry(tag, workspaceId);
                if (entry === undefined) continue;
                out.push(...ToolResources.render({
                    runtime: tag,
                    summary: entry.summary,
                    invocation: entry.invocation,
                    details: entry.details,
                    registry: executors.toolRegistry(tag, workspaceId),
                    ...(entry.resourcesPath === undefined ? {} : { resourcesPath: entry.resourcesPath }),
                }));
            }
        }
        return out.toSorted((left, right) => left.pathname.localeCompare(right.pathname));
    }

    // SPEC {§grinder} — the budget grinder. Runs pre-LLM (in runTurn, after the packet
    // is built, before provider.generate); fires only when curation weight exceeds
    // the provider-derived curation budget. One
    // reversible rule: roll back context introduced by the NEWEST turn boundary —
    // rows born there plus exact older rows it transitioned folded→open — then
    // rebuild and re-measure.
    // {§grinder-overflow-only} — fires only on actual overflow, never speculatively
    async enforceBudget({ packet, provider, loopId, turnId, recordOverflow, rebuild }: {
        packet: RequestPacket; provider: Provider;
        loopId: number; turnId: number;
        recordOverflow: (overflow: CurationOverflow) => Promise<void>;
        rebuild: () => Promise<RequestPacket>;
    }): Promise<{ packet: RequestPacket; fit: boolean; boundaryRolledBack: boolean }> {
        const budget = this.curationBudgetFor(provider);
        const measure = (p: RequestPacket): number => p.weight;
        if (budget === null || measure(packet) <= budget) {
            return { packet, fit: true, boundaryRolledBack: false };
        }

        const weight = measure(packet);
        await recordOverflow({ weight, budget, excess: weight - budget });

        // ONE rule, every turn ({§grinder-layer1-rollback}): atomically fold/tag
        // context introduced by the newest boundary. Other older history remains
        // model-owned; remaining curation debt is neither failure nor strike.
        await this.#rollbackNewestBoundary(loopId, turnId);
        const current = await rebuild();
        return { packet: current, fit: measure(current) <= budget, boundaryRolledBack: true };
    }

    async rollbackNewestBoundary(loopId: number, turnId: number): Promise<void> {
        await this.#rollbackNewestBoundary(loopId, turnId);
    }

    async #rollbackNewestBoundary(loopId: number, turnId: number): Promise<void> {
        type PlannedTarget = {
            readonly id: number;
            readonly before: ReturnType<typeof LogVisibility.parse>;
            after: ReturnType<typeof LogVisibility.parse>;
        };
        const plan = new Map<number, PlannedTarget>();
        const boundary = await this.#db.engine_grinder_boundary_rows.all<{
            id: number;
            op: string | null;
            attrs: string;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
            folded: string;
        }>({ loop_id: loopId, turn_id: turnId });
        for (const row of boundary) {
            const before = LogVisibility.parse(row.folded);
            const body = LogBody.resolve({
                op: row.op,
                attrs: row.attrs,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            });
            const after = LogVisibility.apply(
                before,
                "FOLD",
                [1, -1],
                LogVisibility.lineCount(body.content),
            );
            if (!LogVisibility.equal(before, after)) {
                plan.set(row.id, { id: row.id, before, after });
            }
        }

        const effects = await this.#db.engine_grinder_open_effects.all<{
            id: number;
            folded: string;
            folded_before: string;
            folded_after: string;
        }>({ loop_id: loopId, turn_id: turnId });
        for (const effect of effects) {
            const opened = LogVisibility.openedBy(
                LogVisibility.parse(effect.folded_before),
                LogVisibility.parse(effect.folded_after),
            );
            if (opened.length === 0) continue;
            const existing = plan.get(effect.id);
            if (existing !== undefined) {
                existing.after = LogVisibility.fold(existing.after, opened);
                continue;
            }
            const before = LogVisibility.parse(effect.folded);
            const after = LogVisibility.fold(before, opened);
            if (!LogVisibility.equal(before, after)) {
                plan.set(effect.id, { id: effect.id, before, after });
            }
        }
        await this.#db.engine_grinder_apply({
            targets: JSON.stringify([...plan.values()]),
        });
    }

    // Every prior-turn operation failure is durable before packet assembly.
    // The model-facing Errors section is only a terse projection of those rows;
    // it never reconstructs failure truth from an in-memory event.
    async buildFailurePointers(loopId: number, currentTurnSeq: number): Promise<Array<{
        status: number;
        coordinate: string;
    }>> {
        const rows = await this.#db.engine_render_errors.all<{
            origin: string; op: string; attrs: string; sequence: number; status_rx: number;
            turn_seq: number; loop_seq: number;
        }>({ loop_id: loopId, current_turn_seq: currentTurnSeq });
        return rows.map((r) => ({
            status: r.status_rx,
            coordinate: LogEntryProjection.coordinate(`${r.loop_seq}/${r.turn_seq}/${r.sequence}`, r),
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
            origin: string; op: string | null; delimiter: string; signal: string | null;
            scheme: string | null; username: string | null; password: string | null;
            hostname: string | null; port: number | null; pathname: string | null;
            query: string | null; fragment: string | null;
            status_rx: number; rx: string; mimetype_rx: string;
            tx: string; mimetype_tx: string; folded: string; source: string | null; attrs: string | null;
            tags: string;
        }>({ worker_id: workerId });
        return rows.map((r) => {
            const tx = r.mimetype_tx === "application/json" ? JSON.parse(r.tx) as unknown : r.tx;
            const rx = r.mimetype_rx === "application/json" ? JSON.parse(r.rx) as unknown : r.rx;
            const rawLineAnchors = LogEntryProjection.op(r) === "READ"
                && r.status_rx === 200
                && rx !== null
                && typeof rx === "object"
                && Object.hasOwn(rx, "lineAnchors")
                ? (rx as { lineAnchors: unknown }).lineAnchors
                : undefined;
            if (rawLineAnchors !== undefined && !Array.isArray(rawLineAnchors)) {
                throw new TypeError("A READ result's lineAnchors field must be an array.");
            }
            const lineAnchors = rawLineAnchors as readonly string[] | undefined;
            const rawLineNumberWidth = LogEntryProjection.op(r) === "READ"
                && r.status_rx === 200
                && rx !== null
                && typeof rx === "object"
                && Object.hasOwn(rx, "lineNumberWidth")
                ? (rx as { lineNumberWidth: unknown }).lineNumberWidth
                : undefined;
            if (
                rawLineNumberWidth !== undefined
                && !LineAnchors.isLineNumberWidth(rawLineNumberWidth)
            ) {
                throw new TypeError("A READ result's lineNumberWidth field must be a valid decimal line width.");
            }
            if ((lineAnchors === undefined) !== (rawLineNumberWidth === undefined)) {
                throw new TypeError("A READ result's lineAnchors and lineNumberWidth fields must appear together.");
            }
            const lineNumberWidth = rawLineNumberWidth;
            return {
                coordinate: `${r.loop_seq}/${r.turn_seq}/${r.sequence}`,
                origin: r.origin,
                op: r.op,
                delimiter: r.delimiter,
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
                rx,
                mimetype_rx: r.mimetype_rx,
                tx,
                mimetype_tx: r.mimetype_tx,
                folded: r.id === transientOpenLogEntryId
                    ? LogVisibility.OPEN
                    : LogVisibility.parse(r.folded),
                source: r.source,
                attrs: r.attrs === null ? null : JSON.parse(r.attrs),
                tags: JSON.parse(r.tags),
                ...(lineAnchors === undefined ? {} : { lineAnchors }),
                ...(lineNumberWidth === undefined ? {} : { lineNumberWidth }),
            };
        });
    }
}
