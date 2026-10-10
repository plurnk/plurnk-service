import type { Notice } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { GitStatus } from "./git-state.ts";
import WorkerName from "./WorkerName.ts";
import { generatedPathname, renderAddress } from "./plurnk-uri.ts";
import { contentWeight } from "./content-weight.ts";
import CapabilityPolicies from "./CapabilityPolicies.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import { readPacketInject, readSystemPolicy } from "./packet-inject.ts";
import { readFile } from "node:fs/promises";
import Paths from "../Paths.ts";
import { readTeachingSource } from "./teaching-corpus.ts";
import { recapLines } from "./recap-lines.ts";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
import { acceptedKinds } from "./attachments.ts";
// Shared module imported by both Engine and the digest, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire, { type BodiedLogRow, type StoredLogRow } from "./packet-wire.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import type { PacketAttachment, RequestPacket, StoredPacketSection } from "./StoredPacket.ts";

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import type { ChatMessage, Provider, ProviderRequestCapacity } from "@plurnk/plurnk-providers";
import BudgetReadout from "./BudgetReadout.ts";
import TokenCalibration from "./TokenCalibration.ts";
import ToolResources from "./ToolResources.ts";
import TurnOps from "./TurnOps.ts";

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

export type { ChatMessage } from "@plurnk/plurnk-providers";

// {§context-wall} — the packet's tokens against the provider's input wall, in provider tokens, by either
// measure ({§context-wall-measure}), and the curation weight the packet must shed to fit it ({§context-own-rows-fit}).
export interface WindowOverflow {
    readonly tokens: number;
    readonly budget: number | null;
    readonly wall: number;
    readonly excess: number;
    readonly excessWeight: number;
}

export interface CurationOverflow {
    readonly weight: number;
    readonly budget: number;
    readonly excess: number;
}

// Packet assembly ({§packet-assembly}) and the budget and wall measures ({§context-over-budget-row}, {§context-wall}). Deliberate
// curation stays in scoped KILL; what fits was decided where each row landed ({§context-fit}).
export default class PacketBuilder {
    #db: Db;
    // {§tokenomics-calibrated-readout} — admission and client gauges consume the allowance and the factor
    // captured before this request can change model evidence.
    readonly #allowances = new WeakMap<readonly StoredPacketSection[], { readonly budget: number | null; readonly factor: number }>();
    // {§context-own-rows-fit} — the rows of each built packet the wall may still take, newest last.
    readonly #bodiedRows = new WeakMap<readonly StoredPacketSection[], readonly BodiedLogRow[]>();
    readonly #streamObservations = new WeakMap<readonly StoredPacketSection[], readonly { publication_id: number; bytes: number }[]>();
    #schemes: SchemeRegistry;
    // Boot-discovered runtime executors, late-injected on Engine after daemon
    // start() — read through a thunk so the post-construction set is visible.
    #executors: () => ExecutorRegistry | undefined;
    #capabilities: CapabilityResolver;
    // {§functionality-documents} — family-generated documents of a Worker's
    // published Functionality, reconciled with its other reference entries.
    #functionalityDocuments: (workspaceId: number) => Array<{ family: string; pathname: string; content: string }> = () => [];

    constructor({ db, schemes, executors }: {
        db: Db;
        schemes: SchemeRegistry;
        executors: () => ExecutorRegistry | undefined;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#executors = executors;
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
    }

    setFunctionalityDocuments(documents: (workspaceId: number) => Array<{ family: string; pathname: string; content: string }>): void {
        this.#functionalityDocuments = documents;
    }

    curationBudgetFor(packet: RequestPacket): number | null {
        return this.#allowanceOf(packet).budget;
    }

    #allowanceOf(packet: RequestPacket): { readonly budget: number | null; readonly factor: number } {
        const allowance = this.#allowances.get(packet.sections);
        if (allowance === undefined) throw new Error("the packet was not built by this PacketBuilder");
        return allowance;
    }

    // {§context-own-rows-fit} — the packet's rows still carrying a body or a native part, in row order.
    bodiedRowsOf(packet: RequestPacket): readonly BodiedLogRow[] {
        const rows = this.#bodiedRows.get(packet.sections);
        if (rows === undefined) throw new Error("bodiedRowsOf: the packet was not built by this PacketBuilder");
        return rows;
    }

