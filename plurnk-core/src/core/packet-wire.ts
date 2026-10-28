// Packet → wire markdown projection. Single source of truth for how the
// Packet's ordered list of sections renders to ChatMessage.content
// strings the LLM receives. Engine imports this for the wire payload; the
// digest tool imports it to write byte-identical <stem>.{system,user}.md
// files. No second implementation, no drift.
//
// Format and omission rules are owned by {§packet}. Section producers
// supply names and typed content; this projection preserves their ordered evidence.

import type { PacketAttachment, RequestPacket } from "./StoredPacket.ts";
import type { ChatContentPart, ChatMessage } from "@plurnk/plurnk-providers";
import { isRecord, isSafeInteger, type Notice } from "@plurnk/plurnk-contracts";
import GitState, { type GitStatus } from "./git-state.ts";
import LogBody from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import LogVisibility from "./LogVisibility.ts";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
import { LineAnchors } from "../content/index.ts";
// {§log-wire-format} — the attachment kinds and their readout weights live in one table.
import { audioWeight, imageWeight, pdfWeight } from "./attachments.ts";
import PacketRowFacts, { type ActionTarget, type RowIdentity, type StatementTx } from "./packet-row-facts.ts";
import PacketBodyFormat, { type RowBody, type VisibleLogBody } from "./packet-body-format.ts";

// One `log_entries` row joined to its loop and turn, as `engine_render_log` yields it.
export interface StoredLogRow {
    id: number | null; loop_seq: number; turn_seq: number; sequence: number;
    origin: string; op: string | null; signal: string | null;
    scheme: string | null; username: string | null; password: string | null;
    hostname: string | null; port: number | null; pathname: string | null;
    query: string | null; fragment: string | null;
    status_rx: number; rx: string; mimetype_rx: string;
    tx: string; mimetype_tx: string; initial_folded: string; folded: string; source: string | null; attrs: string | null;
    producer: string;
}

export interface LogEntryView {
    id?: number | null;
    coordinate?: unknown;
    signal?: unknown;
    op?: unknown;
    origin?: unknown;
    status?: unknown;
    target?: ActionTarget | null;
    tx?: StatementTx | string | null;
    mimetype_tx?: unknown;
    rx?: unknown;
    mimetype_rx?: unknown;
    folded?: unknown;
    initial_folded?: unknown;
    source?: unknown;
    attrs?: unknown;
    // {§turn-source-resources}: the producer of the row's turn, which authored an emission row's emission.
    producer?: unknown;
    lineAnchors?: readonly string[];
    lineNumberWidth?: number;
}

// A durable operation failure, as PacketBuilder selects it: its status and the coordinate of the row that owns it.
export interface FailurePointer { readonly status: number; readonly coordinate: string }
// One thing the session holds open ({§child-orientation}): its status or sender, the path the model acts on, and a detail.
export interface OpenWorkPointer {
    readonly status?: number | string;
    readonly path: string;
    readonly origin?: "user";
    readonly source?: string;
    readonly detail?: string;
}
// {§packet-inject} The working tree as the packet renders it: the counts, and the paths a snapshot carries with
// their XY status and, for an untracked path, its membership truth.
export type GitStatusView = GitStatus & {
    readonly files?: readonly { readonly path: string; readonly status: string; readonly member?: string | null }[];
};

// Loose view of a section re-parsed from `turns.packet` JSON (the digest path).
interface SectionView { name?: unknown; slot?: unknown; header?: unknown; content?: unknown; weight?: unknown }
interface Packet { sections?: SectionView[] }
interface MessageSections { role: PacketSectionDraft["slot"]; sections: SectionView[] }
type WeighContent = (text: string) => number;

export interface ReplayedOperation {
    readonly tokens: number;
}

