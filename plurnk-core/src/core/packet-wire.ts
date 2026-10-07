import { TurnDisposition } from "@plurnk/plurnk-contracts";
// Packet → wire markdown projection. Single source of truth for how the
// Packet's ordered list of sections renders to ChatMessage.content
// strings the LLM receives. Engine imports this for the wire payload; the
// digest tool imports it to write byte-identical <stem>.{system,user}.md
// files. No second implementation, no drift.
//
// Format and omission rules are owned by {§packet-markdown}. Section producers
// supply names and typed content; this projection preserves their ordered evidence.

import type { PacketAttachment, RequestPacket } from "./StoredPacket.ts";
import type { ChatContentPart, ChatMessage } from "@plurnk/plurnk-providers";
import { relative, sep } from "node:path";
import { Problems, Validator, type ProblemDetails, type RangeExtent, type TextLineMarker, type TextRegion } from "@plurnk/plurnk-contracts";
import { TextCoordinates, type TextLine } from "@plurnk/plurnk-mimetypes";
import BodyPreview from "../content/body-preview.ts";
import { renderTarget } from "./plurnk-uri.ts";
import GitState, { type GitStatus } from "./git-state.ts";
import LogBody, { type ResolvedLogBody } from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import LogVisibility, { type LogFoldRanges } from "./LogVisibility.ts";
import ScopeFormat from "../content/scope-format.ts";
import PatternEdits from "../content/pattern-edits.ts";
import { Results as SchemeResults, type MatchEvidence } from "@plurnk/plurnk-schemes";
import {
    assertEditReceipt,
    assertResourceEffects,
    LineAnchors,
    type EditReceipt,
} from "../content/index.ts";

// {§packet-stored-shape} — sections arrive from both the in-memory request and
// the durable packet re-parsed by the digest. The latter uses the loose view
// below and is narrowed at the rendering boundary.
interface ActionTarget {
    kind?: unknown;
    raw?: unknown;
    scheme?: string | null;
    hostname?: string | null;
    port?: number | null;
    pathname?: string | null;
    query?: string | null;
    fragment?: string | null;
    username?: string | null;
    password?: string | null;
}
// The durable statement supplies operand identity and bodies without asking the
// packet mirror to re-serialize the model's complete emission tag.
interface StatementTx {
    aside?: unknown;
    target?: ActionTarget | null;
    lineMarker?: unknown;
    metadata?: readonly string[] | null;
    source?: StatementTx;
    destination?: StatementTx;
    matcher?: { raw?: unknown } | null;
    body?: string | null;
}
interface RxView {
    attachments?: unknown;
    content?: unknown;
    resource?: unknown;
    matched?: unknown;
    matches?: unknown;
    channels?: unknown;
    answers?: unknown;
    terminal?: unknown;
    exitCode?: unknown;
    page?: unknown;
    mimetype?: unknown;
    startLine?: unknown;
    region?: unknown;
    itemsWeightTotal?: unknown;
    returnedItemsWeightTotal?: unknown;
    matchLocationCount?: unknown;
    range?: unknown;
    image?: unknown;
    document?: unknown;
    audio?: unknown;
    receipt?: unknown;
    effects?: unknown;
}
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
interface LogEntryView {
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
    // {§emission-row}: the producer of the row's turn, which authored an emission row's emission.
    producer?: unknown;
    lineAnchors?: readonly string[];
    lineNumberWidth?: number;
}
interface FailurePointer { status?: unknown; coordinate?: unknown }
interface NoticeView {
    kind?: unknown;
    message?: unknown;
    position?: { type?: unknown; line?: unknown; column?: unknown } | null;
}
// Loose view of a section re-parsed from `turns.packet` JSON (the digest path).
interface SectionView { name?: unknown; slot?: unknown; header?: unknown; content?: unknown; weight?: unknown }
interface Packet { sections?: SectionView[] }
type WeighContent = (text: string) => number;
interface RenderLogOptions {
    readonly acceptedAttachmentKinds?: ReadonlySet<PacketAttachment["kind"]>;
    // {§fs-namespace} Base for project-relative receipt addresses; null is headless.
    readonly projectRoot?: string | null;
    // {§context-own-rows-fit} — the rows the wall has taken for this packet, by log entry id: each renders
    // bodiless, its size and address in place of its body.
    readonly bodiless?: ReadonlySet<number>;
}

interface ReclaimableLogItem {
    readonly path: string;
    readonly tokens: number;
}

// {§context-own-rows-fit} — a row still carrying a body or a native part the wall may take, and the
// tokens it charges as rendered.
export interface BodiedLogRow {
    readonly id: number;
    readonly tokens: number;
}

export interface RenderedLog {
    readonly content: string;
    // {§packet-items} — the records `content` joins with one blank line, in order.
    readonly records: readonly string[];
    readonly curationTargets: readonly ReclaimableLogItem[];
    // {§packet-attachment-parts} — native deliveries selected for this request, in row order.
    readonly attachments: readonly PacketAttachment[];
    // {§emission-row} — the emissions the rendered rows announce, in row order.
    readonly emissions: readonly RenderedEmission[];
    // {§context-own-rows-fit} — the rows the wall may still take, in row order: newest last.
    readonly bodied: readonly BodiedLogRow[];
}

// {§emission-row} — an announced emission: its row's coordinate, its frozen canonical text, and the
// weight its row charges for it.
export interface RenderedEmission {
    readonly coordinate: string;
    // {§emission-row} — the row's frozen projection, and the weight of what the wire delivers of it.
    readonly content: string;
    readonly weight: number;
}
// {§packet-attachment-parts} — the attachment kinds and their readout weights live in one table.
import { audioWeight, imageWeight, pdfWeight } from "./attachments.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";

interface RenderedLogRow {
    readonly content: string;
    readonly curationTarget: ReclaimableLogItem | null;
    readonly attachment: PacketAttachment | null;
    readonly emission: RenderedEmission | null;
    readonly bodied: BodiedLogRow | null;
}

interface VisibleLogBody {
    readonly content: string;
    readonly ordinals: readonly number[];
    readonly readableContent: string;
    readonly readableOrdinals: readonly number[];
    readonly folded: LogFoldRanges;
    readonly trimmed: LogFoldRanges;
    readonly totalLines: number;
    readonly fullyFolded: boolean;
}

// One log row through the four stages of its rendering: identity, result facts, body, accounting.
interface RowIdentity {
    readonly meta: Record<string, unknown>;
    readonly op: string | null;
    readonly tx: StatementTx | null;
    readonly coordinate: string | null;
    readonly path: string;
    readonly renderedLeaf: string;
    readonly target: string | null;
    readonly description: string | null;
}
interface RowResultFacts {
    readonly matches?: readonly MatchEvidence[];
    readonly findItems: number | null;
    readonly range: RangeExtent | null;
    readonly structuredMutationReceipt: boolean;
}
interface RowBody {
    readonly body: string;
    readonly projectedLineCount: number;
    readonly display: "none" | "folded" | "open";
}

