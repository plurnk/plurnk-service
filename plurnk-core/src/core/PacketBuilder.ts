import type { Notice } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { GitStatus } from "./git-state.ts";
import WorkerName from "./WorkerName.ts";
import { generatedPathname, renderAddress, promptLoopPrefix } from "./plurnk-uri.ts";
import { contentWeight } from "./content-weight.ts";
import LoopPolicyReader from "./LoopPolicyReader.ts";
import CapabilityPolicies from "./CapabilityPolicies.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import { readPacketInject, readSystemPolicy } from "./packet-inject.ts";
import { readFile } from "node:fs/promises";
import Paths from "../Paths.ts";
import { readTeachingSource } from "./teaching-corpus.ts";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
import { acceptedKinds } from "./attachments.ts";
// Shared module imported by both Engine and bin/digest.ts, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire from "./packet-wire.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import type { RequestPacket, StoredPacketSection } from "./StoredPacket.ts";

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { ChatMessage, Provider } from "@plurnk/plurnk-providers";
import { scopeEnvToAlias, resolveActiveRoute } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import BudgetReadout from "./BudgetReadout.ts";
import TokenCalibration from "./TokenCalibration.ts";
import LineAnchors from "../content/line-anchors.ts";
import ToolResources from "./ToolResources.ts";
import LogVisibility from "./LogVisibility.ts";
import type { LogEntryDraft } from "./LogWriter.ts";

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

export type PacketLogDraft = LogEntryDraft & { readonly loop_seq: number; readonly turn_seq: number };

// Packet assembly ({§packet-assembly}) and model-facing budget admission
// ({§context-output-admission}). Deliberate curation stays in scoped KILL.
export default class PacketBuilder {