export interface RenderLogOptions {
    readonly acceptedAttachmentKinds?: ReadonlySet<PacketAttachment["kind"]>;
    // {§fs-namespace} Base for project-relative receipt addresses; null is headless.
    readonly projectRoot?: string | null;
    // {§emission-history}: operation weight on its first receipt, zero on subsequent fan-out receipts.
    readonly paired?: ReadonlyMap<string, ReplayedOperation>;
}

interface ReclaimableLogItem {
    readonly path: string;
    readonly tokens: number;
}

export interface RenderedLog {
    readonly content: string;
    // {§packet} — the records `content` joins with one blank line, in order.
    readonly records: readonly string[];
    readonly curationTargets: readonly ReclaimableLogItem[];
    // {§log-wire-format} — native deliveries selected for this request, in row order.
    readonly attachments: readonly PacketAttachment[];
}

interface RenderedLogRow {
    readonly content: string;
    readonly curationTarget: ReclaimableLogItem | null;
    readonly attachment: PacketAttachment | null;
}

export default class PacketWire {
    // {§packet} Render the sections in `slot` to one ChatMessage.content
    // string. Sections render in list order; empties are omitted (no empty headers on the wire);
    // JSON follows its H2 directly; other content has one blank line (null header is bare),
    // trailing newlines stripped, joined with a blank line.
    static renderSlot(sections: SectionView[], slot: PacketSectionDraft["slot"]): string {
        return sections
            .filter((s) => s.slot === slot)
            .map((s) => PacketWire.renderSection(s))
            .filter((p) => p.length > 0)
            .join("\n\n");
    }

    // One section → its markdown block, trailing newlines stripped. Empty
    // content renders to "" so renderSlot drops it. This is the unit the
    // per-section `weight` is measured over.
    static renderSection(s: SectionView): string {
        if (typeof s.content !== "string" || s.content.length === 0) return "";
        const header = typeof s.header === "string" && s.header.length > 0 ? s.header : null;
        const separator = s.content.startsWith("{") || s.content.startsWith("[") ? "\n" : "\n\n";
        return (header ? `## ${header}${separator}${s.content}` : s.content).replace(/\n+$/, "");
    }

    // Durable operation failures render as `{status, path}` JSON pointers to the log rows that
    // own their exact RFC 9457 results.
    static renderFailurePointers(failures: readonly FailurePointer[]): string {
        const pointers = failures.map((row) => JSON.stringify({ status: row.status, path: `log:///${row.coordinate}` }));
        return pointers.length === 0 ? "" : `[${pointers.join(",\n")}]`;
    }

    // {§operation-results} — non-terminal observations, deliberately separate from operation failures, in the
    // card's own callout form: the level picks the callout, the directive leads, the fact follows, the kind closes.
    static renderNotices(notices: readonly Notice[]): string {
        return notices.map((notice) => {
            const kind = typeof notice.kind === "string" ? notice.kind : "notice";
            const callout = notice.level === "error" ? "CAUTION" : notice.level === "warn" ? "WARNING" : "NOTE";
            const text = [notice.directive, notice.message]
                .filter((part): part is string => typeof part === "string")
                .map((part) => part.replace(/\s+/g, " ").trim())
                .filter((part) => part.length > 0)
                .join(" ");
            const position = notice.position?.type === "content-offset"
                ? ` @ ${String(notice.position.line)}:${String(notice.position.column)}`
                : "";
            const body = `${text}${position}`.trim();
            return `> [!${callout}]\n> ${body.length > 0 ? `${body} ` : ""}[${kind}]`;
        }).join("\n\n");
    }