export default class PacketWire {
    // {§packet-markdown} Render the sections in `slot` to one ChatMessage.content
    // string. Sections render in list order; empties are omitted (no empty headers on the wire);
    // JSON follows its H2 directly; other content has one blank line (null header is bare),
    // trailing newlines stripped, joined with a blank line.
    static renderSlot(sections: SectionView[], slot: "system" | "user"): string {
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
    static renderFailurePointers(failures: unknown): string {
        const rows = Array.isArray(failures) ? failures as FailurePointer[] : [];
        const pointers = rows
            .filter((row) => typeof row.status === "number" && typeof row.coordinate === "string")
            .map((row) => JSON.stringify({ status: row.status, path: `log:///${row.coordinate}` }));
        return pointers.length === 0 ? "" : `[${pointers.join(",\n")}]`;
    }

    // Non-terminal model-facing observations are deliberately separate from
    // operation failures. Producer messages are normalized; typed positions remain legible.
    static renderNotices(notices: unknown): string {
        const observations = Array.isArray(notices) ? notices as NoticeView[] : [];
        return observations.map((notice) => {
            const kind = typeof notice.kind === "string" ? notice.kind : "notice";
            const rawMessage = typeof notice.message === "string"
                ? notice.message.replace(/\s+/g, " ").trim()
                : "";
            const message = rawMessage;
            const position = notice.position?.type === "content-offset"
                ? ` @ ${String(notice.position.line)}:${String(notice.position.column)}`
                : "";
            return `* ${kind}${message.length > 0 ? `: ${message}` : ""}${position}`;
        }).join("\n");
    }

    // The Delegation section ({§child-orientation}) — the OPPOSITE of advice: terse `{status, path}`
    // JSON pointers (same shape as the errors section) to the live things the worker holds, under the
    // word the teaching uses for handing work out: its unconcluded workers and its open streams. The
    // model SEES them each turn and reasons for itself (READ / SEND / KILL via the path). Orienting
    // state, never an instruction; both lists render every turn, `[]` when empty ({§packet-empty-sections}).
    static renderDelegation(workers: unknown, streams: unknown): string {
        return `{"workers":${PacketWire.#pointers(workers)},\n"streams":${PacketWire.#pointers(streams)}}`;
    }

    static #pointers(rows: unknown): string {
        const items = Array.isArray(rows) ? (rows as Array<{ status: unknown; path: unknown; detail?: unknown }>) : [];
        const pointers = items.map((r) => JSON.stringify({
            status: r.status,
            path: r.path,
            ...(typeof r.detail === "string" && r.detail.length > 0 ? { detail: r.detail } : {}),
        }));
        return pointers.length === 0 ? "[]" : `[${pointers.join(",\n")}]`;
    }

    // The git section content: the working-tree summary. "" when absent.
    static renderGit(git: unknown): string {
        const status = git === null || git === undefined ? "" : PacketWire.#renderGitState(git as GitStatus);
        return status.length === 0 ? "" : `> [!NOTE]\n${status.split("\n").map((line) => `> ${line}`).join("\n")}`;
    }

    // The log section's content: the model's curated rows as Markdown-framed records ({§log-wire-format}).
    // Data only — no prose leads the records (the log carries rules for no one). Empty log → ""
    // (the section is omitted).
    static renderLog(entries: unknown, weighContent: WeighContent, options: RenderLogOptions = {}): string {
        return PacketWire.renderLogWithAccounting(entries, weighContent, options).content;
    }

    // {§context-gauge} — the wire row and its reclaimable-body accounting come from one render
    // pass; packet assembly never re-parses its text.
    static renderLogWithAccounting(entries: unknown, weighContent: WeighContent, options: RenderLogOptions = {}): RenderedLog {
        const log = Array.isArray(entries) ? (entries as LogEntryView[]) : [];
        if (log.length === 0) return { content: "", records: [], curationTargets: [], attachments: [], emissions: [], bodied: [] };
        const rows = PacketWire.#renderLogEntries(log, weighContent, options);
        const records = rows.map(({ content }) => content);
        return {
            content: records.join("\n\n"),
            records,
            curationTargets: rows.flatMap(({ curationTarget }) =>
                curationTarget === null ? [] : [curationTarget]),
            attachments: rows.flatMap(({ attachment }) => attachment === null ? [] : [attachment]),
            emissions: rows.flatMap(({ emission }) => emission === null ? [] : [emission]),
            bodied: rows.flatMap(({ bodied }) => bodied === null ? [] : [bodied]),
        };
    }

    // Read one section's content by name off a packet (Engine's or re-parsed).
    // The legible accessor — consumers name the section they want instead of
    // indexing a fixed shape. Missing section / non-string content → "".
    static sectionContent(packet: Packet, name: string): string {
        const s = packet.sections?.find((x) => x.name === name);
        return typeof s?.content === "string" ? s.content : "";
    }

    // {§packet-wire-envelope} — the packet as a transcript: the system slot, then the user sections in
    // order, split after each placed emission row so that row's emission follows as the worker's own
    // assistant message. The user contents joined by one blank line equal renderSlot(user) byte for
    // byte; the request always closes on a user message.
    static packetToWireMessages(packet: Packet, emissions: ReadonlyMap<string, string>): Array<ChatMessage & { content: string }> {
        const sections = packet.sections ?? [];
        const messages: Array<ChatMessage & { content: string }> = [{ role: "system", content: PacketWire.renderSlot(sections, "system") }];
        let pending: string[] = [];
        for (const section of sections) {
            if (section.slot !== "user") continue;
            const rendered = PacketWire.renderSection(section);
            if (rendered.length === 0) continue;
            if (section.name !== "log") {
                pending.push(rendered);
                continue;
            }
            for (const { content, coordinate } of PacketWire.#logRecords(rendered)) {
                pending.push(content);
                const frozen = coordinate === null ? undefined : emissions.get(coordinate);
                const emission = frozen === undefined ? "" : PacketWire.deliveredEmission(frozen);
                // {§emission-row}: an emission of only NOTE and WAIT delivers nothing; its row stands.
                if (emission.length === 0) continue;
                messages.push({ role: "user", content: pending.join("\n\n") });
                messages.push({ role: "assistant", content: emission });
                pending = [];
            }
        }
        const closing = pending.join("\n\n");
        if (closing.length === 0 && messages.at(-1)?.role === "assistant") throw new Error("a request never ends on an emission: nothing follows the last one");
        messages.push({ role: "user", content: closing });
        return messages;
    }