    #db: Db;
    // {§tokenomics-calibrated-readout} — admission and client gauges consume
    // the allowance captured before this request can change model evidence.
    readonly #curationBudgets = new WeakMap<readonly StoredPacketSection[], number | null>();
    readonly #streamObservations = new WeakMap<readonly StoredPacketSection[], readonly { publication_id: number; bytes: number }[]>();
    readonly #unadmittedOutput = new WeakMap<readonly StoredPacketSection[], readonly number[]>();
    #schemes: SchemeRegistry;
    // Boot-discovered runtime executors, late-injected on Engine after daemon
    // start() — read through a thunk so the post-construction set is visible.
    #executors: () => ExecutorRegistry | undefined;
    #capabilities: CapabilityResolver;
    // {§functionality-documents} — family-generated documents of a Worker's
    // published Functionality, reconciled with its other reference entries.
    #functionalityDocuments: (workspaceId: number) => Array<{ pathname: string; content: string }> = () => [];
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
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
        // Retired capacity knobs fail at boot rather than silently becoming inert.
        const bootAlias = resolveActiveRoute(process.env)?.alias ?? "";
        this.#shedRetiredCapacityKnobs();
        this.#promptProjectionFor(bootAlias);
    }

    setFunctionalityDocuments(documents: (workspaceId: number) => Array<{ pathname: string; content: string }>): void {
        this.#functionalityDocuments = documents;
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

    curationBudgetFor(packet: RequestPacket): number | null {
        const budget = this.#curationBudgets.get(packet.sections);
        if (budget === undefined) throw new Error("curationBudgetFor: the packet was not built by this PacketBuilder");
        return budget;
    }

    // {§packet-stored-shape} — assemble the system/user request before the
    // provider call; complete the same record with the provider response.
    async buildRequestPacket({
        initialMessages, recap = "", workspaceId, workerId, loopId, currentTurnSeq, provider, gitStatus, notices = [],
        transientOpenLogEntryId = null,
        promptProjection = "automatic",
        pendingLog = [],
        turnId = null,
    }: {
        initialMessages: ChatMessage[];
        // A non-empty caller value overrides the default Recap source.
        recap?: string;
        gitStatus: GitStatus | null;
        workspaceId: number; workerId: number; loopId: number;
        // DB-level turn sequence for "look at the previous turn" queries.
        currentTurnSeq: number;
        provider: Provider;
        // Model-facing observations queued by the engine before this packet
        // build. Operation failures never ride this path; they derive from the
        // durable log below.
        notices?: readonly Notice[];
        // One packet may expose a durably suppressed row without mutating its
        // curation state ({§invalid-emission-attempts}).
        transientOpenLogEntryId?: number | null;
        // Capacity recovery may withhold automatic prompt bodies while keeping
        // their complete prompt://<worker>/ entries addressable.
        promptProjection?: "automatic" | "withheld";
        pendingLog?: readonly PacketLogDraft[];
        turnId?: number | null;
    }): Promise<RequestPacket> {
        // {§loop-policy-effective-read} Validate active-loop policy before any
        // packet assembly or provider spend, independently of its presentation.
        await LoopPolicyReader.read(this.#db, loopId);
        await CapabilityPolicies.layers(this.#db, workspaceId);
        const byRole = (role: ChatMessage["role"]): string =>
            initialMessages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        // Resource references are discovered through Turn0, not injected. {§schemes-directory}
        const system_definition = compactDefinitionTables(byRole("system"));
        // The prompt section sources the loop's prompt://<worker>/<loop>/<id> entries.
        // Inject and turn-1 initialization write them. Bare callers that
        // bypass prompt persistence fall back to messages.user.
        const loopSeqRow = await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId });
        const workerName = await WorkerName.forId(this.#db, workerId);
        const promptPrefix = promptLoopPrefix(loopSeqRow?.sequence ?? loopId);
        const promptRows = (await this.#db.drain_get_all_prompt_bodies_for_loop.all<{ content: string; pathname: string }>({
            worker_id: workerId,
            pattern: `${promptPrefix}%`,
            prefix_len: promptPrefix.length,
        }))
            .filter((r) => typeof r.content === "string" && r.content.length > 0);
        // The section is a JSON array of prompt paths (the errors shape - no bodies);
        // each prompt's content reaches the model through its actionless prompt row, and
        // prior prompts stay READable by the listed address - never silently lost, never an
        // unfair curation imposition. Fallback: callers that bypass persistence (bare messages)
        // still get their user text rendered directly.
        const prompt = promptRows.length > 0
            ? `[${promptRows.map((r) => JSON.stringify(`prompt://${workerName}${r.pathname}`)).join(",\n")}]`
            : byRole("user");
        // {§recap}: a non-empty override wins; otherwise read the meta-owned source per packet.
        const recapContent = recap.length > 0
            ? recap
            : Paths.defaultRecapTeachingSource === null
                ? await readFile(Paths.defaultRecap, "utf8")
                : await readTeachingSource(Paths.defaultRecapTeachingSource);
        // {§emission-admission}: the definition remains the complete language authority.
        const log = await this.#buildLog(workerId, transientOpenLogEntryId, pendingLog, turnId);
        const failures = await this.buildFailurePointers(loopId, currentTurnSeq);
        const weighContent = contentWeight;
        const inputCapacity = provider.inputCapacity;
        const calibration = inputCapacity === null ? 1 : await TokenCalibration.forModel(this.#db, provider.model);
        const curationBudget = TokenCalibration.capacity(inputCapacity, calibration);
        // {§tokenomics-prompt-projection-share} — the cold-start allocation
        // preserves prompt bytes as rolling calibration changes the overall ceiling.
        const projectionBudget = TokenCalibration.capacity(inputCapacity);
        const alias = ProviderInstantiate.configurationAliasOf(provider) ?? "";
        const promptProjectionWeight = promptProjection === "withheld"
            ? 0
            : projectionBudget === null
                ? null
                : Math.floor(projectionBudget * this.#promptProjectionFor(alias));
        // {§output-allowance-notice}: the disclosed allowance is the program's
        // guaranteed room — the configured output floor less the reasoning subset —
        // never the wire grant: overflow is tolerated by the wire ({§provider-flexed-allowance},
        // #482), never invited by the packet (operator, 2026-09-01).
        const responseRoom = provider.outputBudget === null
            ? null
            : provider.outputBudget - (provider.reasoningBudget ?? 0);
        const budgetReadout = BudgetReadout.draft(curationBudget, responseRoom);
        // The canonical default order, trust boundary, and cache-locality bias are
        // specified at {§packet-cache-monotone}. Budget placeholders resolve only
        // after trusted whole-list transforms establish the packet being measured.
        const inject = await readPacketInject(); // {§packet-inject} — per-turn; a broken configured path fails hard
        const systemPolicy = await readSystemPolicy(); // XDG config AGENTS.md (or PLURNK_SERVICE_POLICY)
        // {§turn0-agents-stunt} — the PROJECT AGENTS.md rides turn 0 as a foisted
        // READ (LoopDocs → worker:///_plurnk/agents.md), not the system prompt.
        // Child-orientation ({§child-orientation}): the live things this worker holds — open streams +
        // unconcluded child workers — surfaced every turn as `{status, path}` JSON pointers (same shape
        // as errors) just above the errors section. Orienting STATE so the model never loses track of
        // what it's holding (the premature-terminate trap), never advice on what to do. Empty → omitted.
        const openChannels = await this.#db.engine_child_streams_open.all<{
            scheme: string; authority: string; pathname: string; publication_id: number; channel: string;
            lines: number; bytes: number; reported: number;
        }>({ worker_id: workerId });
        // {§exec-stream} — an active stream shows only its size and growth since the last packet.
        const childStreams = [...Map.groupBy(openChannels, (c) => renderAddress(c)).entries()].map(([path, channels]) => ({
            status: "active",
            path,
            detail: channels.map((c) => `${c.channel} ${c.lines} lines (+${Math.max(0, c.bytes - c.reported)} bytes)`).join("; "),
        }));
        const childWorkers = (await this.#db.engine_child_workers_live.all<{
            name: string; status: number; scheduled_tasks: string;
        }>({ worker_id: workerId })).map((r) => {
            const tasks = JSON.parse(r.scheduled_tasks) as Array<{
                id: number; scheduled_at: number; repeat_interval_ms: number | null;
            }>;
            return {
                status: r.status, path: `worker://${r.name}`,
                ...(tasks.length === 0 ? {} : { detail: tasks.map((task) =>
                    `task ${task.id}: ${new Date(task.scheduled_at).toISOString()}`
                    + (task.repeat_interval_ms === null ? "" : `, every ${task.repeat_interval_ms / 60_000} min`)).join("; ") }),
            };
        });
        // {§child-orientation} — a child is told whose child it is, so it can name the parent's
        // streams and space ({§worker-read-scope}, #394). Root workers have none → omitted.
        const parentRow = await this.#db.engine_parent_worker.get<{ name: string; status: number }>({ worker_id: workerId });
        const parentWorker = parentRow === undefined ? [] : [{ status: parentRow.status, path: `worker://${parentRow.name}` }];
        // {§fs-namespace} — the log renders working directories relative to the model's `/`.
        const workspaceRow = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const renderedLog = PacketWire.renderLogWithAccounting(
            log,
            weighContent,
            {
                projectRoot: workspaceRow?.project_root ?? null,
                acceptedAttachmentKinds: new Set(acceptedKinds(provider.inputModalities)),
                ...(promptProjectionWeight === null ? {} : { promptProjectionWeight }),
            },
        );
        const attachmentsWeight = renderedLog.attachments.reduce((sum, { weight }) => sum + weight, 0);
        const defaults: PacketSectionDraft[] = [
            { name: "definition", slot: "system", header: null, content: system_definition },
            // Stable privileged policy follows the definition for prefix-cache locality.
            { name: "system-policy", slot: "system", header: null, content: systemPolicy ?? "" },

            ...(inject !== null ? [{ name: "inject", slot: "system" as const, header: "Operator Notes", content: inject }] : []),
            { name: "worker", slot: "user", header: "Worker", content: JSON.stringify({ path: `worker://${workerName}` }) },
            // The append-mostly log leads volatile user status ({§packet-cache-monotone}).
            {
                name: "log",
                slot: "user",
                header: "Log",
                content: renderedLog.content,
            },
            // The per-turn status clump follows the log ({§packet-cache-monotone}).
            // child-orientation: what this worker holds live — streams then child workers — just above errors. Terse
            // pointers (the path is the actionable address the model READs or KILLs), never advice. {§child-orientation}
            { name: "child-streams", slot: "user", header: "Child Streams", content: PacketWire.renderChildPointers(childStreams) },
            { name: "child-workers", slot: "user", header: "Active Child Workers", content: PacketWire.renderChildPointers(childWorkers) },
            { name: "parent-worker", slot: "user", header: "Parent Worker", content: PacketWire.renderChildPointers(parentWorker) },
            { name: "errors", slot: "user", header: "Errors", content: PacketWire.renderFailurePointers(failures) },
            { name: "notices", slot: "user", header: "Notices", content: PacketWire.renderNotices(notices) },
            { name: "git", slot: "user", header: "Git Status", content: PacketWire.renderGit(gitStatus) },
            // Familiar token language is a deliberate final model projection;
            // internally this is curation weight, never provider admission.
            { name: "budget", slot: "user", header: "Context Curation", content: budgetReadout },
            // The prompts section closes the status clump as a paths-only list;
            // bodies arrive through first-class prompt rows.
            { name: "prompt", slot: "user", header: "Active Prompts", content: prompt },
            { name: "recap", slot: "user", header: "Recap", content: recapContent },
        ];
        // Plugin packet control ({§packet-assembly}): trusted schemes rewrite the
        // default list — add, remove, reorder — in-process, before measurement.
        let drafts = await this.#schemes.transformSections(defaults, workspaceId);
        const budgetSection = drafts.find((section) => section.name === "budget");
        if (budgetSection !== undefined && curationBudget !== null) {
            const transformedLog = drafts.find((section) => section.name === "log");
            const curationTargets = transformedLog?.content === renderedLog.content
                ? renderedLog.curationTargets
                : [];
            const content = BudgetReadout.resolve(budgetSection.content, curationBudget, (candidate) => {
                const candidateDrafts = drafts.map((section) =>
                    section === budgetSection ? { ...section, content: candidate } : section);
                return weighContent(PacketWire.renderSlot(candidateDrafts, "system"))
                    + weighContent(PacketWire.renderSlot(candidateDrafts, "user"))
                    + attachmentsWeight;
            }, curationTargets, renderedLog.newOverflow);
            drafts = drafts.map((section) => section === budgetSection ? { ...section, content } : section);
        }
        // Core alone turns validated drafts into measured durable sections.
        const sections = drafts.map((section): StoredPacketSection => ({
            ...section,
            weight: weighContent(PacketWire.renderSection(section)),
        }));
        const renderWeight = weighContent(PacketWire.renderSlot(sections, "system")) + weighContent(PacketWire.renderSlot(sections, "user"));
        // {§packet-attachment-parts} — pictures weigh in the packet like everything else it carries.
        const packet: RequestPacket = { weight: renderWeight + attachmentsWeight, sections, attributions: [], attachments: [...renderedLog.attachments] };
        this.#curationBudgets.set(packet.sections, curationBudget);
        this.#streamObservations.set(packet.sections, openChannels);
        this.#unadmittedOutput.set(packet.sections, renderedLog.unadmittedOutput);
        return packet;
    }

    // {§context-output-selection} — one statement commits the first-presentation
    // decision. Speculative packet builds never call this mutation boundary.
    async admitOutput(packet: RequestPacket, turnId: number): Promise<boolean> {
        const ids = this.#unadmittedOutput.get(packet.sections);
        if (ids === undefined) throw new Error("Cannot admit output from an unbuilt request packet.");
        if (ids.length === 0) return false;
        const withheld = this.curationOverflow(packet) !== null;
        const result = await this.#db.engine_admit_log_outputs.run({ ids: JSON.stringify(ids), turn_id: turnId, withheld: withheld ? 1 : 0 });
        if (result.changes !== ids.length) throw new Error("Log output admission changed during packet assembly.");
        return withheld;
    }

    async recordObservations(packet: RequestPacket): Promise<void> {
        const observations = this.#streamObservations.get(packet.sections);
        if (observations === undefined) throw new Error("Cannot acknowledge an unbuilt request packet.");
        for (const channel of observations) {
            await this.#db.engine_stream_reported.run({ publication_id: channel.publication_id, reported: channel.bytes });
        }
    }

    // {§schemes-self-doc-materialization} {§tools-resource-materialization} —
    // one reserved reference set, materialized by LoopDocs.
    async referenceEntries(workspaceId: number): Promise<Array<{ pathname: string; content: string }>> {
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId);
        const policies = layers.map((layer) => layer.policy);
        const out = (await this.#schemes.docs(workspaceId))
            .filter(({ name }) => this.#capabilities.allowsSchemeAcross(name, workspaceId, policies))
            .map(({ name, content }) => ({
                pathname: generatedPathname(`/plurnk/${name}.md`),
                content,
            }));
        const executors = this.#executors();
        if (executors !== undefined) {
            for (const tag of executors.availableRuntimes(workspaceId)) {
                const entry = executors.entry(tag, workspaceId);
                if (entry === undefined) continue;
                const registry = executors.toolRegistry(tag, workspaceId);
                const filteredRegistry = registry === null ? null : {
                    tools: registry.tools.filter((tool) =>
                        this.#capabilities.allowsRuntimeAcross(tag, tool.target, workspaceId, policies)),
                };
                if (registry === null) {
                    if (!this.#capabilities.allowsRuntimeAcross(tag, null, workspaceId, policies)) continue;
                } else if (filteredRegistry!.tools.length === 0) continue;
                out.push(...ToolResources.render({
                    runtime: tag,
                    summary: entry.summary,
                    invocation: entry.invocation,
                    details: entry.details,
                    registry: filteredRegistry,
                    ...(entry.resourcesPath === undefined ? {} : { resourcesPath: entry.resourcesPath }),
                }));
            }
        }
        out.push(...this.#functionalityDocuments(workspaceId));
        return out.toSorted((left, right) => left.pathname.localeCompare(right.pathname));
    }

    // {§context-output-admission} — measurement never mutates visibility.
    curationOverflow(packet: RequestPacket): CurationOverflow | null {
        const budget = this.curationBudgetFor(packet);
        if (budget === null) return null;
        const { weight } = packet;
        if (weight <= budget) return null;
        return { weight, budget, excess: weight - budget };
    }

    // Every prior-turn operation failure is durable before packet assembly.
    // The model-facing Errors section is only a terse projection of those rows;
    // it never reconstructs failure truth from an in-memory event.
    async buildFailurePointers(loopId: number, currentTurnSeq: number): Promise<Array<{
        status: number;
        coordinate: string;
    }>> {
        const rows = await this.#db.engine_render_errors.all<{
            origin: string; op: string; attrs: string; tx: string; sequence: number; status_rx: number;
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
    async #buildLog(workerId: number, transientOpenLogEntryId: number | null, pendingLog: readonly PacketLogDraft[], turnId: number | null): Promise<object[]> {
        // SPEC {§packet-terms}: workers own log entries — log is the worker's history,
        // not the loop's. Span all loops in the worker so the model sees
        // earlier loops' work as conversational memory.
        //
        // User prompts are first-class actionless log entries written by
        // runTurn. They surface naturally in this query without synthetic
        // EDIT/READ delivery rows.
        const rows = await this.#db.engine_render_log.all<{
            id: number; loop_seq: number; turn_seq: number; sequence: number;
            origin: string; op: string | null; signal: string | null;
            scheme: string | null; username: string | null; password: string | null;
            hostname: string | null; port: number | null; pathname: string | null;
            query: string | null; fragment: string | null;
            status_rx: number; rx: string; mimetype_rx: string;
            output_admission_turn_id: number | null; output_withheld: number;
            tx: string; mimetype_tx: string; initial_folded: string; folded: string; source: string | null; attrs: string | null;
        }>({ worker_id: workerId });
        return [...rows, ...pendingLog.map((row) => ({ ...row, folded: "[]", id: null, output_admission_turn_id: null, output_withheld: 0 }))].map((r) => {
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
            if ((rawLineAnchors === undefined) !== (rawLineNumberWidth === undefined)) {
                throw new TypeError("A READ result's lineAnchors and lineNumberWidth fields must appear together.");
            }
            const lineNumberWidth = rawLineNumberWidth;
            return {
                id: r.id,
                output_admission_turn_id: r.output_admission_turn_id,
                output_withheld: r.output_withheld === 1,
                newOverflow: turnId !== null && r.output_admission_turn_id === turnId,
                coordinate: `${r.loop_seq}/${r.turn_seq}/${r.sequence}`,
                origin: r.origin,
                op: r.op,
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
                initial_folded: r.id === transientOpenLogEntryId ? LogVisibility.OPEN : LogVisibility.parse(r.initial_folded),
                folded: LogVisibility.parse(r.folded),
                source: r.source,
                attrs: r.attrs === null ? null : JSON.parse(r.attrs),
                ...(lineAnchors === undefined ? {} : { lineAnchors }),
                ...(lineNumberWidth === undefined ? {} : { lineNumberWidth }),
            };
        });
    }
}