    // The Open Work section ({§child-orientation}) — the OPPOSITE of advice: terse `{status, path}`
    // JSON pointers (same shape as the errors section) to the live things the session holds open: its
    // unconcluded sessions and its open streams. The model SEES them each turn and reasons for itself
    // (READ / SEND / KILL via the path). Orienting state, never an instruction; every list renders every
    // turn, `[]` when empty ({§child-orientation}).
    static renderOpenWork(sessions: readonly OpenWorkPointer[], streams: readonly OpenWorkPointer[], messages: readonly OpenWorkPointer[] = []): string {
        // {§message-arrival} {§loop-completion} — unclosed inbound requests and sent messages awaiting completion.
        return `{"sessions":${PacketWire.#pointers(sessions)},\n"streams":${PacketWire.#pointers(streams)},\n"messages":${PacketWire.#pointers(messages)}}`;
    }

    static #pointers(rows: readonly OpenWorkPointer[]): string {
        const pointers = rows.map((r) => JSON.stringify({
            ...(r.status === undefined ? {} : { status: r.status }),
            path: r.path,
            ...(typeof r.origin === "string" && r.origin.length > 0 ? { origin: r.origin } : {}),
            ...(typeof r.source === "string" && r.source.length > 0 ? { source: r.source } : {}),
            ...(typeof r.detail === "string" && r.detail.length > 0 ? { detail: r.detail } : {}),
        }));
        return pointers.length === 0 ? "[]" : `[${pointers.join(",\n")}]`;
    }

    // {§packet-inject} — each operator line is one callout, typed by its directive, ahead of the recap source.
    static renderRecap(lines: readonly string[], source: string): string {
        const callouts = lines.map((line) => `> [!${line.startsWith("YOU MUST") ? "IMPORTANT" : "TIP"}]\n> ${line}`);
        return [...callouts, ...(source.trim().length > 0 ? [source] : [])].join("\n\n");
    }

    // The git section content: the working-tree summary. "" when absent.
    static renderGit(git: GitStatusView | null): string {
        const status = git === null ? "" : PacketWire.#renderGitState(git);
        return status.length === 0 ? "" : `> [!NOTE]\n${status.split("\n").map((line) => `> ${line}`).join("\n")}`;
    }

    // The log section's content: the model's curated rows as Markdown-framed records ({§log-wire-format}).
    // Data only — no prose leads the records (the log carries rules for no one). Empty log → ""
    // (the section is omitted).
    static renderLog(entries: readonly LogEntryView[], weighContent: WeighContent, options: RenderLogOptions = {}): string {
        return PacketWire.renderLogWithAccounting(entries, weighContent, options).content;
    }

    // {§tokenomics} — the wire row and its reclaimable-body accounting come from one render
    // pass; packet assembly never re-parses its text.
    static renderLogWithAccounting(entries: readonly LogEntryView[], weighContent: WeighContent, options: RenderLogOptions = {}): RenderedLog {
        if (entries.length === 0) return { content: "", records: [], curationTargets: [], attachments: [] };
        const rows = PacketWire.#renderLogEntries(entries, weighContent, options);
        const records = rows.map(({ content }) => content);
        return {
            content: records.join("\n\n"),
            records,
            curationTargets: rows.flatMap(({ curationTarget }) =>
                curationTarget === null ? [] : [curationTarget]),
            attachments: rows.flatMap(({ attachment }) => attachment === null ? [] : [attachment]),
        };
    }

    // Read one section's content by name off a packet (Engine's or re-parsed).
    // The legible accessor — consumers name the section they want instead of
    // indexing a fixed shape. Missing section / non-string content → "".
    static sectionContent(packet: Packet, name: string): string {
        return (packet.sections ?? [])
            .filter((section) => PacketWire.#isSection(section, name) && typeof section.content === "string" && section.content.length > 0)
            .map(({ content }) => content).join("\n\n");
    }

    static #isSection(section: SectionView, name: string): boolean {
        return section.name === name || typeof section.name === "string" && section.name.startsWith(`${name}/`);
    }

    // {§packet-assembly}: retained roles and order, not today's section names, define a
    // historical request. An absent previous program leaves adjacent user sections together.
    static #messageSections(packet: Packet): MessageSections[] {
        const sections = packet.sections ?? [];
        const messages: MessageSections[] = [{ role: "system", sections: sections.filter(({ slot }) => slot === "system") }];
        for (const section of sections) {
            if (section.slot === "system" || PacketWire.renderSection(section).length === 0) continue;
            if (section.slot !== "user" && section.slot !== "assistant") throw new TypeError("packet section has an invalid message role");
            const last = messages.at(-1)!;
            if (last.role === section.slot) last.sections.push(section);
            else messages.push({ role: section.slot, sections: [section] });
        }
        if (messages.length === 1) messages.push({ role: "user", sections: [] });
        return messages;
    }

    static packetToWireMessages(packet: Packet): Array<ChatMessage & { content: string }> {
        return PacketWire.#messageSections(packet).map(({ role, sections }) => ({
            role, content: PacketWire.renderSlot(sections, role),
        }));
    }

    // {§log-wire-format} Orientation precedes telemetry on every receipt.
    static #canonicalJson(obj: Record<string, unknown>): string {
        return JSON.stringify(Object.fromEntries(Object.keys(obj).toSorted().map((key) => [key, obj[key]])));
    }

    // {§message-arrival} — an inbound SEND row: harness-published, the sender's statement as its
    // sent side. {§message-arrival}: a `source` names the actor; absence is the owner.
    static isArrival(e: { readonly op?: unknown; readonly origin?: unknown; readonly attrs?: unknown }): boolean {
        return PacketRowFacts.isArrival(e);
    }

    static #renderLogEntries(entries: readonly LogEntryView[], weighContent: WeighContent, options: RenderLogOptions): RenderedLogRow[] {
        const bodies = entries.map((e) => {
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            return LogBody.resolve({
                op,
                attrs: e.attrs,
                tx: e.tx,
                rx: e.rx,
                mimetypeTx: typeof e.mimetype_tx === "string" ? e.mimetype_tx : undefined,
                mimetypeRx: typeof e.mimetype_rx === "string" ? e.mimetype_rx : undefined,
            });
        });
        const visibility = entries.map((entry, index) =>
            PacketBodyFormat.visibleBody(entry, bodies[index]));
        return entries.map((e, index) => {
            const identity = PacketRowFacts.rowIdentity(e, options);
            // Parse rx once — reused for the matcher/items enrichment and the body.
            const parsedRx = typeof e.rx === "string" ? PacketRowFacts.safeParse(e.rx) : e.rx;
            const rx = isRecord(parsedRx) ? parsedRx : null;
            const facts = PacketRowFacts.rowResultFacts(identity, e, rx, bodies[index]);
            const paired = options.paired?.has(String(e.coordinate)) ?? false;
            const projected = paired && bodies[index].provenance === "authored"
                ? { body: "", projectedLineCount: 0, display: "folded" as const }
                : PacketBodyFormat.rowBody(identity, e, bodies[index], visibility[index], facts);
            return PacketWire.#rowAccounting(identity, e, visibility[index], projected, weighContent, options);
        });
    }

    // One stored log row as the renderer sees it: the durable columns decoded once, a transient
    // open row rendered open ({§emission-admission}).
    static entryView(r: StoredLogRow, transientOpenLogEntryId: number | null = null): LogEntryView {
        const parsedTx: unknown = r.mimetype_tx === "application/json" ? JSON.parse(r.tx) : r.tx;
        const tx = isRecord(parsedTx) ? parsedTx : typeof parsedTx === "string" ? parsedTx : null;
        const rx: unknown = r.mimetype_rx === "application/json" ? JSON.parse(r.rx) : r.rx;
        // {§tokenomics} — a READ row's anchors ride with its lines whatever its status: a receipt that
        // carries a prefix carries the prefix's anchors.
        const readResult = LogEntryProjection.op(r) === "READ" && isRecord(rx) && typeof rx.content === "string" ? rx : null;
        const rawLineAnchors = readResult !== null && Object.hasOwn(readResult, "lineAnchors") ? readResult.lineAnchors : undefined;
        if (rawLineAnchors !== undefined && !(Array.isArray(rawLineAnchors) && rawLineAnchors.every((anchor): anchor is string => typeof anchor === "string"))) {
            throw new TypeError("A READ result's lineAnchors field must be an array of strings.");
        }
        const lineAnchors: readonly string[] | undefined = rawLineAnchors;
        const rawLineNumberWidth = readResult !== null && Object.hasOwn(readResult, "lineNumberWidth") ? readResult.lineNumberWidth : undefined;
        if (rawLineNumberWidth !== undefined && !LineAnchors.isLineNumberWidth(rawLineNumberWidth)) {
            throw new TypeError("A READ result's lineNumberWidth field must be a valid decimal line width.");
        }
        if ((rawLineAnchors === undefined) !== (rawLineNumberWidth === undefined)) {
            throw new TypeError("A READ result's lineAnchors and lineNumberWidth fields must appear together.");
        }
        return {
            id: r.id,
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
            producer: r.producer,
            ...(lineAnchors === undefined ? {} : { lineAnchors }),
            ...(rawLineNumberWidth === undefined ? {} : { lineNumberWidth: rawLineNumberWidth }),
        };
    }

    // {§tokenomics} — the tokens one row would charge the packet, rendered exactly as the log
    // would render it, so the fit test and the gauge agree.
    static rowTokens(view: LogEntryView, weighContent: WeighContent, options: RenderLogOptions = {}): number {
        const [row] = PacketWire.#renderLogEntries([view], weighContent, options);
        if (row === undefined) throw new Error("rowTokens: one view renders one row");
        return row.curationTarget?.tokens ?? 0;
    }

    // The row's native attachment, a landed-unfit arrival's size, and the accounting field that
    // participates in the row it measures: iterate until its decimal width and therefore the
    // rendered row's curation weight are stable. {§log-wire-format}
    static #rowAccounting(
        identity: RowIdentity,
        e: LogEntryView,
        bodyVisibility: VisibleLogBody,
        projected: RowBody,
        weighContent: WeighContent,
        options: RenderLogOptions,
    ): RenderedLogRow {
        const { meta, op, coordinate, path, target } = identity;
        const { body, display } = projected;
        const nativeCandidate = op === "READ" && typeof e.status === "number" && e.status >= 200 && e.status < 300
            ? PacketWire.#attachmentOf(e.rx, e.target, coordinate, target) : null;
        const native = nativeCandidate !== null && (options.acceptedAttachmentKinds?.has(nativeCandidate.kind) ?? true)
            ? nativeCandidate : null;
        // {§tokenomics} — an arrival that did not fit landed folded with its size beside it: the lines
        // and tokens of the body the model can READ at this row's address.
        const unfit = PacketRowFacts.attrsOf(e).unfit;
        if (unfit !== null && typeof unfit === "object") meta.size = unfit;
        // {§log-wire-format}: retained native content shares the row's curation lifetime.
        const attachment = !(bodyVisibility.totalLines > 0 && bodyVisibility.fullyFolded)
            ? native
            : null;
        // {§log-wire-format}: one descriptive heading, the facts, the body.
        const render = (open: boolean, tokens: number): string => {
            const lines = [`### ${path}${identity.description === null ? "" : ` ${identity.description}`} · ${tokens}`];
            if (Object.keys(meta).length > 0) lines.push(PacketWire.#canonicalJson(meta));
            if (open) lines.push(body);
            return lines.join("\n");
        };
        const converge = (open: boolean, part: PacketAttachment | null): { content: string; tokens: number } => {
            if (part !== null) meta.tokensAttachment = part.weight;
            else delete meta.tokensAttachment;
            let tokens = 0;
            for (let pass = 0; pass < 8; pass += 1) {
                const next = weighContent(render(open, tokens)) + (part?.weight ?? 0) + (options.paired?.get(String(e.coordinate))?.tokens ?? 0);
                if (next === tokens) return { content: render(open, tokens), tokens };
                tokens = next;
            }
            throw new Error("packet log row accounting did not converge");
        };
        const rendered = converge(display === "open", attachment);
        return { content: rendered.content, curationTarget: { path, tokens: rendered.tokens }, attachment };
    }

    static #attachmentOf(
        rx: unknown,
        target: ActionTarget | null | undefined,
        coordinate: string | null,
        path: string | null,
    ): PacketAttachment | null {
        if (!isRecord(rx) || typeof rx.nativeContentHash !== "string") return null;
        const contentHash = rx.nativeContentHash;
        const pathname = typeof target?.pathname === "string" && target.pathname.length > 0
            ? target.pathname
            : typeof target?.raw === "string" ? target.raw : null;
        if (pathname === null || coordinate === null || path === null) return null;
        const scheme = target?.scheme ?? "file";
        const image = rx.image;
        if (isRecord(image) && typeof image.mimetype === "string" && isSafeInteger(image.width) && isSafeInteger(image.height)) {
            const { width, height } = image;
            return { contentHash, coordinate, path, scheme, pathname, mimetype: image.mimetype, kind: "image", width, height, weight: imageWeight(width, height) };
        }
        const document = rx.document;
        if (isRecord(document) && typeof document.mimetype === "string" && isSafeInteger(document.bytes)) {
            const pages = isSafeInteger(document.pages) ? document.pages : null;
            return {
                contentHash, coordinate, path, scheme, pathname, mimetype: document.mimetype, kind: "pdf",
                ...(pages === null ? {} : { pages }),
                weight: pdfWeight(pages, document.bytes),
            };
        }
        const audio = rx.audio;
        if (isRecord(audio) && typeof audio.mimetype === "string" && isSafeInteger(audio.bytes)) {
            const duration = typeof audio.duration === "number" && Number.isFinite(audio.duration) && audio.duration >= 0 ? audio.duration : null;
            return {
                contentHash, coordinate, path, scheme, pathname, mimetype: audio.mimetype, kind: "audio",
                ...(duration === null ? {} : { duration }),
                weight: audioWeight(duration, audio.bytes),
            };
        }
        return null;
    }

    // {§log-wire-format} — project retained native parts at their recorded user boundaries.
    static async wireMessages(
        packet: RequestPacket,
        bytesOf: (attachment: PacketAttachment) => Promise<Uint8Array>,
        accepts: (kind: PacketAttachment["kind"]) => boolean = () => true,
    ): Promise<ChatMessage[]> {
        const messages: ChatMessage[] = PacketWire.packetToWireMessages(packet);
        const attachments = (packet.attachments ?? []).filter(({ kind }) => accepts(kind));
        if (attachments.length === 0) return messages;
        const groups = PacketWire.#messageSections(packet);
        // {§log-wire-format}: current packets bind each native part to the section
        // ending at its READ. Preserve the recorded placement of older, unbound packets below.
        if (attachments.some(({ section }) => section !== undefined)) {
            for (const attachment of attachments) {
                if (attachment.section === undefined || !groups.some(({ role, sections }) => role === "user" && sections.some(({ name }) => name === attachment.section))) {
                    throw new Error("native packet attachment requires its recorded user section");
                }
            }
            return Promise.all(groups.map(async ({ role, sections }, index) => {
                if (!sections.some(({ name }) => attachments.some(({ section }) => section === name))) return messages[index];
                const parts: ChatContentPart[] = [];
                for (const [at, section] of sections.entries()) {
                    parts.push({ type: "text", text: `${at === 0 ? "" : "\n\n"}${PacketWire.renderSection(section)}` });
                    for (const attachment of attachments.filter((candidate) => candidate.section === section.name)) {
                        parts.push({ type: "text", text: `\n\n${PacketWire.attachmentCaption(attachment)}` });
                        parts.push({ type: "file", data: await bytesOf(attachment), mediaType: attachment.mimetype });
                    }
                }
                return { role, content: parts };
            }));
        }
        const logIndex = groups.findIndex(({ role, sections }) => role === "user" && sections.some(({ name }) => name === "log"));
        const index = logIndex < 0 ? groups.findIndex(({ role }) => role === "user") : logIndex;
        if (index < 0) throw new Error("native packet attachments require a user message");
        // {§log-wire-format}: native evidence belongs to the log's message. A retained
        // packet may also hold its previous program in that message; keep its recorded tail.
        const preceding = groups[index].sections.filter(({ name }) => name !== "emission-history");
        const previous = groups[index].sections.find(({ name }) => name === "emission-history");
        const parts: ChatContentPart[] = [{ type: "text", text: PacketWire.renderSlot(preceding, "user") }];
        for (const attachment of attachments) {
            const bytes = await bytesOf(attachment);
            parts.push({ type: "text", text: PacketWire.attachmentCaption(attachment) });
            parts.push({ type: "file", data: bytes, mediaType: attachment.mimetype });
        }
        const tail = previous === undefined ? "" : PacketWire.renderSection(previous);
        if (tail.length > 0) parts.push({ type: "text", text: `\n\n${tail}` });
        return messages.map((message, at) => at === index ? { role: "user", content: parts } : message);
    }

    // {§log-wire-format} — the part's identity: a native part on the user turn otherwise reads as
    // an arrival, and the model cannot tell that the READ row is what keeps it in the packet.
    static attachmentCaption(attachment: PacketAttachment): string {
        const facts = [attachment.mimetype];
        if (attachment.width !== undefined && attachment.height !== undefined) facts.push(`${attachment.width}×${attachment.height} px`);
        if (attachment.pages !== undefined) facts.push(`${attachment.pages} pages`);
        if (attachment.duration !== undefined) facts.push(`${attachment.duration} s`);
        return `log:///${attachment.coordinate}/READ (${attachment.path}) (${facts.join(", ")}): the bytes of that READ row, retained until it is KILLed. Not a new arrival.`;
    }

    // {§packet-inject}: the count line, then one bounded line per non-empty class. Untracked paths are
    // named because they are NOT members ({§membership}) — the user admits them.
    static #renderGitState(git: GitStatusView): string {
        const sync = git.ahead > 0 || git.behind > 0 ? ` (↑${git.ahead} ↓${git.behind})` : "";
        const position = git.branch === null ? "detached HEAD" : `branch \`${git.branch}\`${git.unborn ? " (no commits)" : ""}`;
        const head = `${position}${sync} — ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked`;
        const files = git.files ?? [];
        const path = (p: string): string => `\`${p}\``;
        const untracked = files.filter((f) => f.status === "??");
        const classes: [string, string[]][] = [
            ["staged", files.filter((f) => f.status !== "??" && f.status[0] !== " ").map((f) => path(f.path))],
            ["unstaged", files.filter((f) => f.status !== "??" && f.status[1] !== " ").map((f) => path(f.path))],
            // An untracked file a definition or a creation record admits is a member; the rest are dark.
            ["untracked members", untracked.filter((f) => f.member != null).map((f) => `${path(f.path)} (${f.member})`)],
            ["untracked (not members)", untracked.filter((f) => f.member == null).map((f) => path(f.path))],
        ];
        const lines = classes
            .filter(([, items]) => items.length > 0)
            .map(([label, items]) => {
                const paths = GitState.renderedPaths();
                const shown = items.slice(0, paths).join(" · ");
                const more = items.length > paths ? ` (+${items.length - paths} more)` : "";
                return `${label}: ${shown}${more}`;
            });
        return [head, ...lines].join("\n");
    }
}