    // {§emission-row} — bodies are logged, never replayed: a statement with a body is its heading and an
    // empty closer, and one without a body is one line, so the shape says whether anything was left out. A
    // NOTE or WAIT, and a parameterless KILL or SEND, is not replayed at all: its own row shows it whole.
    // Deliberately a text filter: the frozen projection is TurnOps' own rendering, whose fences are longer
    // than any backtick run inside them, so a block is read back by its fences alone, whatever era froze it.
    static deliveredEmission(frozen: string): string {
        const lines = frozen.split("\n");
        const kept: string[] = [];
        for (let index = 0; index < lines.length;) {
            const fence = /^`{3,}/u.exec(lines[index]!)?.[0];
            if (fence === undefined) throw new Error(`an emission block opens with a fence, not ${JSON.stringify(lines[index])}`);
            const end = lines.findIndex((line, at) => at > index && (line === fence || line.startsWith(`${fence} <!-- `)));
            if (end === -1) throw new Error("an emission block closes with its own fence");
            const heading = lines[index]!;
            if (!new RegExp(`^${fence}(?:(?:NOTE|WAIT)\\b|(?:KILL|SEND)(?:\\s+<!--.*-->)?\\s*$)`, "u").test(heading)) {
                kept.push(end > index + 1 ? `${heading}\n${fence}` : `${heading}${fence}`);
            }
            index = end + 2;
        }
        return kept.join("\n\n");
    }

    // {§emission-row} — the coordinates of the emission rows present in the final log section, in order.
    // Every emission row must be announced by the render pass that built the map.
    static placedEmissions(sections: readonly SectionView[], emissions: ReadonlyMap<string, string>): string[] {
        const log = sections.find((section) => section.slot === "user" && section.name === "log");
        if (log === undefined) return [];
        const placed: string[] = [];
        for (const { coordinate, leaf } of PacketWire.#logRecords(PacketWire.renderSection(log))) {
            if (coordinate === null) continue;
            if (emissions.has(coordinate)) {
                if (placed.includes(coordinate)) throw new Error(`log:///${coordinate}/emission appears twice in one log section`);
                placed.push(coordinate);
            } else if (leaf === "emission") {
                throw new Error(`log:///${coordinate}/emission reached the log section without its emission`);
            }
        }
        return placed;
    }

    static #logRecords(rendered: string): Array<{ content: string; coordinate: string | null; leaf: string | null }> {
        return rendered.split(/\n\n(?=### log:\/\/\/)/u).map((content) => {
            const match = /^### log:\/\/\/(\d+\/\d+\/\d+)(?:\/(\S*))?(?=\s|$)/mu.exec(content);
            return { content, coordinate: match?.[1] ?? null, leaf: match?.[2] ?? null };
        });
    }

    // Number a non-READ body line as `<N>:<line>` — `N:` followed by NO separator whitespace
    // ({§render-rule-line-navigable-prefix}): the leading digit prevents column-zero fence collisions and gives
    // the model line refs for free (`READ (...) <42-46>`), while the absence of any separator means a
    // reproduced line has nothing between `N:` and the content to copy — the hard-tab separator used
    // to leak into edit bodies and corrupt indentation. The content's OWN leading whitespace is
    // content, preserved verbatim. `N` is left-padded to the body's line-range width so every body
    // keeps one stable content column; FIND rows pass the complete result-set width so their pages
    // share a column with the whole set.
    static #numberLines(body: string, start = 1, width = 0): string {
        let line = start;
        if (width <= 0) {
            const breaks = body.match(/(\r\n|\r(?!\n)|\n)(?=[\s\S])/g)?.length ?? 0;
            width = String(start + breaks).length;
        }
        const prefix = (): string => `${String(line++).padStart(width, " ")}:`;
        return `${prefix()}${body.replace(
            /(\r\n|\r(?!\n)|\n)(?=[\s\S])/g,
            (separator) => `${separator}${prefix()}`,
        )}`;
    }

    static #numberSelectedLines(
        body: string,
        ordinals: readonly number[],
        startLine: number,
        lineAnchors: readonly string[] | null,
        lineNumberWidth: number | null,
        numericLineNumberWidth: number,
        sourceLineNumbers: readonly number[] | null,
    ): string {
        const lines = TextCoordinates.logicalLines(body);
        if (lines.length !== ordinals.length) {
            throw new TypeError("A sparse log-body projection requires one source ordinal per rendered line.");
        }
        if (sourceLineNumbers !== null && ordinals.some((ordinal) => ordinal < 1 || ordinal > sourceLineNumbers.length)) {
            throw new TypeError("A sparse log-body projection's ordinals must address its source line numbers.");
        }
        const displayed = ordinals.map((ordinal) => sourceLineNumbers === null ? startLine + ordinal - 1 : sourceLineNumbers[ordinal - 1]!);
        const width = lineAnchors === null
            ? numericLineNumberWidth > 0
                ? numericLineNumberWidth
                : String(Math.max(...displayed)).length
            : lineNumberWidth ?? 0;
        if (lineAnchors !== null && !LineAnchors.isLineNumberWidth(width)) {
            throw new TypeError("An anchored sparse log-body projection requires a valid source line width.");
        }
        return lines.map((line, index) => {
            const ordinal = ordinals[index]!;
            const lineNumber = displayed[index]!;
            const content = body.slice(line.start, line.contentEnd);
            if (lineAnchors === null) {
                return `${String(lineNumber).padStart(width, " ")}:${content}${line.separator}`;
            }
            const anchor = lineAnchors[ordinal - 1];
            if (!LineAnchors.isAnchor(anchor)) {
                throw new TypeError(`A sparse READ projection has no line anchor for body line ${ordinal}.`);
            }
            // {§line-anchors}: ` 42<@abcde>text`, exactly as LineAnchors.render frames a whole projection.
            return `${String(lineNumber).padStart(width)}<${anchor}>${content}${line.separator}`;
        }).join("");
    }

    // The single content-body renderer EVERY output-emitting op routes through.
    // Exact READ content receives source-width-aligned `@hash N:`; other textual bodies receive `N:`.
    // Matchers consume canonical content before this presentation projection.
    // Empty content produces no body.
    static #renderContentBody(
        content: string,
        startLine: number | null = 1,
        lineAnchors: readonly string[] | null = null,
        lineNumberWidth: number | null = null,
        numericLineNumberWidth = 0,
        lineOrdinals: readonly number[] | null = null,
        sourceLineNumbers: readonly number[] | null = null,
    ): string {
        if (content.length === 0) return "";
        // `startLine === null` means the producer already supplied numbered
        // content; re-numbering would duplicate its coordinates.
        const rendered = startLine !== null
            ? lineOrdinals !== null
                ? PacketWire.#numberSelectedLines(
                    content,
                    lineOrdinals,
                    startLine,
                    lineAnchors,
                    lineNumberWidth,
                    numericLineNumberWidth,
                    sourceLineNumbers,
                )
                : lineAnchors === null
                    ? PacketWire.#numberLines(content, startLine, numericLineNumberWidth)
                    : LineAnchors.render(content, startLine, lineAnchors, lineNumberWidth ?? 0)
            : content;
        return PacketWire.#frameBody(rendered);
    }

    // Tolerant JSON parser for log entries' persisted rx/tx strings. The engine
    // pre-parses application/json mimetypes; malformed stored text is not JSON.
    static #safeParse(s: string): unknown {
        try { return JSON.parse(s); } catch { return null; }
    }

    // {§log-wire-format} Orientation precedes telemetry on every receipt.
    static #canonicalJson(obj: Record<string, unknown>): string {
        return JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((key) => [key, obj[key]])));
    }

    static #receiptMeta(value: unknown): Record<string, string | number> {
        const receipt: EditReceipt = assertEditReceipt(value);
        // The durable receipt keeps the full revision for forensics; the model gets no token it
        // cannot use.
        const head = {
            extent: `${receipt.unit} ${receipt.before}->${receipt.after}`,
            ...(receipt.parseIssues === undefined
                ? {}
                : { parseIssues: `${receipt.parseIssues.before}→${receipt.parseIssues.after}` }),
        };
        if ("effect" in receipt) {
            return {
                ...head,
                change: `-${receipt.effect.removed} +${receipt.effect.inserted}`,
                effect: `${receipt.effect.source} -> ${receipt.effect.result}`,
                // {§edit-receipt-removed-text} — what a deletion took, so it can be put back from the receipt.
                ...(receipt.effect.removedText === undefined ? {} : { removed: receipt.effect.removedText }),
            };
        }
        return {
            ...head,
            disposition: receipt.disposition,
            requested: receipt.requested,
            ...(receipt.replacement === undefined
                ? {}
                : {
                    change: `-${receipt.replacement.removed} +${receipt.replacement.inserted}`,
                    replacement: `${receipt.replacement.source} -> ${receipt.replacement.result}`,
                }),
        };
    }

    // {§log-wire-format} Every body line carries its ordinary text coordinate,
    // which makes an empty Markdown line and an H3 record boundary unavailable
    // to source content. Already-numbered producer output is checked here too.
    static #frameBody(body: string): string {
        const endsWithLineBreak = /(?:\r\n|\r|\n)$/.test(body);
        const lines = body.split(/\r\n|\r|\n/);
        const contentLines = endsWithLineBreak ? lines.slice(0, -1) : lines;
        const unframed = contentLines.find((line) => !/^ *[1-9]\d*:/.test(line) && !LineAnchors.isAnchoredLine(line));
        if (contentLines.length === 0 || unframed !== undefined) {
            throw new TypeError(`A packet log body requires a positive coordinate prefix on every physical line; got ${JSON.stringify((unframed ?? "").slice(0, 80))}.`);
        }
        return endsWithLineBreak ? body.replace(/(?:\r\n|\r|\n)$/, "") : body;
    }

    // {§log-address-metadata} — row identity belongs to the H3, not its operand metadata.
    static #entryPath(coordinate: string | null, leaf: string): string {
        if (coordinate === null) throw new TypeError("A packet log row requires an addressable coordinate.");
        return `log:///${coordinate}/${leaf}`;
    }

    static #visibleBody(
        entry: LogEntryView,
        body: ReturnType<typeof LogBody.resolve>,
    ): VisibleLogBody {
        const trimmed = LogVisibility.parse(entry.folded ?? LogVisibility.OPEN);
        const folded = LogVisibility.combine(LogVisibility.parse(entry.initial_folded ?? LogVisibility.OPEN), trimmed);
        const lines = TextCoordinates.logicalLines(body.content);
        const totalLines = lines.length;
        const clipped = LogVisibility.clipped(folded, totalLines);
        const ordinals = LogVisibility.visibleLineOrdinals(clipped, totalLines);
        const readableOrdinals = LogVisibility.visibleLineOrdinals(trimmed, totalLines);
        const select = (selected: readonly number[]) => selected.map((ordinal) => {
            const line = lines[ordinal - 1]!;
            return body.content.slice(line.start, line.end);
        }).join("");
        return {
            content: select(ordinals),
            ordinals,
            readableContent: select(readableOrdinals),
            readableOrdinals,
            folded: clipped,
            trimmed: LogVisibility.clipped(trimmed, totalLines),
            totalLines,
            fullyFolded: LogVisibility.fullyFolded(clipped, totalLines),
        };
    }

    // {§message-arrival} — an inbound SEND row: harness-published, the sender's statement as its
    // sent side. {§message-causal-source}: a `source` names the actor; absence is the owner.
    static isArrival(e: { readonly op?: unknown; readonly origin?: unknown; readonly attrs?: unknown }): boolean {
        if (e.op !== "SEND" || e.origin !== "_plurnk") return false;
        const attrs = typeof e.attrs === "string" ? JSON.parse(e.attrs) as unknown : e.attrs;
        return attrs !== null && typeof attrs === "object" && (attrs as { kind?: unknown }).kind === "message";
    }

    // {§markerless-first-page} — a body the model did not author or ask for exactly takes its first page in
    // the packet: not the model's own row, not a retrieval (paged at its source), not an emission row,
    // and not the operator's message, which keeps its own rule ({§message-projection}).
    static #receivedBody(e: LogEntryView, op: string | null): boolean {
        if (e.origin === "model" || op === "READ" || op === "FIND" || LogEntryProjection.isEmission(e)) return false;
        if (PacketWire.isArrival(e)) {
            const source = typeof e.source === "string" ? e.source : null;
            return source !== null && source.startsWith("worker://");
        }
        return true;
    }

    // One preview function for every bounded model-facing projection. Lines protect ordinary
    // documents and Unicode characters protect a single-line bomb. Once a physical line is complete,
    // a character cut retreats to that line boundary rather than exposing a partial coordinate prefix.
    static #preview(text: string): { text: string; cut: boolean; chunk: string | null } {
        const coordinates = new TextCoordinates(text);
        const physicalLines = coordinates.logicalLines();
        const { end } = BodyPreview.select(text);
        const cut = end < text.length;
        return {
            text: text.slice(0, end),
            cut,
            chunk: cut ? PacketWire.#chunk(coordinates, physicalLines, end, text.length) : null,
        };
    }

    static #chunk(coordinates: TextCoordinates, lines: readonly TextLine[], end: number, completeEnd: number): string {
        const finalCompleteLine = lines.findIndex((line) => line.separator.length > 0 && line.end === end);
        if (finalCompleteLine !== -1) {
            const selected = ScopeFormat.lines(1, finalCompleteLine + 1);
            if (finalCompleteLine + 1 === lines.length) {
                throw new Error("a bounded body chunk must differ from its complete line extent");
            }
            return `${selected} of ${ScopeFormat.count("line", lines.length)}`;
        }
        const selectedRegion = coordinates.regionFromOffsets(0, end);
        const completeRegion = coordinates.regionFromOffsets(0, completeEnd);
        if (selectedRegion === null || completeRegion === null) {
            throw new Error("a character-bound body chunk must resolve to exact text coordinates");
        }
        const selected = ScopeFormat.region(selectedRegion);
        const complete = ScopeFormat.region(completeRegion);
        if (selected === complete) {
            throw new Error("a bounded body chunk must differ from its complete text extent");
        }
        return `${selected} of ${complete}`;
    }

    static #sparseChunk(completeContent: string, visibleContent: string, visibleOrdinals: readonly number[], projectedContent: string): string {
        const end = projectedContent.length;
        const coordinates = new TextCoordinates(visibleContent);
        const lines = coordinates.logicalLines();
        const finalCompleteLine = lines.findIndex((line) => line.separator.length > 0 && line.end === end);
        if (finalCompleteLine !== -1) {
            const selectedOrdinals = visibleOrdinals.slice(0, finalCompleteLine + 1);
            const runs: Array<[number, number]> = [];
            for (const ordinal of selectedOrdinals) {
                const previous = runs.at(-1);
                if (previous === undefined || ordinal !== previous[1] + 1) runs.push([ordinal, ordinal]);
                else previous[1] = ordinal;
            }
            const selected = runs.map(([start, finish]) => ScopeFormat.lines(start, finish)).join(",");
            return `${selected} of ${ScopeFormat.count("line", TextCoordinates.logicalLines(completeContent).length)}`;
        }
        const local = coordinates.regionFromOffsets(0, end);
        const complete = new TextCoordinates(completeContent).regionFromOffsets(0, completeContent.length);
        if (local === null || complete === null) {
            throw new Error("a sparse character-bound chunk must resolve to exact text coordinates");
        }
        const startLine = visibleOrdinals[local.startLine - 1];
        const endLine = visibleOrdinals[local.endLine - 1];
        if (startLine === undefined || endLine === undefined) {
            throw new Error("a sparse character-bound chunk must map to canonical body lines");
        }
        return `${ScopeFormat.region({ ...local, startLine, endLine })} of ${ScopeFormat.region(complete)}`;
    }

    static #renderLogEntries(entries: LogEntryView[], weighContent: WeighContent, options: RenderLogOptions): RenderedLogRow[] {
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
            PacketWire.#visibleBody(entry, bodies[index]!));
        return entries.map((e, index) => {
            const identity = PacketWire.#rowIdentity(e, options);
            // Parse rx once — reused for the matcher/items enrichment and the body.
            const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as RxView | null;
            const facts = PacketWire.#rowResultFacts(identity, e, rx, bodies[index]!);
            const projected = PacketWire.#rowBody(identity, e, bodies[index]!, visibility[index]!, facts);
            return PacketWire.#rowAccounting(identity, e, bodies[index]!, visibility[index]!, projected, weighContent, options);
        });
    }

    static #attrsOf(e: { readonly attrs?: unknown }): Record<string, unknown> {
        const attrs = typeof e.attrs === "string" ? PacketWire.#safeParse(e.attrs) : e.attrs;
        return attrs !== null && typeof attrs === "object" && !Array.isArray(attrs) ? attrs as Record<string, unknown> : {};
    }

    // One stored log row as the renderer sees it: the durable columns decoded once, a transient
    // open row rendered open ({§invalid-emission-attempts}).
    static entryView(r: StoredLogRow, transientOpenLogEntryId: number | null = null): LogEntryView {
        const tx = (r.mimetype_tx === "application/json" ? JSON.parse(r.tx) : r.tx) as StatementTx | string | null;
        const rx = r.mimetype_rx === "application/json" ? JSON.parse(r.rx) as unknown : r.rx;
        // {§context-fit} — a READ row's anchors ride with its lines whatever its status: a receipt that
        // carries a prefix carries the prefix's anchors.
        const readResult = LogEntryProjection.op(r) === "READ" && rx !== null && typeof rx === "object" && typeof (rx as { content?: unknown }).content === "string";
        const rawLineAnchors = readResult && Object.hasOwn(rx, "lineAnchors") ? (rx as { lineAnchors: unknown }).lineAnchors : undefined;
        if (rawLineAnchors !== undefined && !Array.isArray(rawLineAnchors)) {
            throw new TypeError("A READ result's lineAnchors field must be an array.");
        }
        const lineAnchors = rawLineAnchors as readonly string[] | undefined;
        const rawLineNumberWidth = readResult && Object.hasOwn(rx, "lineNumberWidth") ? (rx as { lineNumberWidth: unknown }).lineNumberWidth : undefined;
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
            ...(rawLineNumberWidth === undefined ? {} : { lineNumberWidth: rawLineNumberWidth as number }),
        };
    }

    // {§context-fit} — the tokens one row would charge the packet, rendered exactly as the log
    // would render it, so the fit test and the gauge agree.
    static rowTokens(view: LogEntryView, weighContent: WeighContent, options: RenderLogOptions = {}): number {
        const [row] = PacketWire.#renderLogEntries([view], weighContent, options);
        if (row === undefined) throw new Error("rowTokens: one view renders one row");
        return row.curationTarget?.tokens ?? 0;
    }

    // The row's identity and authored facts: who wrote it, what it addressed, and the statuses
    // that stay explicit. `meta` is the metadata line under construction; each later stage adds
    // to it, and {§log-wire-format}'s canonical JSON sorts the keys, so the order of stages never
    // reaches the wire.
    static #rowIdentity(e: LogEntryView, options: RenderLogOptions): RowIdentity {
        const meta: Record<string, unknown> = {};
        const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
        const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
        const renderedLeaf = LogEntryProjection.leaf(e);
        const path = PacketWire.#entryPath(coordinate, renderedLeaf);
        // Absence = "model" — the worker's own authorship is the default (#338). An arrival is an
        // inbound SEND row the harness published ({§message-causal-source}): its stored origin says
        // nothing, so the row names its sender instead (#706).
        // {§emission-row}: an emission row is stored as the harness's, but names its author.
        const author = LogEntryProjection.isEmission(e) ? e.producer : e.origin;
        if (typeof author === "string" && author !== "model" && !PacketWire.isArrival(e)) meta.origin = author;
        // {§env-delta-attribution}: render the causal worker address or
        // subsystem token when present; absence means the owning worker.
        // {§message-short-identity} an arrival whose source is the transport's own name for it adds
        // nothing to its address; a peer's or an agent's source still shows.
        const arrivalAttrs = typeof e.attrs === "string" ? PacketWire.#safeParse(e.attrs) : e.attrs;
        const selfAddressed = arrivalAttrs !== null && typeof arrivalAttrs === "object" && (arrivalAttrs as { selfAddressed?: unknown }).selfAddressed === true;
        if (typeof e.source === "string" && e.source.length > 0 && !selfAddressed) meta.source = e.source;
        // {§message-causal-source}: every other sender has an address; the operator's message is named
        // for the model, or it reads as the model's own SEND.
        if (PacketWire.isArrival(e) && meta.source === undefined) meta.origin = "user";
        if (e.source === "file" && e.attrs !== null && typeof e.attrs === "object" && "git" in e.attrs) {
            const git = (e.attrs as { git?: unknown }).git;
            if (typeof git !== "string" || git.length !== 2) {
                throw new TypeError("A source=file log row carries malformed Git XY metadata.");
            }
            meta.git = git;
        }
        // SEND, lifecycle verbs, destructive KILL, and non-200 statuses stay explicit.
        // Successful log-KILL rows never reach this projection
        // ({§log-kill-meta-operation}).
        if (typeof e.status === "number" && (op === "SEND" || op === "KILL" || typeof op === "string" && TurnDisposition.isOp(op) || e.status !== 200)) meta.status = e.status;
        const tx = (typeof e.tx === "string" ? PacketWire.#safeParse(e.tx) : e.tx) as StatementTx | null;
        if (typeof tx?.aside === "string") meta.aside = tx.aside;
        const target = PacketWire.#operandPath(e.target ?? tx?.target);
        const pair = op === "COPY" || op === "MOVE";
        const selections = pair
            ? [tx?.source, tx?.destination]
            : [{ ...tx, target: e.target ?? tx?.target }];
        const paths = selections.map((selection) => PacketWire.#operandPath(selection?.target));
        if (pair && typeof e.status === "number" && e.status < 400 && paths.some((path) => path === null)) {
            throw new Error(`A successful ${op} log row must retain both operand selections.`);
        }
        for (const field of ["scope", "metadata"] as const) {
            const values = selections.map((selection) => field === "scope"
                ? PacketWire.#requestScope(selection?.lineMarker)
                : selection?.metadata?.length ? selection.metadata : null);
            if (pair) {
                const paired = Object.fromEntries(values.flatMap((value, index) => value === null ? [] : [[index === 0 ? "from" : "to", value]]));
                if (Object.keys(paired).length > 0) meta[field] = paired;
            } else if (values[0] !== null) meta[field] = values[0];
        }
        // {§log-wire-format}: describe resources and patterns directly; never serialize an OP.
        const parts = selections.flatMap((selection, index) => {
            const pattern = selection?.matcher?.raw;
            return [
                ...(paths[index] === null ? [] : [`→ ${paths[index]}`]),
                ...(typeof pattern !== "string" || pattern.length === 0 ? []
                    : [/[\r\n]/u.test(pattern) ? JSON.stringify(pattern) : pattern]),
            ];
        });
        const description = op === "error" || op === "extension" || parts.length === 0 ? null : parts.join(" ");
        // {§worker-auto-name} The created identity is an outcome, not an authored target.
        if ((op === "WORK" || op === "FORK") && e.attrs !== null && typeof e.attrs === "object"
            && typeof (e.attrs as { worker?: unknown }).worker === "string") {
            meta.worker = (e.attrs as { worker: string }).worker;
        }
        // {§worker-wait-timing} — the accepted bound, not elapsed time or the current configuration.
        if (op === "WAIT" && e.attrs !== null && typeof e.attrs === "object" && "waiting" in e.attrs) {
            const seconds = (e.attrs as { waiting: unknown }).waiting;
            if (typeof seconds !== "number" || !Number.isFinite(seconds) || (seconds < 0 && seconds !== -1)) {
                throw new TypeError("A WAIT receipt carries a malformed waiting bound.");
            }
            if (seconds >= 0) meta.waitSeconds = seconds;
        }
        // An execution's output is a separate stream entry ({§exec-stream}); its address rides in a
        // `stream` link, distinct from the runtime-owned invocation target.
        // {§exec-target-routing} {§fs-namespace} — the receipt names the working directory only
        // when it is not the project root, and then in project-relative form.
        if (isExecutionOp(op) && e.attrs !== null && typeof e.attrs === "object" && typeof (e.attrs as { cwd?: unknown }).cwd === "string") {
            const cwd = PacketWire.#projectRelativeCwd((e.attrs as { cwd: string }).cwd, options.projectRoot ?? null);
            if (cwd !== null) meta.cwd = cwd;
        }
        if (isExecutionOp(op) && e.attrs !== null && typeof e.attrs === "object" && typeof (e.attrs as { stream?: unknown }).stream === "string") {
            meta.stream = (e.attrs as { stream: string }).stream;
        }
        return { meta, op, tx, coordinate, path, renderedLeaf, target, description };
    }

    // The row's result facts from its rx: the terminal stream's exit, the Problem or detail, the
    // matcher, the retrieval extents, and the structured mutation receipts. Returns what the body
    // projection needs to know about the result.
    static #rowResultFacts(identity: RowIdentity, e: LogEntryView, rx: RxView | null, fullBody: ResolvedLogBody): RowResultFacts {
        const { meta, op, tx } = identity;
        if (op === "SEND" && rx !== null && typeof rx === "object" && Array.isArray(rx.attachments) && rx.attachments.length > 0) {
            meta.attachments = rx.attachments.map(({ name, mediaType, target }) => ({ name, mediaType, path: target }));
        }
        // {§operation-resource-receipt}: preserve the returned address, not a second authored target.
        if (rx !== null && typeof rx === "object" && typeof rx.resource === "string"
            && rx.resource.length > 0 && rx.resource !== identity.target && rx.resource !== meta.stream) {
            meta.resource = rx.resource;
        }
        // {§exec-stream}: explicit and automatic READs preserve the same
        // durable liveness facts, including an empty active channel.
        if (op === "READ" && rx !== null && typeof rx === "object" && Object.hasOwn(rx, "terminal")) {
            if (typeof rx.terminal !== "boolean") {
                throw new TypeError("A stream READ result carries a malformed terminal flag.");
            }
            meta.terminal = rx.terminal;
            if (Object.hasOwn(rx, "exitCode")) {
                if (typeof rx.exitCode !== "number" || !Number.isSafeInteger(rx.exitCode)) {
                    throw new TypeError("A stream READ result carries a malformed exitCode.");
                }
                meta.exitCode = rx.exitCode;
            }
            // {§executor-page-receipt} — a producer's full-page fact survives projection as written.
            if (Object.hasOwn(rx, "page")) {
                const page = rx.page as { size?: unknown; returned?: unknown } | null;
                if (page === null || typeof page !== "object" || !Number.isSafeInteger(page.size) || !Number.isSafeInteger(page.returned)) {
                    throw new TypeError("A stream READ result carries a malformed page.");
                }
                meta.page = { size: page.size, returned: page.returned };
            }
        }

        // {§problem-projection} — the exact durable Problem remains the
        // failure authority; the packet carries only facts not already
        // owned by its enclosing row. Errors remains only an index.
        if (typeof e.status === "number" && e.status >= 400 && rx !== null && typeof rx === "object") {
            const problem = (rx as { problem?: unknown }).problem;
            Validator.assertProblemDetails(problem as ProblemDetails);
            meta.problem = Problems.project(problem as ProblemDetails, {
                status: e.status,
                row: { ...meta, target: identity.target },
            });
        }
        // The success-side sibling (#342): a sub-problem receipt may carry one
        // terse `detail` (e.g. the EDIT 304) so situational teaching is paid
        // only when the situation occurs, never in the hot path.
        if (!Object.hasOwn(meta, "problem") && rx !== null && typeof rx === "object"
            && typeof (rx as { detail?: unknown }).detail === "string"
            && (rx as { detail: string }).detail.length > 0) {
            meta.detail = (rx as { detail: string }).detail;
        }

        // {§retrieval-packet-metadata}: one extent/coordinate owner plus
        // only FIND aggregates that add information beyond that extent.
        let findItems: number | null = null;
        let range: RangeExtent | null = null;
        const patterned = tx !== null && tx !== undefined && typeof tx === "object" && tx.matcher !== null && typeof tx.matcher === "object" && typeof tx.matcher.raw === "string";
        if (patterned && op !== "FIND" && rx !== null && typeof rx === "object" && typeof rx.matched === "number") meta.matched = rx.matched;
        // {§channel-selection-visibility} — a READ names the resource's other channels with their
        // tokens, so the row itself shows the choice a FIND listing would.
        if (op === "READ" && rx !== null && typeof rx === "object" && rx.channels !== null && typeof rx.channels === "object") {
            meta.channels = rx.channels;
        }
        // {§send-response-receipt} — a reply's row names the prompts it answered.
        if ((op === "SEND" || op === "KILL") && rx !== null && typeof rx === "object" && Array.isArray(rx.answers)) {
            meta.answers = rx.answers;
        }
        if (op === "READ" || op === "FIND") {
            if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.content === "string") {
                const parsed = PacketWire.#safeParse(rx.content);
                if (Array.isArray(parsed)) findItems = parsed.length;
            }
            range = rx !== null && typeof rx === "object" && rx.range !== undefined
                ? Validator.assertRangeExtent(rx.range as RangeExtent)
                : null;
            const problemOwnsRange = typeof e.status === "number"
                && e.status >= 400
                && meta.problem !== null
                && typeof meta.problem === "object"
                && Object.hasOwn(meta.problem, "range");
            if (problemOwnsRange) {
                Validator.assertRangeExtent((meta.problem as { range: RangeExtent }).range);
                delete meta.scope;
            }
            if (range !== null && !problemOwnsRange) {
                delete meta.scope;
                const sparse = fullBody.lineOrdinals !== undefined
                    && range.returned !== undefined
                    && fullBody.lineOrdinals.length !== range.returned[1] - range.returned[0] + 1;
                meta.range = typeof e.status === "number" && e.status >= 400
                    ? range
                    : ScopeFormat.range(range, sparse);
            } else if (range === null && !problemOwnsRange && op === "READ" && rx !== null && typeof rx === "object" && rx.region !== undefined) {
                delete meta.scope;
                meta.range = ScopeFormat.region(Validator.assertTextRegion(rx.region as TextRegion));
            }
            // These are underlying selected-content weights, distinct from
            // the emitted body's generic `tokens` measurement.
            if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.itemsWeightTotal === "number" && rx.itemsWeightTotal > 0) {
                meta.itemsTokenTotal = rx.itemsWeightTotal;
            }
            if (
                op === "FIND"
                && rx !== null
                && typeof rx === "object"
                && typeof rx.returnedItemsWeightTotal === "number"
                && rx.returnedItemsWeightTotal > 0
                && rx.returnedItemsWeightTotal !== rx.itemsWeightTotal
            ) {
                meta.returnedItemsTokenTotal = rx.returnedItemsWeightTotal;
            }
            if (
                op === "FIND"
                && patterned
                && range?.unit === "resource"
                && rx !== null
                && typeof rx === "object"
                && typeof rx.matchLocationCount === "number"
                && rx.matchLocationCount > 0
            ) {
                meta.matchLocationCount = rx.matchLocationCount;
            }
        }

        // {§edit-result-receipt-projection} {§edit-result-copy-move-effects}
        // EDIT/scoped entry KILL own one receipt; COPY/MOVE own resource effects whose
        // optional receipts describe scoped textual materializations.
        let structuredMutationReceipt = false;
        if ((op === "EDIT" || op === "KILL") && rx !== null && typeof rx === "object" && Object.hasOwn(rx, "receipt")) {
            Object.assign(meta, PacketWire.#receiptMeta(rx.receipt));
            structuredMutationReceipt = true;
        }
        if (
            (op === "COPY" || op === "MOVE")
            && rx !== null
            && typeof rx === "object"
            && Object.hasOwn(rx, "effects")
        ) {
            const effects = assertResourceEffects(rx.effects);
            meta.effects = effects.map((effect) => ({
                path: effect.target,
                action: effect.action,
                ...(effect.receipt === undefined
                    ? {}
                    : PacketWire.#receiptMeta(effect.receipt)),
            }));
            structuredMutationReceipt = effects.some((effect) => effect.receipt !== undefined);
        }
        return {
            findItems, range, structuredMutationReceipt,
            ...(op === "READ" && rx?.matches !== undefined
                ? { matches: SchemeResults.assertMatchEvidenceList(rx.matches) } : {}),
        };
    }

    // The body the row shows: the canonical full body, shared with log READ, log FIND and search
    // derivation, whole. Whether a result fit was decided where it landed ({§context-fit}); the packet
    // cuts nothing but the emission head ({§emission-row}).
    static #rowBody(
        identity: RowIdentity,
        e: LogEntryView,
        fullBody: ResolvedLogBody,
        bodyVisibility: VisibleLogBody,
        facts: RowResultFacts,
    ): RowBody {
        const { meta, op } = identity;
        const projectedBody = {
            ...fullBody,
            content: bodyVisibility.fullyFolded ? bodyVisibility.readableContent : bodyVisibility.content,
        };
        const emptyFind = op === "FIND" && e.status === 200 && facts.findItems === 0;
        const lineAnchors = op === "READ" ? e.lineAnchors ?? null : null;
        const lineNumberWidth = op === "READ" ? e.lineNumberWidth ?? null : null;
        if (lineAnchors !== null) {
            LineAnchors.assertProjection(fullBody.content, lineAnchors);
        }
        const findRange = op === "FIND" ? facts.range : null;
        const bodyStartLine = findRange?.returned?.[0] ?? fullBody.startLine;
        const numericLineNumberWidth = findRange === null
            ? bodyStartLine === null || bodyVisibility.totalLines === 0
                ? 0
                : String(fullBody.lineOrdinals?.at(-1) ?? bodyStartLine + bodyVisibility.totalLines - 1).length
            : String(findRange.total).length;
        const sourceOrdinals = bodyVisibility.fullyFolded
            ? bodyVisibility.readableOrdinals
            : bodyVisibility.ordinals;
        // {§markerless-first-page} — what came back unasked in size is its first page here too; what the
        // model authored or asked for exactly, and a retrieval's own page, render whole.
        const projection = PacketWire.#receivedBody(e, op)
            ? PacketWire.#preview(projectedBody.content)
            : { text: projectedBody.content, cut: false, chunk: null };
        const projectedText = projection.text;
        const projectedLineCount = TextCoordinates.logicalLines(projectedText).length;
        const projectedOrdinals = sourceOrdinals.slice(0, projectedLineCount);
        if (facts.matches !== undefined && !bodyVisibility.fullyFolded) {
            const physicalLines = projectedOrdinals.map((ordinal) => fullBody.lineOrdinals?.[ordinal - 1]
                ?? (fullBody.startLine ?? 1) + ordinal - 1);
            const evidence = PatternEdits.visible(facts.matches, physicalLines).map(({ region, enclosingRegion, locator }) => ({
                ...(locator === undefined ? {} : { locator }),
                ...(region === undefined ? {} : { region: ScopeFormat.region(region) }),
                ...(enclosingRegion === undefined ? {} : { enclosingRegion: ScopeFormat.region(enclosingRegion) }),
            }));
            if (evidence.length > 0) {
                meta.matches = BodyPreview.items(evidence, JSON.stringify);
                if ((meta.matches as unknown[]).length !== evidence.length) meta.matchLocationCount = evidence.length;
            }
        }
        const body = emptyFind || projectedText.length === 0
            ? ""
            : PacketWire.#renderContentBody(
                projectedText,
                bodyStartLine,
                lineAnchors,
                lineNumberWidth,
                numericLineNumberWidth,
                bodyStartLine === null ? null : projectedOrdinals,
                fullBody.lineOrdinals ?? null,
            );

        // lines beside tokens on a non-retrieval row with a navigable body — the count of
        // `N:`-numbered lines (fences and unnumbered prose don't count), so the model can plan
        // a <start,end> slice before paying for a READ. READ/FIND own typed extents instead.
        if (fullBody.content.length > 0 && op !== "READ" && op !== "FIND") {
            meta.lines = bodyVisibility.totalLines;
        }

        if (bodyVisibility.trimmed.length > 0 && !bodyVisibility.fullyFolded) {
            meta.trimmed = LogVisibility.format(bodyVisibility.trimmed);
        }

        const display = bodyVisibility.readableContent.length === 0
            ? "none"
            : bodyVisibility.fullyFolded
                ? "folded"
                : body.length === 0
                    ? "none"
                    : "open";
        // {§packet-extent-metadata} — a page states what it shows of what the row holds.
        const projectedChunk = projection.chunk !== null && bodyVisibility.folded.length > 0 && !bodyVisibility.fullyFolded
            ? PacketWire.#sparseChunk(fullBody.content, projectedBody.content, sourceOrdinals, projection.text)
            : projection.chunk;
        if (display === "open" && projectedChunk !== null) {
            meta.preview = projectedChunk;
            delete meta.lines;
        }
        return { body, projectedLineCount, display };
    }

    // The row's native attachment, a landed-unfit arrival's size, and the accounting field that
    // participates in the row it measures: iterate until its decimal width and therefore the
    // rendered row's curation weight are stable. {§packet-token-accounting}
    static #rowAccounting(
        identity: RowIdentity,
        e: LogEntryView,
        fullBody: ResolvedLogBody,
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
        // {§context-fit} — an arrival that did not fit landed folded with its size beside it: the lines
        // and tokens of the body the model can READ at this row's address.
        const unfit = PacketWire.#attrsOf(e).unfit;
        if (unfit !== null && typeof unfit === "object") meta.size = unfit;
        // {§packet-attachment-parts}: retained native content shares the row's curation lifetime.
        const attachment = !(bodyVisibility.totalLines > 0 && bodyVisibility.fullyFolded)
            ? native
            : null;
        // {§emission-row}: an emission row carries its frozen emission outside its record, and charges what
        // the wire delivers of it, as the worker's own message, exactly as a native part is charged.
        const emission = LogEntryProjection.isEmission(e) && coordinate !== null
            ? { coordinate, content: fullBody.content, weight: weighContent(PacketWire.deliveredEmission(fullBody.content)) }
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
                const next = weighContent(render(open, tokens)) + (part?.weight ?? 0) + (emission?.weight ?? 0);
                if (next === tokens) return { content: render(open, tokens), tokens };
                tokens = next;
            }
            throw new Error("packet log row accounting did not converge");
        };
        const row = (rendered: { content: string; tokens: number }, part: PacketAttachment | null, bodied: BodiedLogRow | null): RenderedLogRow =>
            ({ content: rendered.content, curationTarget: { path, tokens: rendered.tokens }, attachment: part, emission, bodied });
        const whole = converge(display === "open", attachment);
        // {§context-own-rows-fit} — a row the wall may take carries a body or a native part and is not an
        // emission row, whose head-cut program keeps the turn legible.
        if (typeof e.id !== "number" || emission !== null || (display !== "open" && attachment === null)) return row(whole, attachment, null);
        if (!(options.bodiless?.has(e.id) ?? false)) return row(whole, attachment, { id: e.id, tokens: whole.tokens });
        // Taken: the fit rule's receipt shape — its size and address, no body, no native part.
        meta.size = { lines: projected.projectedLineCount, tokens: whole.tokens };
        const receipt = converge(false, null);
        if (receipt.tokens < whole.tokens) return row(receipt, null, null);
        // A receipt that weighs no less than the body it stands for sheds nothing: the row stays whole and
        // is spent.
        delete meta.size;
        return row(converge(display === "open", attachment), attachment, null);
    }

    static #attachmentOf(
        rx: unknown,
        target: ActionTarget | null | undefined,
        coordinate: string | null,
        path: string | null,
    ): PacketAttachment | null {
        const view = rx as RxView | null | undefined;
        const contentHash = (rx as { nativeContentHash?: unknown } | null)?.nativeContentHash;
        if (typeof contentHash !== "string") return null;
        const pathname = typeof target?.pathname === "string" && target.pathname.length > 0
            ? target.pathname
            : typeof target?.raw === "string" ? target.raw : null;
        if (pathname === null || coordinate === null || path === null) return null;
        const scheme = target?.scheme ?? "file";
        const image = view?.image as { mimetype?: unknown; width?: unknown; height?: unknown } | undefined;
        if (image !== undefined && typeof image.mimetype === "string" && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height)) {
            const width = image.width as number;
            const height = image.height as number;
            return { contentHash, coordinate, path, scheme, pathname, mimetype: image.mimetype, kind: "image", width, height, weight: imageWeight(width, height) };
        }
        const document = view?.document as { mimetype?: unknown; pages?: unknown; bytes?: unknown } | undefined;
        if (document !== undefined && typeof document.mimetype === "string" && Number.isSafeInteger(document.bytes)) {
            const pages = Number.isSafeInteger(document.pages) ? document.pages as number : null;
            return {
                contentHash, coordinate, path, scheme, pathname, mimetype: document.mimetype, kind: "pdf",
                ...(pages === null ? {} : { pages }),
                weight: pdfWeight(pages, document.bytes as number),
            };
        }
        const audio = view?.audio as { mimetype?: unknown; duration?: unknown; bytes?: unknown } | undefined;
        if (audio !== undefined && typeof audio.mimetype === "string" && Number.isSafeInteger(audio.bytes)) {
            const duration = typeof audio.duration === "number" && Number.isFinite(audio.duration) && audio.duration >= 0 ? audio.duration : null;
            return {
                contentHash, coordinate, path, scheme, pathname, mimetype: audio.mimetype, kind: "audio",
                ...(duration === null ? {} : { duration }),
                weight: audioWeight(duration, audio.bytes as number),
            };
        }
        return null;
    }

    // {§packet-attachment-parts} — the wire form with native parts: user text first, then each accepted
    // retained native part in observation order.
    static async wireMessages(
        packet: RequestPacket,
        emissions: ReadonlyMap<string, string>,
        bytesOf: (attachment: PacketAttachment) => Promise<Uint8Array>,
        accepts: (kind: PacketAttachment["kind"]) => boolean = () => true,
    ): Promise<ChatMessage[]> {
        const messages: ChatMessage[] = PacketWire.packetToWireMessages(packet, emissions);
        // {§packet-attachment-parts} — native parts ride the closing user message.
        const closing = messages.at(-1)!;
        const parts: ChatContentPart[] = [{ type: "text", text: closing.content as string }];
        for (const attachment of packet.attachments ?? []) {
            if (!accepts(attachment.kind)) continue;
            const bytes = await bytesOf(attachment);
            parts.push({ type: "text", text: PacketWire.attachmentCaption(attachment) });
            parts.push({ type: "file", data: bytes, mediaType: attachment.mimetype });
        }
        return parts.length === 1 ? messages : [...messages.slice(0, -1), { role: "user", content: parts }];
    }

    // {§packet-attachment-parts} — the part's identity: a native part on the user turn otherwise reads as
    // an arrival, and the model cannot tell that the READ row is what keeps it in the packet.
    static attachmentCaption(attachment: PacketAttachment): string {
        const facts = [attachment.mimetype];
        if (attachment.width !== undefined && attachment.height !== undefined) facts.push(`${attachment.width}×${attachment.height} px`);
        if (attachment.pages !== undefined) facts.push(`${attachment.pages} pages`);
        if (attachment.duration !== undefined) facts.push(`${attachment.duration} s`);
        return `log:///${attachment.coordinate}/READ → ${attachment.path} (${facts.join(", ")}): the bytes of that READ row, retained until it is KILLed. Not a new arrival.`;
    }

    static #projectRelativeCwd(cwd: string, projectRoot: string | null): string | null {
        if (projectRoot === null || cwd === projectRoot) return null;
        const spelled = relative(projectRoot, cwd);
        return spelled.length === 0 ? null : spelled.split(sep).join("/");
    }

    static #operandPath(target: ActionTarget | null | undefined): string | null {
        if (target === null || target === undefined) return null;
        return target.kind === "local" || target.scheme == null && typeof target.raw === "string"
            ? renderTarget({ scheme: null, pathname: typeof target.raw === "string" ? target.raw : target.pathname, fragment: target.fragment })
            : PacketWire.#renderActionTarget(target);
    }

    static #renderActionTarget(target: ActionTarget | null | undefined): string | null {
        if (target === null || target === undefined) return null;
        return renderTarget({
            scheme: target.scheme,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            query: target.query,
            fragment: target.fragment,
        });
    }

    static #requestScope(marker: unknown): string | null {
        if (marker === null || marker === undefined) return null;
        const marks = (marker as { marks?: unknown }).marks;
        if (!Array.isArray(marks) || marks.some((mark) => typeof mark !== "string" && typeof mark !== "number")) {
            throw new TypeError("An operation scope must retain its authored marks.");
        }
        // Failed selections still describe what was attempted; the operation owns validity.
        return ScopeFormat.marker(marker as TextLineMarker);
    }

    // {§packet-git-status}: the count line, then one bounded line per non-empty class. Untracked paths are
    // named because they are NOT members ({§membership-baseline}) — a human `git add`s or picks them.
    static #renderGitState(git: GitStatus & { files?: readonly { path: string; status: string; member?: string | null }[] }): string {
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
