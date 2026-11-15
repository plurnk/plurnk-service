import SessionOwners from "./SessionOwners.ts";
import { Validator, isRecord, isSafeInteger, type Notice } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import type HostPaths from "./HostPaths.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { GitStatus } from "./git-state.ts";
import SessionName from "./SessionName.ts";
import { renderAddress } from "./plurnk-uri.ts";
import { contentWeight } from "./content-weight.ts";
import FunctionalityManager, { plurnkRuntimeDecl } from "../server/FunctionalityManager.ts";
import PlurnkSkill from "../server/PlurnkSkill.ts";
import CapabilityPolicies from "./CapabilityPolicies.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import { readGlobalAgents, readGlobalLocalAgents, readSystemPolicy } from "./packet-inject.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
import { acceptedKinds } from "./attachments.ts";
// Shared module imported by both Engine and the digest, so wire
// projection and digest projection are structurally one function — no
// drift between wire and digest possible.
import PacketWire, { type StoredLogRow } from "./packet-wire.ts";
import PacketRowFacts from "./packet-row-facts.ts";
import type { PacketAttachment, RequestPacket, StoredPacketSection } from "./StoredPacket.ts";

// Provider contract owned by @plurnk/plurnk-providers; engine is the consumer.
import { chatMessageText, type ChatMessage, type Provider, type ProviderRequestCapacity } from "@plurnk/plurnk-providers";
import BudgetReadout from "./BudgetReadout.ts";
import TokenCalibration from "./TokenCalibration.ts";
import ToolResources from "./ToolResources.ts";
import OperationHistory, { type EmissionProgram } from "./OperationHistory.ts";

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

// {§packet} — plurnk.md remains spacious for human editing;
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
            fence = { marker: fenceRun.startsWith("`") ? "`" : "~", length: fenceRun.length };
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

// {§tokenomics} — the packet's tokens against the provider's input wall, in provider tokens, by either
// measure ({§tokenomics}).
export interface WindowOverflow {
    readonly tokens: number;
    readonly budget: number | null;
    readonly wall: number;
    readonly excess: number;
}

export interface CurationOverflow {
    readonly weight: number;
    readonly budget: number;
    readonly excess: number;
}