    // {§packet-stored-shape} — assemble the system/user request before the
    // provider call; complete the same record with the provider response.
    async buildRequestPacket({
        initialMessages, recap = "", workspaceId, workerId, loopId, currentTurnSeq, provider, gitStatus, notices = [],
        transientOpenLogEntryId = null,
        turnId = null,
        bodiless,
        omitEmissionHistory = false,
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
        turnId?: number | null;
        // {§context-own-rows-fit} — the rows the wall has taken for this packet, by log entry id.
        bodiless?: ReadonlySet<number>;
        // {§emission-history} — omitted whole before the wall takes any result bodies.
        omitEmissionHistory?: boolean;
    }): Promise<RequestPacket> {
        await CapabilityPolicies.layers(this.#db, workspaceId);
        const byRole = (role: ChatMessage["role"]): string =>
            initialMessages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        // Resource references are discovered through Turn0, not injected. {§schemes-directory}
        const system_definition = compactDefinitionTables(byRole("system"));
        const loopSeqRow = await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId });
        const workerName = await WorkerName.forId(this.#db, workerId);
        // {§message-arrival}: source addresses survive curation of their log observations.
        const openMessages = await this.#db.engine_open_messages.all<{
            id: number; path: string; key_path: string; source: string | null;
        }>({ loop_id: loopId });
        // {§message-short-identity}: the model is shown the short address, never a client's own
        // transport identity; answering either reaches the same message. The operator's message has
        // no other sender to show, so it is named ({§message-causal-source}).
        const prompt = openMessages.length > 0
            ? `[${openMessages.map((m) => JSON.stringify({
                path: m.key_path,
                ...(m.source === null ? { origin: "user" } : { source: m.source }),
            })).join(",\n")}]`
            : "[]";
        // {§recap}: a non-empty override wins; otherwise read the meta-owned source per packet. The operator's
        // recap lines lead it ({§recap-lines}).
        const recapSource = recap.length > 0
            ? recap
            : Paths.defaultRecapTeachingSource === null
                ? await readFile(Paths.defaultRecap, "utf8")
                : await readTeachingSource(Paths.defaultRecapTeachingSource);
        const recapContent = PacketWire.renderRecap(recapLines(), recapSource);
        // {§emission-admission}: the definition remains the complete language authority.
        const log = await this.#buildLog(workerId, transientOpenLogEntryId, turnId);
        const failures = await this.buildFailurePointers(loopId, currentTurnSeq);
        const weighContent = contentWeight;
        // {§context-budget} — one room: the provider's input capacity in curation weight, bounding the
        // whole packet. Nothing here sizes a part of it.
        const inputCapacity = provider.inputCapacity;
        const factor = inputCapacity === null ? 1 : await TokenCalibration.forModel(this.#db, provider.model);
        const curationBudget = TokenCalibration.capacity(inputCapacity, factor);
        const budgetReadout = BudgetReadout.draft(curationBudget);
        // The canonical default order, trust boundary, and cache-locality bias are
        // specified at {§packet-cache-monotone}. Budget placeholders resolve only
        // after trusted whole-list transforms establish the packet being measured.
        const inject = await readPacketInject(); // {§packet-inject} — per-turn; a broken configured path fails hard
        const systemPolicy = await readSystemPolicy(); // XDG config AGENTS.md (or PLURNK_SERVICE_POLICY)
        // {§turn0-agents-stunt} — the PROJECT AGENTS.md rides turn 0 as a foisted
        // READ (LoopDocs → worker:///_plurnk/AGENTS.md), not the system prompt.
        // Child-orientation ({§child-orientation}): the live things this worker holds — open streams +
        // unconcluded child workers — surfaced every turn as `{status, path}` JSON pointers (same shape
        // as errors) just above the errors section. Orienting STATE so the model never loses track of
        // what it's holding (the premature-terminate trap), never advice on what to do. These two
        // sections always render, `[]` when empty: the model decides wait-or-complete on them, so
        // emptiness is stated rather than inferred from a missing heading ({§packet-empty-sections}).
        const openChannels = await this.#db.engine_child_streams_open.all<{
            scheme: string; authority: string; pathname: string; publication_id: number; channel: string;
            lines: number; bytes: number; reported: number; opened_at: string; output_changed_at: string | null;
        }>({ worker_id: workerId });
        // {§child-orientation}: one clock snapshot for the packet's live inventory.
        const now = Date.now();
        const secondsSince = (timestamp: string): number => Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
        const childStreams = [...Map.groupBy(openChannels, (c) => renderAddress(c)).entries()].map(([path, channels]) => ({
            status: "active",
            path,
            detail: [
                `elapsed ${secondsSince(channels[0]!.opened_at)}s`,
                channels[0]!.output_changed_at === null ? "output timing unknown"
                    : `output unchanged ${secondsSince(channels[0]!.output_changed_at)}s`,
                ...channels.map((c) => `${c.channel} ${c.lines} lines (+${Math.max(0, c.bytes - c.reported)} bytes)`),
            ].join("; "),
        }));
        const childWorkers = (await this.#db.engine_child_workers_live.all<{ name: string; status: number }>({ worker_id: workerId }))
            .map((r) => ({ status: r.status, path: `worker://${r.name}` }));
        // {§child-orientation} — a child is told whose child it is, so it can name the parent's
        // streams and space ({§worker-read-scope}, #394). The parent rides the `## Worker` identity
        // block; a root worker states `"parent": null` rather than omitting it.
        const parentRow = await this.#db.engine_parent_worker.get<{ name: string; status: number }>({ worker_id: workerId });
        const parentPath = parentRow === undefined ? null : `worker://${parentRow.name}`;
        // {§fs-namespace} Receipt directories are relative to the workspace project root.
        const workspaceRow = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const renderedLog = PacketWire.renderLogWithAccounting(
            log,
            weighContent,
            {
                projectRoot: workspaceRow?.project_root ?? null,
                acceptedAttachmentKinds: new Set(acceptedKinds(provider.inputModalities)),
                ...(bodiless === undefined ? {} : { bodiless }),
            },
        );
        // {§emission-history}: the durable emission row, not its turn's first observation,
        // anchors content replay without moving incoming observations or reasoning receipts.
        const history = Knob.choice("PLURNK_SERVICE_EMISSION_HISTORY", ["none", "latest", "all"]);
        const programs = omitEmissionHistory || history === "none" ? [] : await this.#db.engine_emission_history.all<{ id: number; content: string; executors: string }>({
            loop_id: loopId, current_turn_seq: currentTurnSeq, latest_only: history === "latest" ? 1 : 0,
        });
        const emissions = new Map(programs.map(({ id, content, executors }) =>
            [id, TurnOps.renderHistory(content, JSON.parse(executors) as string[])]));
        const nativeRows = new Map(renderedLog.attachments.map((attachment) => [attachment.coordinate, attachment]));
        const nativeParts: PacketAttachment[] = [];
        const logSections: PacketSectionDraft[] = [];
        const sectionItems = new Map<string, string[]>();
        let items: string[] = [];
        let name = "log";
        const flush = (): void => {
            if (items.length === 0 && logSections.length > 0) return;
            logSections.push({ name, slot: "user", header: name === "log" ? "Log" : null, content: items.join("\n\n") });
            sectionItems.set(name, items);
            items = [];
        };
        for (const [index, row] of log.entries()) {
            if (items.length === 0 && logSections.length > 0) name = `log/${row.coordinate}`;
            items.push(renderedLog.records[index]!);
            const native = nativeRows.get(String(row.coordinate));
            const emission = row.id == null ? undefined : emissions.get(row.id);
            if (native !== undefined || emission) {
                flush();
                if (native !== undefined) nativeParts.push({ ...native, section: name });
                if (emission) logSections.push({ name: `emission-history/${row.coordinate}`, slot: "assistant", header: null, content: emission });
            }
        }
        flush();
        const defaults: PacketSectionDraft[] = [
            { name: "definition", slot: "system", header: null, content: system_definition },
            // Stable privileged policy follows the definition for prefix-cache locality.
            { name: "system-policy", slot: "system", header: null, content: systemPolicy ?? "" },

            ...(inject !== null ? [{ name: "inject", slot: "system" as const, header: "Operator Notes", content: inject }] : []),
            // The append-mostly log leads the user slot; nothing volatile precedes it
            // ({§packet-cache-monotone}).
            ...logSections,
            // The per-turn status clump follows the log ({§packet-cache-monotone}) and runs from ambient
            // state to what this turn owes to feedback on the last one, then the Recap: the nearer the end,
            // the more a section asks of this turn.
            { name: "git", slot: "user", header: "Git Status", content: PacketWire.renderGit(gitStatus) },
            // {§context-gauge} — the model's word for curation weight is tokens; this is never provider admission.
            { name: "budget", slot: "user", header: "Context", content: budgetReadout },
            // {§packet-current-turn} — the Worker block names who the actor is, whose child it is, and the
            // coordinate this packet's response becomes — the one fact the sources cannot state about
            // themselves (which `reasoning://<worker>/L/T` is the model's own). It changes every turn, so it
            // never precedes the log.
            { name: "worker", slot: "user", header: "Worker", content: JSON.stringify({ path: `worker://${workerName}`, parent: parentPath, loop: loopSeqRow?.sequence ?? loopId, turn: currentTurnSeq }) },
            // child-orientation: what this worker holds live — its child workers and its open streams — under
            // the teaching's own word. Terse pointers (the path is the actionable address the model READs,
            // SENDs to, or KILLs), never advice. {§child-orientation}
            { name: "delegation", slot: "user", header: "Delegation", content: PacketWire.renderDelegation(childWorkers, childStreams) },
            // The open arrivals this turn owes, as pointers; bodies arrive through their inbound SEND rows
            // ({§message-arrival}).
            { name: "messages", slot: "user", header: "Open Messages", content: prompt },
            { name: "notices", slot: "user", header: "Notices", content: PacketWire.renderNotices(notices) },
            { name: "errors", slot: "user", header: "Errors", content: PacketWire.renderFailurePointers(failures) },
            { name: "recap", slot: "user", header: "Recap", content: recapContent },
        ];
        // Extension packet control ({§packet-assembly}): trusted schemes rewrite the
        // default list — add, remove, reorder — in-process, before measurement.
        let drafts = await this.#schemes.transformSections(defaults, workspaceId);
        const unchangedLog = logSections.filter((section) => section.slot === "user").every((section) =>
            drafts.some((candidate) => candidate.name === section.name && candidate.content === section.content && candidate.slot === section.slot));
        const attachments = nativeParts.filter(({ section }) => drafts.some(({ name }) => name === section));
        const attachmentsWeight = attachments.reduce((sum, { weight }) => sum + weight, 0);
        const budgetSection = drafts.find((section) => section.name === "budget");
        if (budgetSection !== undefined) {
            const curationTargets = unchangedLog ? renderedLog.curationTargets : [];
            // {§context-pressure-notice} — the pressure notice follows whatever the notices section holds.
            const noticesSection = drafts.find((section) => section.name === "notices");
            const withReadout = (gauge: string, notice: Notice | null): typeof drafts => drafts.map((section) => {
                if (section === budgetSection) return { ...section, content: gauge };
                if (section !== noticesSection || notice === null) return section;
                return { ...section, content: [section.content, PacketWire.renderNotices([notice])].filter((part) => part.length > 0).join("\n") };
            });
            const readout = BudgetReadout.resolve(budgetSection.content, (gauge, notice) =>
                PacketWire.packetToWireMessages({ sections: withReadout(gauge, notice) })
                    .reduce((sum, { content }) => sum + weighContent(content), attachmentsWeight), curationTargets);
            drafts = withReadout(readout.gauge, readout.notice);
        }
        // {§packet-items}: unchanged log segments retain their content-addressed records.
        const sections = drafts.map((section): StoredPacketSection => ({
            ...section,
            weight: weighContent(PacketWire.renderSection(section)),
            items: sectionItems.get(section.name)?.join("\n\n") === section.content ? sectionItems.get(section.name)! : [section.content],
        }));
        const renderWeight = PacketWire.packetToWireMessages({ sections })
            .reduce((sum, { content }) => sum + weighContent(content), 0);
        // {§packet-attachment-parts}: all text is already in the ordered messages.
        const packet: RequestPacket = { weight: renderWeight + attachmentsWeight, sections, attributions: [], attachments };
        this.#allowances.set(packet.sections, { budget: curationBudget, factor });
        // {§context-own-rows-fit} — a transformed log is one item the wall cannot take row by row.
        this.#bodiedRows.set(packet.sections, unchangedLog ? renderedLog.bodied : []);
        this.#streamObservations.set(packet.sections, openChannels);
        return packet;
    }

    async recordObservations(packet: RequestPacket): Promise<void> {
        const observations = this.#streamObservations.get(packet.sections);
        if (observations === undefined) throw new Error("Cannot acknowledge an unbuilt request packet.");
        if (observations.length === 0) return;
        await this.#db.engine_streams_reported.run({
            observations: JSON.stringify(observations.map(({ publication_id, bytes }) => ({ publication_id, bytes }))),
        });
    }

    // {§schemes-self-doc-materialization} {§tools-resource-materialization} —
    // one reserved reference set, materialized by LoopDocs.
    async referenceEntries(workspaceId: number): Promise<Array<{ pathname: string; content: string }>> {
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId);
        const policies = layers.map((layer) => layer.policy);
        const out = (await this.#schemes.docs(workspaceId))
            .filter(({ scheme }) => scheme === null || this.#capabilities.allowsSchemeAcross(scheme, workspaceId, policies))
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
        // {§schemes-directory} — a family's generated documents follow its manager runtime's admission:
        // a denied family is a door the model is never shown.
        out.push(...this.#functionalityDocuments(workspaceId)
            .filter(({ family }) => this.#capabilities.allowsRuntimeAcross(family, null, workspaceId, policies))
            .map(({ pathname, content }) => ({ pathname, content })));
        return out.toSorted((left, right) => left.pathname.localeCompare(right.pathname));
    }

    // {§context-over-budget-row} — measurement never mutates visibility; an over-budget packet is a row
    // and a request, never a silent cut.
    curationOverflow(packet: RequestPacket): CurationOverflow | null {
        const budget = this.curationBudgetFor(packet);
        if (budget === null) return null;
        const { weight } = packet;
        if (weight <= budget) return null;
        return { weight, budget, excess: weight - budget };
    }

    // {§context-wall-measure} — the estimate: the packet's weight through its own calibration factor against
    // the provider's input wall; null without a wall or a budget: an unknown window has no wall.
    windowOverflow(packet: RequestPacket, provider: { readonly inputWall: number | null }): WindowOverflow | null {
        const { budget, factor } = this.#allowanceOf(packet);
        if (budget === null || provider.inputWall === null) return null;
        const tokens = Math.ceil(packet.weight * factor);
        if (tokens <= provider.inputWall) return null;
        const excessWeight = packet.weight - Math.floor(provider.inputWall / factor);
        return { tokens, budget, wall: provider.inputWall, excess: tokens - provider.inputWall, excessWeight };
    }

    // {§context-wall-measure} — the provider's exact refusal of the wire request, in the packet's own terms:
    // the excess it names, shed at the ratio it measured for this packet. Null unless the provider refused.
    exactOverflow(packet: RequestPacket, capacity: ProviderRequestCapacity): WindowOverflow | null {
        if (capacity.decision !== "reject") return null;
        const { prompt, inputWall } = capacity;
        // {§provider-capacity-admission}: only an exact count over a known wall refuses.
        if (prompt.kind !== "exact" || inputWall === null) throw new Error(`a capacity refusal measured ${prompt.kind} against ${inputWall} carries no exact excess`);
        const excess = prompt.tokens - inputWall;
        return {
            tokens: prompt.tokens,
            budget: this.curationBudgetFor(packet),
            wall: inputWall,
            excess,
            excessWeight: Math.ceil(excess * packet.weight / prompt.tokens),
        };
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
    async #buildLog(workerId: number, transientOpenLogEntryId: number | null, turnId: number | null) {
        // SPEC {§packet-terms}: workers own log entries — log is the worker's history,
        // not the loop's. Span all loops in the worker so the model sees
        // earlier loops' work as conversational memory.
        //
        // User prompts are first-class actionless log entries written by
        // runTurn. They surface naturally in this query without synthetic
        // EDIT/READ delivery rows.
        const rows = await this.#db.engine_render_log.all<StoredLogRow>({ worker_id: workerId, turn_id: turnId });
        return rows.map((r) => PacketWire.entryView(r, transientOpenLogEntryId));
    }
}