// Packet assembly ({§packet-assembly}) and the budget and wall measures ({§tokenomics}, {§tokenomics}). Deliberate
// curation stays in scoped KILL; what fits was decided where each row landed ({§tokenomics}).
export default class PacketBuilder {
    #db: Db;
    // {§tokenomics} — admission and client gauges consume the curatable room, whole-packet allowance,
    // non-curatable floor, and calibration offset captured before this request can change model evidence.
    readonly #allowances = new WeakMap<readonly StoredPacketSection[], {
        readonly curationBudget: number | null;
        readonly wholeBudget: number | null;
        readonly floorWeight: number;
        readonly offset: number;
    }>();
    readonly #streamObservations = new WeakMap<readonly StoredPacketSection[], readonly { publication_id: number; bytes: number }[]>();
    readonly #noticeCursors = new WeakMap<readonly StoredPacketSection[], { readonly loopId: number; readonly maxLogId: number }>();
    #schemes: SchemeRegistry;
    // Boot-discovered runtime executors, late-injected on Engine after daemon
    // start() — read through a thunk so the post-construction set is visible.
    #executors: () => ExecutorRegistry | undefined;
    #capabilities: CapabilityResolver;
    readonly #hostPaths: HostPaths | undefined;
    // {§functionality-model-projection} — family-generated documents of a Session's
    // published Functionality, reconciled with its other reference entries.
    #functionalityDocuments: (workspaceId: number) => Array<{ family: string; pathname: string; content: string }> = () => [];

    constructor({ db, schemes, executors, hostPaths }: {
        db: Db;
        schemes: SchemeRegistry;
        executors: () => ExecutorRegistry | undefined;
        hostPaths?: HostPaths;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#executors = executors;
        this.#hostPaths = hostPaths;
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
    }

    setFunctionalityDocuments(documents: (workspaceId: number) => Array<{ family: string; pathname: string; content: string }>): void {
        this.#functionalityDocuments = documents;
    }

    curationBudgetFor(packet: RequestPacket): number | null {
        return this.#allowanceOf(packet).curationBudget;
    }

    curationRemainingFor(packet: RequestPacket, reserve = 0): number | null {
        const { curationBudget, floorWeight } = this.#allowanceOf(packet);
        if (curationBudget === null) return null;
        const curationWeight = Math.max(0, packet.weight - floorWeight);
        return Math.max(0, curationBudget - curationWeight - reserve);
    }

    #allowanceOf(packet: RequestPacket): {
        readonly curationBudget: number | null;
        readonly wholeBudget: number | null;
        readonly floorWeight: number;
        readonly offset: number;
    } {
        const allowance = this.#allowances.get(packet.sections);
        if (allowance === undefined) throw new Error("the packet was not built by this PacketBuilder");
        return allowance;
    }

    // {§packet} — assemble the system/user request before the
    // provider call; complete the same record with the provider response.
    async buildRequestPacket({
        initialMessages, workspaceId, sessionId, loopId, currentTurnSeq, provider, gitStatus, notices = [],
        transientOpenLogEntryId = null,
    }: {
        initialMessages: ChatMessage[];
        gitStatus: GitStatus | null;
        workspaceId: number; sessionId: number; loopId: number;
        // DB-level turn sequence for "look at the previous turn" queries.
        currentTurnSeq: number;
        provider: Provider;
        // Model-facing observations queued by the engine before this packet build.
        notices?: readonly Notice[];
        // One packet may expose a durably suppressed row without mutating its
        // curation state ({§emission-admission}).
        transientOpenLogEntryId?: number | null;
        turnId?: number | null;
    }): Promise<RequestPacket> {
        await CapabilityPolicies.layers(this.#db, workspaceId);
        const byRole = (role: ChatMessage["role"]): string =>
            initialMessages.filter((m) => m.role === role).map((m) => chatMessageText(m)).join("\n\n");
        // Resource references are discovered through Turn0, not injected. {§tools-resource-materialization}
        const system_definition = compactDefinitionTables(byRole("system"));
        const loopSeqRow = await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: loopId });
        const sessionName = await SessionName.forId(this.#db, sessionId);
        // {§fs-namespace} Receipt directories are relative to the workspace project root.
        const workspaceRow = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const projectRoot = workspaceRow?.project_root ?? null;
        // {§message-arrival}: source addresses survive curation of their log observations.
        const openMessageRows = await this.#db.engine_open_messages.all<{
            id: number; path: string; key_path: string; source: string | null;
        }>({ loop_id: loopId });
        // {§message-arrival}: the model is shown the short address, never a client's own
        // transport identity; answering either reaches the same message. The operator's message has
        // no other sender to show, so it is named ({§message-arrival}).
        const openMessages = openMessageRows.map((m) => ({
            path: m.key_path,
            ...(m.source === null ? { origin: "user" as const } : { source: m.source }),
        }));
        // {§emission-admission}: the definition remains the complete language authority.
        const log = await this.#buildLog(sessionId, transientOpenLogEntryId);
        const { notices: logNotices, maxLogId } = await this.#buildLogNotices(loopId, projectRoot);
        const combinedNotices = [...logNotices, ...notices];
        const weighContent = contentWeight;
        // {§tokenomics} — calibrated whole-packet allowance; curatable room subtracts the non-curatable floor
        // after section transforms establish the packet shape.
        const inputCapacity = provider.inputCapacity;
        const offset = inputCapacity === null ? 0 : await TokenCalibration.forLoop(this.#db, provider.model, loopId);
        const wholeBudget = TokenCalibration.capacity(inputCapacity, offset);
        const initialBudgetDraft = BudgetReadout.draft(wholeBudget);
        // The canonical default order, trust boundary, and cache-locality bias are
        // specified at {§packet-assembly}. Budget placeholders resolve only
        // after trusted whole-list transforms establish the packet being measured.
        // {§packet-assembly} — global AGENTS(.local).md (or PLURNK_SERVICE_POLICY), project-root
        // AGENTS(.local).md, and session://<session>/AGENTS.md ride the `system-policy` packet section.
        const globalPolicy = await readSystemPolicy(this.#hostPaths);
        const policyRows = await this.#db.engine_packet_policy_entries.all<{
            scheme: string; pathname: string; project_root: string; content: string | null;
        }>({ workspace_id: workspaceId, session_name: sessionName });
        const resolvedPolicies = await Promise.all(policyRows.map(async (row) => {
            if (row.content !== null) return row.content.trim();
            if (row.scheme !== "file") return "";
            try {
                return (await readFile(resolve(row.project_root, row.pathname.replace(/^\/+/, "")), "utf8")).trim();
            } catch {
                return "";
            }
        }));
        const systemPolicy = [
            ...(globalPolicy !== null && globalPolicy.length > 0 ? [globalPolicy] : []),
            ...resolvedPolicies.filter((text) => text.length > 0),
        ].join("\n\n");
        // Child-orientation ({§child-orientation}): the live things this session holds — open streams +
        // unconcluded child sessions — surfaced every turn as `{status, path}` JSON pointers (same shape
        // as errors) just above the errors section. Orienting STATE so the model never loses track of
        // what it's holding (the premature-terminate trap), never advice on what to do. These two
        // sections always render, `[]` when empty: the model decides wait-or-complete on them, so
        // emptiness is stated rather than inferred from a missing heading ({§child-orientation}).
        const openChannels = await this.#db.engine_child_streams_open.all<{
            scheme: string; authority: string; pathname: string; publication_id: number; channel: string;
            lines: number; bytes: number; reported: number; opened_at: string; output_changed_at: string | null;
        }>({ session_id: sessionId });
        // {§child-orientation}: one clock snapshot for the packet's live inventory.
        const now = Date.now();
        const secondsSince = (timestamp: string): number => Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
        const childStreams = [...Map.groupBy(openChannels, (c) => renderAddress(c)).entries()].map(([path, channels]) => ({
            status: "active",
            path,
            detail: [
                `elapsed ${secondsSince(channels[0].opened_at)}s`,
                channels[0].output_changed_at === null ? "output timing unknown"
                    : `output unchanged ${secondsSince(channels[0].output_changed_at)}s`,
                ...channels.map((c) => `${c.channel} ${c.lines} lines (+${Math.max(0, c.bytes - c.reported)} bytes)`),
            ].join("; "),
        }));
        const childSessions = (await this.#db.engine_child_sessions_live.all<{ name: string; status: number }>({ session_id: sessionId }))
            .map((r) => ({ status: r.status, path: `session://${r.name}` }));
        // {§loop-completion} — the messages this session sent that await completion, the third thing it holds.
        const sentMessages = (await this.#db.engine_sent_messages_open.all<{ path: string; status: number }>({ session_id: sessionId }))
            .map((r) => ({ status: r.status, path: r.path }));
        // {§child-orientation} — a child is told whose child it is, so it can name the parent's
        // streams and space ({§session-scheme}, #394). The parent rides the `## Session` identity
        // block; a root session states `"parent": null` rather than omitting it.
        const parentRow = await this.#db.engine_parent_session.get<{ name: string; status: number }>({ session_id: sessionId });
        const parentPath = parentRow === undefined ? null : `session://${parentRow.name}`;
        const owner = await SessionOwners.forLoop(this.#db, loopId);
        // {§emission-history}: the emission row selects the program; durable receipt ordinals
        // locate its operations without moving incoming observations or reasoning receipts.
        const history = Knob.choice("PLURNK_SERVICE_EMISSION_HISTORY", ["none", "latest", "all"]);
        const programs = history === "none" ? [] : await this.#db.engine_emission_history.all<EmissionProgram>({
            session_id: sessionId,
            loop_id: loopId,
            current_loop_seq: loopSeqRow?.sequence ?? 1,
            current_turn_seq: currentTurnSeq,
            latest_only: history === "latest" ? 1 : 0,
        });
        const { operations, paired, turns } = OperationHistory.project(log, programs);
        for (const [coordinate, operation] of operations) paired.set(coordinate, { ...paired.get(coordinate)!, tokens: weighContent(operation) });
        const renderedLog = PacketWire.renderLogWithAccounting(
            log,
            weighContent,
            {
                projectRoot,
                acceptedAttachmentKinds: new Set(acceptedKinds(provider.inputModalities)),
                paired,
            },
        );
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
            const emission = turns.get(String(row.coordinate));
            if (emission !== undefined && items.length > 0) flush();
            if (items.length === 0 && logSections.length > 0) name = `log/${String(row.coordinate)}`;
            items.push(renderedLog.records[index]);
            const native = nativeRows.get(String(row.coordinate));
            if (native !== undefined) {
                flush();
                nativeParts.push({ ...native, section: name });
            }
            if (emission !== undefined) {
                flush();
                logSections.push({ name: `emission-history/${String(row.coordinate)}`, slot: "assistant", header: null, content: emission });
            }
        }
        flush();
        const defaults: PacketSectionDraft[] = [
            { name: "definition", slot: "system", header: null, content: system_definition },
            // {§packet-assembly} — global AGENTS(.local).md (or PLURNK_SERVICE_POLICY), project-root
            // AGENTS(.local).md, and session://<session>/AGENTS.md ride the `system-policy` section.
            { name: "system-policy", slot: "system", header: null, content: systemPolicy },
            // The append-mostly log leads the user slot; nothing volatile precedes it
            // ({§packet-assembly}).
            ...logSections,
            // The per-turn status clump follows the log ({§packet-assembly}) and runs from ambient
            // state to what this turn owes to feedback on the last one: the nearer the end,
            // the more a section asks of this turn.
            { name: "git", slot: "user", header: "Git", content: PacketWire.renderGit(gitStatus) },
            // {§tokenomics} — the model's word for curation weight is tokens; this is never provider admission.
            { name: "budget", slot: "user", header: "Log Curation", content: initialBudgetDraft },
            // {§child-orientation} — the Session block names who the actor is, whose child it is, and the
            // coordinate this packet's response becomes — the one fact the sources cannot state about
            // themselves (which `reasoning://<session>/L/T` is the model's own). It changes every turn, so it
            // never precedes the log.
            // {§child-orientation} — and whose session it is: the approval owner, with whether a person
            // attends it, so nobody-can-answer is a stated fact rather than an inference from a missing tool.
            { name: "session", slot: "user", header: "Session", content: JSON.stringify({
                path: `session://${sessionName}`, parent: parentPath, loop: loopSeqRow?.sequence ?? loopId, turn: currentTurnSeq,
                owner: { address: owner.address, interactive: owner.interactive },
            }) },
            // child-orientation: the work this session holds open — its child sessions, its open streams, the
            // messages it owes, and the messages it awaits. Terse pointers (the path is the actionable
            // address the model READs, SENDs to, or KILLs), never advice. {§child-orientation}
            { name: "work", slot: "user", header: "Open Work", content: PacketWire.renderOpenWork(childSessions, childStreams, [...openMessages, ...sentMessages]) },
            { name: "notices", slot: "user", header: "Notices", content: PacketWire.renderNotices(combinedNotices) },
        ];
        // Extension packet control ({§packet-assembly}): trusted schemes rewrite the
        // default list — add, remove, reorder — in-process, before measurement.
        let drafts = await this.#schemes.transformSections(defaults, workspaceId);
        const unchangedLog = logSections.filter((section) => section.slot === "user").every((section) =>
            drafts.some((candidate) => candidate.name === section.name && candidate.content === section.content && candidate.slot === section.slot));
        const attachments = nativeParts.filter(({ section }) => drafts.some((draft) => draft.name === section));
        const attachmentsWeight = attachments.reduce((sum, { weight }) => sum + weight, 0);
        const isCuratableSection = (section: PacketSectionDraft): boolean =>
            section.name === "log" || section.name.startsWith("log/") || section.name.startsWith("emission-history/");
        const nonCuratableDrafts = drafts.filter((section) => !isCuratableSection(section));
        const wireWeight = (candidateSections: PacketSectionDraft[], attachmentTokens = 0): number =>
            PacketWire.packetToWireMessages({ sections: candidateSections })
                .reduce((sum, { content }) => sum + weighContent(content), attachmentTokens);
        const budgetSection = drafts.find((section) => section.name === "budget");
        let floorWeight: number;
        let curationBudget: number | null;
        if (budgetSection === undefined) {
            floorWeight = wireWeight(nonCuratableDrafts, 0);
            curationBudget = wholeBudget === null ? null : Math.max(0, wholeBudget - floorWeight);
        } else {
            const withFloorGauge = (gauge: string): PacketSectionDraft[] => nonCuratableDrafts.map((section) =>
                section === budgetSection ? { ...section, content: gauge } : section);
            let template: string;
            if (budgetSection.content === initialBudgetDraft) {
                const floorAt = (b: number): number => wireWeight(withFloorGauge(`{"tokens":0,"budget":${b},"percent":0}`), 0);
                if (wholeBudget === null) {
                    curationBudget = null;
                    floorWeight = wireWeight(withFloorGauge("{\"tokens\":0}"), 0);
                } else if (wholeBudget <= floorAt(1)) {
                    curationBudget = 0;
                    floorWeight = wireWeight(withFloorGauge("{\"tokens\":0,\"budget\":0}"), 0);
                } else {
                    let b = Math.max(1, wholeBudget - floorAt(wholeBudget));
                    while ((b + 1) + floorAt(b + 1) <= wholeBudget) b += 1;
                    curationBudget = b;
                    floorWeight = floorAt(b);
                }
                template = BudgetReadout.draft(curationBudget);
            } else {
                template = budgetSection.content;
                floorWeight = wireWeight(withFloorGauge(template.replace("{{tokens}}", "0").replace("{{percent}}", "0")), 0);
                curationBudget = wholeBudget === null ? null : Math.max(0, wholeBudget - floorWeight);
            }
            const curationTargets = unchangedLog ? renderedLog.curationTargets : [];
            // {§tokenomics} — the gauge measures curatable log weight (`weight - floorWeight`) inside the full packet.
            const withReadout = (gauge: string): typeof drafts => drafts.map((section) =>
                section === budgetSection ? { ...section, content: gauge } : section);
            const readout = BudgetReadout.resolve(
                template,
                (gauge) => Math.max(0, wireWeight(withReadout(gauge), attachmentsWeight) - floorWeight),
                curationTargets,
            );
            drafts = withReadout(readout.gauge);
        }
        // {§packet}: unchanged log segments retain their content-addressed records.
        const sections = drafts.map((section): StoredPacketSection => ({
            ...section,
            weight: weighContent(PacketWire.renderSection(section)),
            items: sectionItems.get(section.name)?.join("\n\n") === section.content ? sectionItems.get(section.name)! : [section.content],
        }));
        const renderWeight = PacketWire.packetToWireMessages({ sections })
            .reduce((sum, { content }) => sum + weighContent(content), 0);
        const weight = renderWeight + attachmentsWeight;
        const curationWeight = Math.max(0, weight - floorWeight);
        // {§log-wire-format}: all text is already in the ordered messages.
        const packet: RequestPacket = { weight, curationWeight, sections, attributions: [], attachments };
        this.#allowances.set(packet.sections, { curationBudget, wholeBudget, floorWeight, offset });
        this.#streamObservations.set(packet.sections, openChannels);
        this.#noticeCursors.set(packet.sections, { loopId, maxLogId });
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

    async acknowledgeNotices(packet: RequestPacket): Promise<void> {
        const cursor = this.#noticeCursors.get(packet.sections);
        if (cursor === undefined) throw new Error("Cannot acknowledge notices for an unbuilt request packet.");
        if (cursor.maxLogId === 0) return;
        await this.#db.engine_advance_notice_log_cursor.run({
            loop_id: cursor.loopId,
            cursor: cursor.maxLogId,
        });
    }

    // {§tools-resource-materialization} {§tools-resource-materialization} —
    // one reserved reference set on plurnk:/// and mcp:///, materialized by LoopDocs.
    async referenceEntries(workspaceId: number): Promise<Array<{ scheme: "plurnk" | "mcp"; pathname: string; content: string }>> {
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId);
        const policies = layers.map((layer) => layer.policy);
        const out: Array<{ scheme: "plurnk" | "mcp"; pathname: string; content: string }> = (await this.#schemes.docs(workspaceId))
            .filter(({ name, scheme }) => !PlurnkSkill.CHAPTER_NAMES.has(name)
                && (scheme === null || this.#capabilities.allowsSchemeAcross(scheme, workspaceId, policies)))
            .map(({ name, content }) => ({
                scheme: "plurnk" as const,
                pathname: `/${name}.md`,
                content,
            }));
        const [globalAgents, globalLocalAgents] = await Promise.all([
            readGlobalAgents(this.#hostPaths),
            readGlobalLocalAgents(this.#hostPaths),
        ]);
        if (globalAgents !== null) {
            out.push({ scheme: "plurnk", pathname: "/AGENTS.md", content: globalAgents });
        }
        if (globalLocalAgents !== null) {
            out.push({ scheme: "plurnk", pathname: "/AGENTS.local.md", content: globalLocalAgents });
        }
        const executors = this.#executors();
        out.push(...FunctionalityManager.renderPlurnkResources(
            this.#capabilities,
            workspaceId,
            policies,
            executors,
        ));
        if (executors !== undefined) {
            for (const tag of executors.availableRuntimes(workspaceId)) {
                if (tag === plurnkRuntimeDecl.name) continue;
                const entry = executors.entry(tag, workspaceId);
                if (entry === undefined) continue;
                const registry = executors.toolRegistry(tag, workspaceId);
                if (registry === null) continue;
                const filteredRegistry = {
                    tools: registry.tools.filter((tool) =>
                        this.#capabilities.allowsRuntimeAcross(tag, tool.target, workspaceId, policies)),
                };
                if (filteredRegistry.tools.length === 0) continue;
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
        // {§tools-resource-materialization} — a family's generated documents follow its tool's admission:
        // a denied family is a door the model is never shown.
        out.push(...this.#functionalityDocuments(workspaceId)
            .filter(({ family }) =>
                this.#capabilities.allowsRuntimeAcross("plurnk", family, workspaceId, policies))
            .map(({ pathname, content }) => ({ scheme: "plurnk" as const, pathname, content })));
        return out.toSorted((left, right) =>
            left.scheme.localeCompare(right.scheme) || left.pathname.localeCompare(right.pathname));
    }

    // {§tokenomics} — measurement never mutates visibility; an over-budget packet is a notice
    // and a request, never a silent cut.
    curationOverflow(packet: RequestPacket): CurationOverflow | null {
        const { curationBudget, wholeBudget, floorWeight } = this.#allowanceOf(packet);
        if (curationBudget === null || wholeBudget === null) return null;
        const ceiling = Math.min(wholeBudget, floorWeight + curationBudget);
        if (packet.weight <= ceiling) return null;
        const excess = packet.weight - ceiling;
        return { weight: curationBudget + excess, budget: curationBudget, excess };
    }

    // {§session-model-selection} — measure the session's current curated context against a candidate
    // provider's budget before admitting a model switch. Null when the session has not yet built a
    // packet or the candidate model's input capacity is unknown.
    async sessionCurationOverflow(sessionId: number, provider: Provider): Promise<CurationOverflow | null> {
        if (provider.inputCapacity === null) return null;
        const latest = await this.#db.engine_session_latest_packet.get<{
            workspace_id: number;
            loop_id: number;
            packet: string;
        }>({ session_id: sessionId });
        if (latest === undefined) return null;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§db-migrations}: turns.packet is a stored RequestPacket
        const stored = JSON.parse(latest.packet) as RequestPacket;
        const packet = await this.buildRequestPacket({
            initialMessages: [{ role: "system", content: PacketWire.sectionContent(stored, "definition") }],
            workspaceId: latest.workspace_id,
            sessionId,
            loopId: latest.loop_id,
            currentTurnSeq: 1,
            provider,
            gitStatus: null,
        });
        return this.curationOverflow(packet);
    }

    // {§tokenomics} — the estimate: the packet's weight through its own calibration offset against
    // the provider's input wall; null without a wall or a budget: an unknown window has no wall.
    windowOverflow(packet: RequestPacket, provider: { readonly inputWall: number | null }): WindowOverflow | null {
        const { wholeBudget, offset } = this.#allowanceOf(packet);
        if (wholeBudget === null || provider.inputWall === null) return null;
        const tokens = TokenCalibration.estimatedTokens(packet.weight, offset);
        if (tokens <= provider.inputWall) return null;
        return { tokens, budget: wholeBudget, wall: provider.inputWall, excess: tokens - provider.inputWall };
    }

    // {§tokenomics} — the provider's exact refusal of the wire request. Null unless the provider refused.
    exactOverflow(packet: RequestPacket, capacity: ProviderRequestCapacity): WindowOverflow | null {
        if (capacity.decision !== "reject") return null;
        const { prompt, inputWall } = capacity;
        // {§provider-capacity-admission}: only an exact count over a known wall refuses.
        if (prompt.kind !== "exact" || inputWall === null) throw new Error(`a capacity refusal measured ${prompt.kind} against ${inputWall} carries no exact excess`);
        const excess = prompt.tokens - inputWall;
        return {
            tokens: prompt.tokens,
            budget: this.#allowanceOf(packet).wholeBudget,
            wall: inputWall,
            excess,
        };
    }

    static #problemSlug(type: string | undefined): string {
        if (typeof type !== "string" || type.length === 0) return "error";
        const tail = type.slice(type.lastIndexOf("/") + 1).trim();
        return tail.length > 0 ? tail : "error";
    }

    static #logRowToNotice(row: StoredLogRow & { id: number; active: number }, projectRoot: string | null): Notice {
        const entry = PacketWire.entryView(row);
        const identity = PacketRowFacts.rowIdentity(entry, { projectRoot });
        const rx = isRecord(entry.rx) ? entry.rx : null;
        if (row.status_rx >= 400) {
            const rawProblem = rx !== null && isRecord(rx.problem) ? rx.problem : null;
            const problem = rawProblem !== null ? Validator.assertProblemDetails(rawProblem) : null;
            const kind = PacketBuilder.#problemSlug(problem?.type);
            const detail = problem?.detail ?? problem?.title ?? "Operation failed.";
            if (row.active === 1) {
                return Validator.assertNotice({
                    source: "engine:log",
                    kind,
                    level: "error",
                    message: `${row.status_rx} ${detail}`,
                    position: {
                        type: "log-coordinate",
                        coordinate: identity.path,
                        ...(identity.op === null ? {} : { op: identity.op }),
                    },
                });
            }
            const subject = identity.op === null || identity.op === "error"
                ? `${row.status_rx}:`
                : `${row.status_rx} ${identity.renderedLeaf}${identity.description === null ? "" : ` ${identity.description}`}:`;
            const diagnostic = typeof rawProblem?.diagnostic === "string"
                && rawProblem.diagnostic.length > 0
                && rawProblem.diagnostic !== detail
                ? rawProblem.diagnostic
                : null;
            const errorsHint = Array.isArray(rawProblem?.errors) && rawProblem.errors.length > 0
                ? rawProblem.errors
                    .flatMap((item) => {
                        if (typeof item === "string" && item.trim().length > 0) return [item.trim()];
                        if (isRecord(item)) {
                            const msg = typeof item.error === "string"
                                ? item.error
                                : typeof item.message === "string"
                                    ? item.message
                                    : null;
                            if (msg !== null && msg.trim().length > 0) {
                                const loc = typeof item.instanceLocation === "string" && item.instanceLocation.length > 1
                                    ? `${item.instanceLocation}: `
                                    : "";
                                return [`${loc}${msg.trim()}`];
                            }
                        }
                        return [];
                    })
                    .slice(0, 3)
                    .join(" ")
                : null;
            const anchorsHint = Array.isArray(rawProblem?.unresolvedAnchors) && rawProblem.unresolvedAnchors.length > 0
                ? `Unresolved anchors: ${JSON.stringify(rawProblem.unresolvedAnchors)}.`
                : null;
            const recovery = typeof rawProblem?.recovery === "string" && rawProblem.recovery.length > 0
                ? rawProblem.recovery
                : null;
            const streamHint = typeof rawProblem?.stream === "string"
                && rawProblem.stream.length > 0
                && !detail.includes(rawProblem.stream)
                && !(recovery?.includes(rawProblem.stream) ?? false)
                ? `Output is at ${rawProblem.stream}.`
                : null;
            const position = isSafeInteger(rawProblem?.line)
                && rawProblem.line >= 1
                && isSafeInteger(rawProblem?.column)
                && rawProblem.column >= 0
                ? { type: "content-offset" as const, line: rawProblem.line, column: rawProblem.column }
                : undefined;
            return Validator.assertNotice({
                source: "engine:log",
                kind,
                level: "error",
                message: [subject, detail, errorsHint, anchorsHint, diagnostic, recovery, streamHint].filter((part): part is string => part !== null && part.length > 0).join(" "),
                ...(position === undefined ? {} : { position }),
            });
        }
        const kind = row.status_rx === 204 ? "no_match" : "not_modified";
        const detail = typeof rx?.detail === "string" && rx.detail.length > 0
            ? rx.detail
            : row.status_rx === 204
                ? "Matched zero targets; nothing changed."
                : "Content already matches; nothing changed.";
        const subject = identity.op === null
            ? `${row.status_rx}:`
            : `${row.status_rx} ${identity.renderedLeaf}${identity.description === null ? "" : ` ${identity.description}`}:`;
        return Validator.assertNotice({
            source: "engine:log",
            kind,
            level: "warn",
            message: `${subject} ${detail}`,
        });
    }

    async #buildLogNotices(loopId: number, projectRoot: string | null): Promise<{ notices: Notice[]; maxLogId: number }> {
        const [rows, highWater] = await Promise.all([
            this.#db.engine_render_log_notices.all<StoredLogRow & { id: number; active: number }>({ loop_id: loopId }),
            this.#db.engine_log_notice_high_water.get<{ max_id: number }>({ loop_id: loopId }),
        ]);
        const maxLogId = highWater?.max_id ?? 0;
        return {
            notices: rows.map((row) => PacketBuilder.#logRowToNotice(row, projectRoot)),
            maxLogId,
        };
    }

    // SPEC {§packet} the log section — chronological action-entries for the loop.
    // Snapshot is taken at packet build (pre-dispatch this turn), so it
    // reflects "what has happened before this turn." Each row carries a
    // log:///<loop_seq>/<turn_seq>/<sequence> coordinate the model can READ.
    async #buildLog(sessionId: number, transientOpenLogEntryId: number | null) {
        // SPEC {§lifecycle-terms}: sessions own log entries — log is the session's history,
        // not the loop's. Span all loops in the session so the model sees
        // earlier loops' work as its own memory.
        //
        // User prompts are first-class actionless log entries written by
        // runTurn. They surface naturally in this query without synthetic
        // EDIT/READ delivery rows.
        const rows = await this.#db.engine_render_log.all<StoredLogRow>({ session_id: sessionId });
        return rows.map((r) => PacketWire.entryView(r, transientOpenLogEntryId));
    }
}
