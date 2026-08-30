// Packet → wire markdown projection. Single source of truth for how the
// Packet's ordered list of sections renders to ChatMessage.content
// strings the LLM receives. Engine imports this for the wire payload; the
// digest tool imports it to write byte-identical packetNNN.{system,user}.md
// files. No second implementation, no drift.
//
// Format and omission rules are owned by {§packet-markdown}. Section producers
// supply names and typed content; this projection preserves their ordered evidence.

import { relative, sep } from "node:path";
import { Problems, Validator, type ProblemDetails, type RangeExtent, type TextLineMarker, type TextRegion } from "@plurnk/plurnk-contracts";
import { TextCoordinates, type TextLine } from "@plurnk/plurnk-mimetypes";
import { renderTarget } from "./plurnk-uri.ts";
import type { GitStatus } from "./git-state.ts";
import LogBody from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import LogVisibility, { type LogFoldRanges } from "./LogVisibility.ts";
import {
    assertEditReceipt,
    assertResourceEffects,
    LineAnchors,
    type EditReceipt,
} from "../content/index.ts";

const editReceiptRevisionChars = (): number => {
    const raw = process.env.PLURNK_SERVICE_EDIT_RECEIPT_REVISION_CHARS;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
        throw new Error(`PLURNK_SERVICE_EDIT_RECEIPT_REVISION_CHARS must be a safe integer from 1 through 64, got ${JSON.stringify(raw)}`);
    }
    return value;
};

export const previewBounds = (): { lines: number; chars: number } => {
    const rawLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    const rawChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
    const lines = Number(rawLines);
    const chars = Number(rawChars);
    if (!Number.isSafeInteger(lines) || lines < 1) {
        throw new Error(`PLURNK_SERVICE_PREVIEW_LINES must be a positive safe integer, got ${JSON.stringify(rawLines)}`);
    }
    if (!Number.isSafeInteger(chars) || chars < 1) {
        throw new Error(`PLURNK_SERVICE_PREVIEW_CHARS must be a positive safe integer, got ${JSON.stringify(rawChars)}`);
    }
    return { lines, chars };
};

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
}
// The durable statement supplies operand identity and bodies without asking the
// packet mirror to re-serialize the model's complete emission tag.
interface StatementTx {
    annotation?: unknown;
    target?: ActionTarget | null;
    lineMarker?: unknown;
    source?: {
        target?: ActionTarget | null;
        lineMarker?: unknown;
    };
    destination?: {
        target?: ActionTarget | null;
        lineMarker?: unknown;
    };
    body?: string | { raw?: unknown } | null;
}
interface RxView {
    content?: unknown;
    exitCode?: unknown;
    mimetype?: unknown;
    startLine?: unknown;
    region?: unknown;
    itemsWeightTotal?: unknown;
    returnedItemsWeightTotal?: unknown;
    matchLocationCount?: unknown;
    range?: unknown;
    receipt?: unknown;
    effects?: unknown;
}
interface LogEntryView {
    coordinate?: unknown;
    op?: unknown;
    origin?: unknown;
    status?: unknown;
    target?: ActionTarget | null;
    tx?: StatementTx | string | null;
    mimetype_tx?: unknown;
    rx?: unknown;
    mimetype_rx?: unknown;
    folded?: unknown;
    source?: unknown;
    attrs?: unknown;
    tags?: unknown;
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
    readonly promptProjectionWeight?: number;
    // {§fs-namespace} — the workspace project root, the model's `/`; host-absolute spellings
    // are rendered relative to it and never verbatim. Null: the workspace has no root.
    readonly projectRoot?: string | null;
}

export interface ReclaimableLogBody {
    readonly path: string;
    readonly tokensBody: number;
    readonly tokensActive: number;
}

export interface RenderedLog {
    readonly content: string;
    readonly reclaimableBodies: readonly ReclaimableLogBody[];
}

interface RenderedLogRow {
    readonly content: string;
    readonly reclaimableBody: ReclaimableLogBody | null;
}

interface VisibleLogBody {
    readonly content: string;
    readonly ordinals: readonly number[];
    readonly folded: LogFoldRanges;
    readonly totalLines: number;
    readonly fullyFolded: boolean;
}

export default class PacketWire {
    // {§packet-markdown} Render the sections in `slot` to one ChatMessage.content
    // string. Sections render in list order; empties are omitted (no empty headers on the wire);
    // each is `## {header}\n\n{content}` (or bare content when header is null),
    // trailing newlines stripped, joined with a blank line.
    static renderSlot(sections: SectionView[], slot: "system" | "user"): string {
        return sections
            .filter((s) => s.slot === slot)
            .map((s) => PacketWire.renderSection(s))
            .filter((p) => p.length > 0)
            .join("\n\n");
    }

    // One section → its markdown block (`## {header}\n\n{content}`, or bare
    // content when header is null/empty), trailing newlines stripped. Empty
    // content renders to "" so renderSlot drops it. This is the unit the
    // per-section `weight` is measured over.
    static renderSection(s: SectionView): string {
        if (typeof s.content !== "string" || s.content.length === 0) return "";
        const header = typeof s.header === "string" && s.header.length > 0 ? s.header : null;
        return (header ? `## ${header}\n\n${s.content}` : s.content).replace(/\n+$/, "");
    }


    // Durable operation failures render as terse pointers to the log rows that
    // own their exact RFC 9457 results.
    static renderFailurePointers(failures: unknown): string {
        const rows = Array.isArray(failures) ? failures as FailurePointer[] : [];
        return rows
            .filter((row) => typeof row.status === "number" && typeof row.coordinate === "string")
            .map((row) => `* ${row.status} log:///${row.coordinate}`)
            .join("\n");
    }

    // Non-terminal model-facing observations are deliberately separate from
    // operation failures. Producer messages are normalized and bounded by the
    // shared preview limit; typed positions remain legible.
    static renderNotices(notices: unknown): string {
        const observations = Array.isArray(notices) ? notices as NoticeView[] : [];
        return observations.map((notice) => {
            const kind = typeof notice.kind === "string" ? notice.kind : "notice";
            const rawMessage = typeof notice.message === "string"
                ? notice.message.replace(/\s+/g, " ").trim()
                : "";
            const message = rawMessage.length > 0
                ? PacketWire.#preview(rawMessage).text
                : "";
            const position = notice.position?.type === "content-offset"
                ? ` @ ${String(notice.position.line)}:${String(notice.position.column)}`
                : "";
            return `* ${kind}${message.length > 0 ? `: ${message}` : ""}${position}`;
        }).join("\n");
    }

    // The Child Streams / Active Child Workers sections ({§child-orientation}) — the OPPOSITE of advice: terse
    // `* <status> <path>` pointers (same shape as the errors section) to the live things the worker holds,
    // so the model SEES its open streams + unconcluded workers each turn and reasons for itself (READ /
    // OPEN / KILL via the path). Orienting state, never an instruction. "" when none → section omitted.
    static renderChildPointers(rows: unknown): string {
        const items = Array.isArray(rows) ? (rows as Array<{ status: unknown; path: unknown; detail?: unknown }>) : [];
        return items.map((r) => `* ${String(r.status)} ${String(r.path)}${typeof r.detail === "string" && r.detail.length > 0 ? ` — ${r.detail}` : ""}`).join("\n");
    }

    // The git section content: the working-tree summary. "" when absent.
    static renderGit(git: unknown, assignedBranch: string | null = null): string {
        const status = git === null || git === undefined ? "" : PacketWire.#renderGitState(git as GitStatus);
        const assignment = assignedBranch === null
            ? ""
            : `assigned branch \`${assignedBranch}\` — commit any project changes and leave the checkout clean before concluding`;
        return [status, assignment].filter((line) => line.length > 0).join("\n");
    }

    // The log section's content: the model's curated rows as a fenced `jsonplurnk` array ({§jsonplurnk}).
    // Data only — no prose leads the fence (the log carries rules for no one). Empty log → ""
    // (the section is omitted).
    static renderLog(entries: unknown, weighContent: WeighContent, options: RenderLogOptions = {}): string {
        return PacketWire.renderLogWithAccounting(entries, weighContent, options).content;
    }

    // {§tokenomics-pressure-inventory} — the wire row and its reclaimable-body
    // accounting come from one render pass; packet assembly never re-parses its text.
    static renderLogWithAccounting(entries: unknown, weighContent: WeighContent, options: RenderLogOptions = {}): RenderedLog {
        const log = Array.isArray(entries) ? (entries as LogEntryView[]) : [];
        if (log.length === 0) return { content: "", reclaimableBodies: [] };
        const rows = PacketWire.#renderLogEntries(log, weighContent, options);
        // Every source line is coordinate-prefixed, so source backticks never occupy the
        // CommonMark closing-fence position. The fixed opener keeps the packet prefix cache-stable.
        return {
            content: `\`\`\`jsonplurnk\n[\n${rows.map(({ content }) => content).join(",\n")}\n]\n\`\`\``,
            reclaimableBodies: rows.flatMap(({ reclaimableBody }) =>
                reclaimableBody === null ? [] : [reclaimableBody]),
        };
    }

    // Read one section's content by name off a packet (Engine's or re-parsed).
    // The legible accessor — consumers name the section they want instead of
    // indexing a fixed shape. Missing section / non-string content → "".
    static sectionContent(packet: Packet, name: string): string {
        const s = packet.sections?.find((x) => x.name === name);
        return typeof s?.content === "string" ? s.content : "";
    }

    // Project a packet to the request ChatMessage[] for the wire: one message
    // per slot. Engine calls this directly; the result is what provider.generate
    // receives. The digest calls renderSlot for byte-identical packetNNN files.
    static packetToWireMessages(packet: Packet): Array<{ role: string; content: string }> {
        const sections = packet.sections ?? [];
        return [
            { role: "system", content: PacketWire.renderSlot(sections, "system") },
            { role: "user", content: PacketWire.renderSlot(sections, "user") },
        ];
    }

    // Number a non-READ body line as `<N>:<line>` — `N:` followed by NO separator whitespace
    // ({§render-rule-line-navigable-prefix}): the leading digit prevents column-zero fence collisions and gives
    // the model line refs for free (`## READ0 (...) <42-46>`), while the absence of any separator means a
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
    ): string {
        const lines = TextCoordinates.logicalLines(body);
        if (lines.length !== ordinals.length) {
            throw new TypeError("A sparse log-body projection requires one source ordinal per rendered line.");
        }
        const displayed = ordinals.map((ordinal) => startLine + ordinal - 1);
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
            const separator = " ".repeat(width - String(lineNumber).length + 1);
            return `${anchor}${separator}${lineNumber}:${content}${line.separator}`;
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
                )
                : lineAnchors === null
                    ? PacketWire.#numberLines(content, startLine, numericLineNumberWidth)
                    : LineAnchors.render(content, startLine, lineAnchors, lineNumberWidth ?? 0)
            : content;
        return PacketWire.#quoteBody(rendered);
    }

    // Tolerant JSON parser for log entries' persisted rx/tx strings. The engine
    // pre-parses application/json mimetypes; malformed stored text is not JSON.
    static #safeParse(s: string): unknown {
        try { return JSON.parse(s); } catch { return null; }
    }

    // Stable JSON: `path` leads (it is the row's identity, {§jsonplurnk}), then
    // the remaining keys are sorted alphabetically so the same meta produces the
    // same string across turns — prefix-cache friendly.
    static #canonicalJson(obj: Record<string, unknown>): string {
        const keys = Object.keys(obj).sort();
        const sorted: Record<string, unknown> = {};
        if (Object.hasOwn(obj, "path")) sorted.path = obj.path;
        for (const k of keys) {
            if (k !== "path") sorted[k] = obj[k];
        }
        return JSON.stringify(sorted);
    }

    static #receiptMeta(value: unknown): Record<string, string | number> {
        const receipt: EditReceipt = assertEditReceipt(value);
        const head = {
            rev: receipt.revision.slice(0, editReceiptRevisionChars()),
            extent: `${receipt.unit} ${receipt.before}->${receipt.after}`,
            ...(receipt.parseIssues === undefined
                ? {}
                : { parseIssues: `${receipt.parseIssues.before}→${receipt.parseIssues.after}` }),
        };
        if ("effect" in receipt) {
            return {
                ...head,
                change: `-${receipt.effect.removed} +${receipt.effect.inserted}`,
                range: `${receipt.effect.requested} ${receipt.effect.source}->${receipt.effect.result}`,
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
                    replacement: `${receipt.replacement.requested} ${receipt.replacement.source}->${receipt.replacement.result}`,
                }),
        };
    }

    // {§jsonplurnk} One deliberately raw multiline JSON string. The physical
    // newline after the opening quote and every positive numeric (optionally left-padded) or anchored coordinate prefix
    // make the closing quote at column zero unambiguous without an invented
    // delimiter for source text to imitate. Already-numbered producer output is
    // checked here too: malformed bodies fail at the one projection boundary.
    static #quoteBody(body: string): string {
        const endsWithLineBreak = /(?:\r\n|\r|\n)$/.test(body);
        const lines = body.split(/\r\n|\r|\n/);
        const contentLines = endsWithLineBreak ? lines.slice(0, -1) : lines;
        if (contentLines.length === 0 || contentLines.some((line) =>
            !/^ *[1-9]\d*:/.test(line) && !LineAnchors.isAnchoredLine(line))) {
            throw new TypeError("A raw jsonplurnk body requires a positive coordinate prefix on every physical line.");
        }
        return `"\n${body}${endsWithLineBreak ? "" : "\n"}"`;
    }

    // Render one Log entry → a single bullet line carrying the meta JSON.
    // No body, no fence — every meaningful field is in the JSON. Naming
    // follows the uniform principle: `path` is identity (this log row's
    // own URI), `target` is the URI in the statement's target slot. COPY/MOVE
    // retain their source and destination selections separately from ordered
    // applied `effects`.
    //
    // On error, status >= 400 signals the failure; Problem Details live on
    // this durable row and the next packet's Errors section points here.
    //
    // Per-entry render: one meta JSON line plus the row's canonical body.
    // LogBody owns tx/rx storage interpretation; packet projection owns only
    // visibility, previewing, mimetype rendering, and metadata.
    // The log:/// handle the model sees for an entry.
    // ({§open-fold}).
    static #entryPath(coordinate: string | null, leaf: string): string | null {
        if (coordinate === null) return null;
        return `log:///${coordinate}/${leaf}`;
    }

    static #offsetAfterCharacters(text: string, count: number): number {
        let offset = 0;
        let consumed = 0;
        while (offset < text.length && consumed < count) {
            if (text.startsWith("\r\n", offset)) {
                offset += 2;
            } else {
                const codePoint = text.codePointAt(offset);
                if (codePoint === undefined) break;
                offset += String.fromCodePoint(codePoint).length;
            }
            consumed++;
        }
        return offset;
    }

    // One preview function for every bounded model-facing projection. Lines
    // protect ordinary documents and Unicode characters protect a single-line
    // bomb. Once a physical line is complete, a character cut retreats to that
    // line boundary rather than exposing a partial coordinate prefix.
    static #preview(text: string): { text: string; cut: boolean; chunk: string | null } {
        const { lines: maxLines, chars: maxChars } = previewBounds();
        const coordinates = new TextCoordinates(text);
        const physicalLines = coordinates.logicalLines();
        const lineEnd = physicalLines.length > maxLines
            ? physicalLines[maxLines - 1]!.end
            : text.length;
        const characterEnd = PacketWire.#offsetAfterCharacters(text, maxChars);
        let end = Math.min(lineEnd, characterEnd);
        if (characterEnd < text.length && characterEnd <= lineEnd) {
            const completeLine = physicalLines.findLast((line) =>
                line.separator.length > 0 && line.end <= characterEnd);
            if (completeLine !== undefined) end = completeLine.end;
        }
        const cut = end < text.length;
        return {
            text: text.slice(0, end),
            cut,
            chunk: cut ? PacketWire.#chunk(coordinates, physicalLines, end, text.length) : null,
        };
    }

    static #formatRegion(region: TextRegion): string {
        return `<${region.startLine},${region.startColumn},${region.endLine},${region.endColumn}>`;
    }

    static #chunk(
        coordinates: TextCoordinates,
        lines: readonly TextLine[],
        end: number,
        completeEnd: number,
    ): string {
        const finalCompleteLine = lines.findIndex((line) =>
            line.separator.length > 0 && line.end === end);
        if (finalCompleteLine !== -1) {
            const selected = `<1,${finalCompleteLine + 1}>`;
            const complete = `<1,${lines.length}>`;
            if (selected === complete) {
                throw new Error("a bounded body chunk must differ from its complete line extent");
            }
            return `showing ${selected} of ${complete}`;
        }

        const selectedRegion = coordinates.regionFromOffsets(0, end);
        const completeRegion = coordinates.regionFromOffsets(0, completeEnd);
        if (selectedRegion === null || completeRegion === null) {
            throw new Error("a character-bound body chunk must resolve to exact text coordinates");
        }
        const selected = PacketWire.#formatRegion(selectedRegion);
        const complete = PacketWire.#formatRegion(completeRegion);
        if (selected === complete) {
            throw new Error("a bounded body chunk must differ from its complete text extent");
        }
        return `showing ${selected} of ${complete}`;
    }

    static #sparseChunk(
        completeContent: string,
        visibleContent: string,
        visibleOrdinals: readonly number[],
        projectedContent: string,
    ): string {
        const end = projectedContent.length;
        const coordinates = new TextCoordinates(visibleContent);
        const lines = coordinates.logicalLines();
        const finalCompleteLine = lines.findIndex((line) =>
            line.separator.length > 0 && line.end === end);
        if (finalCompleteLine !== -1) {
            const selectedOrdinals = visibleOrdinals.slice(0, finalCompleteLine + 1);
            const runs: Array<[number, number]> = [];
            for (const ordinal of selectedOrdinals) {
                const previous = runs.at(-1);
                if (previous === undefined || ordinal !== previous[1] + 1) {
                    runs.push([ordinal, ordinal]);
                } else {
                    previous[1] = ordinal;
                }
            }
            const selected = runs.map(([start, finish]) => `<${start},${finish}>`).join(",");
            return `showing ${selected} of <1,${TextCoordinates.logicalLines(completeContent).length}>`;
        }

        const local = coordinates.regionFromOffsets(0, end);
        const complete = new TextCoordinates(completeContent)
            .regionFromOffsets(0, completeContent.length);
        if (local === null || complete === null) {
            throw new Error("a sparse character-bound chunk must resolve to exact text coordinates");
        }
        const startLine = visibleOrdinals[local.startLine - 1];
        const endLine = visibleOrdinals[local.endLine - 1];
        if (startLine === undefined || endLine === undefined) {
            throw new Error("a sparse character-bound chunk must map to canonical body lines");
        }
        return `showing ${PacketWire.#formatRegion({
            ...local,
            startLine,
            endLine,
        })} of ${PacketWire.#formatRegion(complete)}`;
    }

    static #promptProjection(
        body: ReturnType<typeof LogBody.resolve>,
        budget: number,
        weighContent: WeighContent,
        render: (content: string) => string = (content) =>
            PacketWire.#renderContentBody(content, body.startLine, null),
    ): { text: string; cut: boolean; chunk: string | null } {
        const weightAt = (end: number): number => weighContent(render(body.content.slice(0, end)));
        if (weightAt(body.content.length) <= budget) {
            return { text: body.content, cut: false, chunk: null };
        }
        if (budget <= 0) return { text: "", cut: true, chunk: null };

        const coordinates = new TextCoordinates(body.content);
        const lines = coordinates.logicalLines();
        const completeLineEnds = lines
            .filter((line) => line.separator.length > 0 && line.end < body.content.length)
            .map((line) => line.end);
        let low = 0;
        let high = completeLineEnds.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (weightAt(completeLineEnds[middle]!) <= budget) low = middle + 1;
            else high = middle;
        }
        const completeLineEnd = low === 0 ? 0 : completeLineEnds[low - 1]!;
        if (completeLineEnd > 0) {
            return {
                text: body.content.slice(0, completeLineEnd),
                cut: true,
                chunk: PacketWire.#chunk(coordinates, lines, completeLineEnd, body.content.length),
            };
        }

        const firstLineEnd = lines[0]?.contentEnd ?? body.content.length;
        const offsets = [0];
        let offset = 0;
        for (const codePoint of body.content.slice(0, firstLineEnd)) {
            offset += codePoint.length;
            offsets.push(offset);
        }
        low = 0;
        high = offsets.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (weightAt(offsets[middle]!) <= budget) low = middle + 1;
            else high = middle;
        }
        const characterEnd = low === 0 ? 0 : offsets[low - 1]!;
        if (characterEnd === 0) return { text: "", cut: true, chunk: null };
        return {
            text: body.content.slice(0, characterEnd),
            cut: true,
            chunk: PacketWire.#chunk(coordinates, lines, characterEnd, body.content.length),
        };
    }

    static #visibleBody(
        entry: LogEntryView,
        body: ReturnType<typeof LogBody.resolve>,
    ): VisibleLogBody {
        const folded = LogVisibility.parse(entry.folded ?? LogVisibility.OPEN);
        const lines = TextCoordinates.logicalLines(body.content);
        const totalLines = lines.length;
        const clipped = LogVisibility.clipped(folded, totalLines);
        const ordinals = LogVisibility.visibleLineOrdinals(clipped, totalLines);
        return {
            content: ordinals.map((ordinal) => {
                const line = lines[ordinal - 1]!;
                return body.content.slice(line.start, line.end);
            }).join(""),
            ordinals,
            folded: clipped,
            totalLines,
            fullyFolded: LogVisibility.fullyFolded(clipped, totalLines),
        };
    }

    static #promptProjectionWeights(
        entries: readonly LogEntryView[],
        bodies: readonly ReturnType<typeof LogBody.resolve>[],
        visibility: readonly VisibleLogBody[],
        weighContent: WeighContent,
        budget: number | undefined,
    ): ReadonlyMap<number, number> {
        if (budget === undefined) return new Map();
        if (!Number.isSafeInteger(budget) || budget < 0) {
            throw new RangeError(`promptProjectionWeight must be a non-negative safe integer, got ${JSON.stringify(budget)}`);
        }
        const costs = entries.flatMap((entry, index) => {
            if (entry.op !== "prompt" || bodies[index]!.content.length === 0) return [];
            const body = bodies[index]!;
            const visible = visibility[index]!;
            const width = body.startLine === null || visible.totalLines === 0
                ? 0
                : String(body.startLine + visible.totalLines - 1).length;
            const rendered = PacketWire.#renderContentBody(
                body.content,
                body.startLine,
                null,
                null,
                width,
                body.startLine === null ? null : visible.ordinals,
            );
            return [{ index, cost: weighContent(rendered) }];
        });
        const allocations = new Map<number, number>();
        let remaining = budget;
        let active = costs;
        while (active.length > 0) {
            const share = Math.floor(remaining / active.length);
            const complete = active.filter(({ cost }) => cost <= share);
            if (complete.length === 0) {
                const extra = remaining % active.length;
                active.forEach(({ index }, position) => allocations.set(index, share + (position < extra ? 1 : 0)));
                break;
            }
            for (const { index, cost } of complete) {
                allocations.set(index, cost);
                remaining -= cost;
            }
            const completed = new Set(complete.map(({ index }) => index));
            active = active.filter(({ index }) => !completed.has(index));
        }
        return allocations;
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
        const visibleBodies = bodies.map((body, index) => ({
            ...body,
            content: visibility[index]!.fullyFolded ? "" : visibility[index]!.content,
        }));
        const promptProjectionWeights = PacketWire.#promptProjectionWeights(
            entries,
            visibleBodies,
            visibility,
            weighContent,
            options.promptProjectionWeight,
        );
        return entries.map((e, index) => {
            const meta: Record<string, unknown> = {};
            const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            const renderedLeaf = LogEntryProjection.leaf(e);
            const path = PacketWire.#entryPath(coordinate, renderedLeaf);
            if (path !== null) meta.path = path;
            // Absence = "model" — the worker's own authorship is the default,
            // exactly as `source` absence means the owning worker (#338).
            if (typeof e.origin === "string" && e.origin !== "model") meta.origin = e.origin;
            // {§env-delta-attribution}: render the causal worker address or
            // subsystem token when present; absence means the owning worker.
            if (typeof e.source === "string" && e.source.length > 0) meta.source = e.source;
            if (e.source === "file" && e.attrs !== null && typeof e.attrs === "object" && "git" in e.attrs) {
                const git = (e.attrs as { git?: unknown }).git;
                if (typeof git !== "string" || git.length !== 2) {
                    throw new TypeError("A source=file log row carries malformed Git XY metadata.");
                }
                meta.git = git;
            }
            // Absence = 200 on an ordinary row — the clients' quiet grammar
            // (plurnk#21) applied to the packet. SEND keeps its disposition,
            // KILL keeps decisive destructive completion, a dissolving OPEN/FOLD
            // receipt exists only to show its status ({§curation-receipt-dissolves}),
            // and every non-200 stays explicit (#338).
            if (typeof e.status === "number" && (op === "SEND" || op === "KILL" || op === "FOLD" || op === "OPEN" || e.status !== 200)) meta.status = e.status;
            if (e.tags !== undefined) {
                const storedTags = e.tags;
                if (!Array.isArray(storedTags) || !storedTags.every((tag) => typeof tag === "string" && tag.length > 0)) {
                    throw new TypeError("A log row carries malformed folksonomic tags.");
                }
                const tags = [...new Set(storedTags)].toSorted();
                if (tags.length !== storedTags.length || tags.some((tag, index) => tag !== storedTags[index])) {
                    throw new TypeError("A log row's folksonomic tags must be unique and sorted.");
                }
                if (tags.length > 0) meta.tags = tags;
            }
            const tx = (typeof e.tx === "string" ? PacketWire.#safeParse(e.tx) : e.tx) as StatementTx | null;
            if (typeof tx?.annotation === "string") meta.annotation = tx.annotation;
            const target = PacketWire.#renderActionTarget(e.target);
            // {§exec-stream}: a terminal stream observation's address is the stream it observed,
            // rendered under `stream` like the invocation's own link — never a `target`, which
            // the model would otherwise author into an EXEC slot (#425 F4).
            const terminalStream = op === "READ"
                && e.attrs !== null
                && typeof e.attrs === "object"
                && (e.attrs as { terminal?: unknown }).terminal === true;
            if (op === "COPY" || op === "MOVE") {
                const source = PacketWire.#renderSelection(
                    tx?.source?.target,
                    tx?.source?.lineMarker,
                );
                const destination = PacketWire.#renderSelection(
                    tx?.destination?.target,
                    tx?.destination?.lineMarker,
                );
                if (source !== null) meta.source = source;
                if (destination !== null) meta.destination = destination;
                if (
                    typeof e.status === "number"
                    && e.status < 400
                    && (source === null || destination === null)
                ) {
                    throw new Error(`A successful ${op} log row must retain both operand selections.`);
                }
            } else if (target !== null) {
                meta[terminalStream ? "stream" : "target"] = target;
            }
            // EXEC's output is a separate stream entry ({§exec-stream}); its address rides in a
            // `stream` link, distinct from the runtime-owned invocation target.
            // {§exec-target-routing} {§fs-namespace} — the receipt names the working directory only
            // when it is not the project root, and then in the model's own project-relative form;
            // the root is the default and a host-absolute path never reaches the packet.
            if (op === "EXEC" && e.attrs !== null && typeof e.attrs === "object" && typeof (e.attrs as { cwd?: unknown }).cwd === "string") {
                const cwd = PacketWire.#projectRelativeCwd((e.attrs as { cwd: string }).cwd, options.projectRoot ?? null);
                if (cwd !== null) meta.cwd = cwd;
            }
            if (op === "EXEC" && e.attrs !== null && typeof e.attrs === "object" && typeof (e.attrs as { stream?: unknown }).stream === "string") {
                meta.stream = (e.attrs as { stream: string }).stream;
            }

            // Parse rx once — reused for the matcher/items enrichment and the body.
            const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as RxView | null;

            // {§exec-stream}: a terminal stream observation is self-sufficient
            // even when its selected channel is empty. Preserve exact producer
            // facts; do not manufacture a prose completion summary.
            if (terminalStream) {
                meta.terminal = true;
                if (rx !== null && typeof rx === "object" && Object.hasOwn(rx, "exitCode")) {
                    if (typeof rx.exitCode !== "number" || !Number.isSafeInteger(rx.exitCode)) {
                        throw new TypeError("A terminal stream result carries a malformed exitCode.");
                    }
                    meta.exitCode = rx.exitCode;
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
                    row: meta,
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
            if (op === "READ" || op === "FIND") {
                const findMatcher = op === "FIND"
                    && tx !== null
                    && tx !== undefined
                    && typeof tx === "object"
                    && tx.body !== null
                    && typeof tx.body === "object";
                if (findMatcher) {
                    const body = tx?.body;
                    if (body !== null && typeof body === "object" && typeof body.raw === "string") {
                        meta.matcher = body.raw;
                    }
                }
                if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.content === "string") {
                    const parsed = PacketWire.#safeParse(rx.content);
                    if (Array.isArray(parsed)) findItems = parsed.length;
                }
                const range = rx !== null && typeof rx === "object" && rx.range !== undefined
                    ? rx.range
                    : undefined;
                const problemOwnsRange = typeof e.status === "number"
                    && e.status >= 400
                    && meta.problem !== null
                    && typeof meta.problem === "object"
                    && Object.hasOwn(meta.problem, "range");
                if (problemOwnsRange) {
                    Validator.assertRangeExtent((meta.problem as { range: RangeExtent }).range);
                }
                if (range !== undefined && !problemOwnsRange) {
                    meta.range = Validator.assertRangeExtent(range as RangeExtent);
                } else if (op === "READ" && rx !== null && typeof rx === "object" && rx.region !== undefined) {
                    meta.region = Validator.assertTextRegion(rx.region as TextRegion);
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
                    findMatcher
                    && range !== null
                    && typeof range === "object"
                    && (range as { unit?: unknown }).unit === "resource"
                    && rx !== null
                    && typeof rx === "object"
                    && typeof rx.matchLocationCount === "number"
                    && rx.matchLocationCount > 0
                ) {
                    meta.matchLocationCount = rx.matchLocationCount;
                }
            }

            // {§edit-result-receipt-projection} {§edit-result-copy-move-effects}
            // Mutations expose compact, validated outcome metadata. EDIT owns
            // one receipt; COPY/MOVE own ordered resource effects whose
            // optional receipts describe scoped textual materializations.
            let structuredMutationReceipt = false;
            if (op === "EDIT" && rx !== null && typeof rx === "object" && Object.hasOwn(rx, "receipt")) {
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
                    target: effect.target,
                    action: effect.action,
                    ...(effect.receipt === undefined
                        ? {}
                        : PacketWire.#receiptMeta(effect.receipt)),
                }));
                structuredMutationReceipt = effects.some((effect) => effect.receipt !== undefined);
            }

            // The canonical full body is shared with log READ, log FIND,
            // and search derivation. READ/FIND own selection bounds, PLAN is
            // persistent working memory, and prompt rows share their packet
            // allowance. Structured mutation receipts own their join bound;
            // every remaining body uses the ordinary fixed preview.
            const fullBody = bodies[index]!;
            const bodyVisibility = visibility[index]!;
            const projectedBody = bodyVisibility.fullyFolded
                ? fullBody
                : { ...fullBody, content: bodyVisibility.content };
            const emptyFind = op === "FIND" && e.status === 200 && findItems === 0;
            const previewExempt = op === "READ"
                || op === "FIND"
                || op === "PLAN"
                || structuredMutationReceipt;
            const lineAnchors = op === "READ" ? e.lineAnchors ?? null : null;
            const lineNumberWidth = op === "READ" ? e.lineNumberWidth ?? null : null;
            if (lineAnchors !== null) {
                LineAnchors.assertProjection(fullBody.content, lineAnchors);
            }
            const findRange = op === "FIND" && meta.range !== null && typeof meta.range === "object"
                ? meta.range as RangeExtent
                : null;
            const bodyStartLine = findRange?.returned?.[0] ?? fullBody.startLine;
            const numericLineNumberWidth = findRange === null
                ? bodyStartLine === null || bodyVisibility.totalLines === 0
                    ? 0
                    : String(bodyStartLine + bodyVisibility.totalLines - 1).length
                : String(findRange.total).length;
            const allOrdinals = Array.from(
                { length: bodyVisibility.totalLines },
                (_, ordinal) => ordinal + 1,
            );
            const sourceOrdinals = bodyVisibility.fullyFolded
                ? allOrdinals
                : bodyVisibility.ordinals;
            const promptProjectionWeight = promptProjectionWeights.get(index);
            const projection = promptProjectionWeight !== undefined
                ? PacketWire.#promptProjection(
                    projectedBody,
                    promptProjectionWeight,
                    weighContent,
                    (content) => PacketWire.#renderContentBody(
                        content,
                        bodyStartLine,
                        null,
                        null,
                        numericLineNumberWidth,
                        bodyStartLine === null
                            ? null
                            : sourceOrdinals.slice(0, TextCoordinates.logicalLines(content).length),
                    ),
                )
                : previewExempt
                ? { text: projectedBody.content, cut: false, chunk: null }
                : PacketWire.#preview(projectedBody.content);
            if (projection.cut && path === null) {
                throw new Error("a previewed log body requires an addressable log path");
            }
            const projectedLineCount = TextCoordinates.logicalLines(projection.text).length;
            const projectedOrdinals = sourceOrdinals.slice(0, projectedLineCount);
            const body = emptyFind || projection.text.length === 0
                ? ""
                : PacketWire.#renderContentBody(
                    projection.text,
                    bodyStartLine,
                    lineAnchors,
                    lineNumberWidth,
                    numericLineNumberWidth,
                    bodyStartLine === null ? null : projectedOrdinals,
                );

            // {§packet-token-accounting} — tokensBody reports the projected body's weight even
            // when that body is withheld. Active accounting happens only after every field and
            // the final row framing are known below.
            const renderedBodyWeight = body.length > 0 ? weighContent(body) : 0;
            // Never tokensBody:0 — a priceless OPEN is field absence, and
            // tokensBody presence is what marks the folded state (#338).
            if (fullBody.content.length > 0 && renderedBodyWeight > 0) meta.tokensBody = renderedBodyWeight;
            // lines beside tokens on a non-retrieval row with a navigable body — the count of
            // `N:`-numbered lines (fences and unnumbered prose don't count), so the model can plan
            // a <start,end> slice before paying for an OPEN. READ/FIND own typed extents instead.
            if (fullBody.content.length > 0 && op !== "READ" && op !== "FIND") {
                meta.lines = bodyVisibility.totalLines;
            }

            if (bodyVisibility.folded.length > 0 && !bodyVisibility.fullyFolded) {
                meta.folded = LogVisibility.format(bodyVisibility.folded);
            }

            // {§jsonplurnk} — the three body states stay self-describing through
            // field presence alone (#338): a `body` field ⇒ open, `tokensBody`
            // without `body` ⇒ folded, neither ⇒ none. OPEN/FOLD remain
            // friendly no-ops on `none`.
            const display = fullBody.content.length === 0
                ? "none"
                : bodyVisibility.fullyFolded
                    ? "folded"
                    : body.length === 0
                        ? "none"
                        : "open";
            const projectedChunk = projection.chunk !== null
                && bodyVisibility.folded.length > 0
                && !bodyVisibility.fullyFolded
                ? PacketWire.#sparseChunk(
                    fullBody.content,
                    projectedBody.content,
                    sourceOrdinals,
                    projection.text,
                )
                : projection.chunk;
            const chunk = projectedChunk !== null
                ? `,"chunk":${JSON.stringify(projectedChunk)}`
                : "";
            const renderRow = (): string => {
                const obj = PacketWire.#canonicalJson(meta);
                return display === "open"
                    ? obj.replace(/\}$/, `,"body":${body}${chunk}}`)
                    : obj;
            };

            // The accounting field participates in the row it measures. Iterate
            // until its decimal width and therefore the rendered row's curation
            // weight are stable. The metadata share is derivable (tokensActive −
            // tokensBody when open; tokensActive otherwise) and feeds no
            // curation decision, so it is not serialized (#338).
            meta.tokensActive = 0;
            for (let pass = 0; pass < 8; pass += 1) {
                const tokensActive = weighContent(renderRow());
                if (meta.tokensActive === tokensActive) {
                    const tokensBody = typeof meta.tokensBody === "number" ? meta.tokensBody : 0;
                    return {
                        content: renderRow(),
                        reclaimableBody: display === "open" && path !== null && tokensBody > 0
                            ? { path, tokensBody, tokensActive }
                            : null,
                    };
                }
                meta.tokensActive = tokensActive;
            }
            throw new Error("jsonplurnk row accounting did not converge");
        });
    }

    static #projectRelativeCwd(cwd: string, projectRoot: string | null): string | null {
        if (projectRoot === null || cwd === projectRoot) return null;
        const spelled = relative(projectRoot, cwd);
        return spelled.length === 0 ? null : spelled.split(sep).join("/");
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

    static #renderSelection(
        target: ActionTarget | null | undefined,
        marker: unknown,
    ): string | null {
        if (target === null || target === undefined) return null;
        const address = target.kind === "local" && typeof target.raw === "string"
            ? renderTarget({ scheme: null, pathname: target.raw })
            : target.scheme === "file"
                ? renderTarget({ scheme: null, pathname: target.pathname ?? "" })
                : PacketWire.#renderActionTarget(target);
        if (address === null || address.length === 0) return null;
        if (marker === null || marker === undefined) return address;
        const validation = Validator.validateTextLineMarker(marker);
        if (!validation.valid) {
            throw new TypeError("A COPY/MOVE operand contains an invalid text line marker.");
        }
        return `${address}<${(marker as TextLineMarker).marks.join(",")}>`;
    }

    // {§packet-git-status}: the count line, then one bounded line per non-empty class. Untracked paths are
    // named because they are NOT members ({§membership-baseline}) — a human `git add`s or picks them.
    static #GIT_PATHS_PER_CLASS = 8;

    static #renderGitState(git: GitStatus & { files?: readonly { path: string; status: string; member?: string | null }[] }): string {
        const sync = git.ahead > 0 || git.behind > 0 ? ` (↑${git.ahead} ↓${git.behind})` : "";
        const head = `branch \`${git.branch}\`${sync} — ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked`;
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
                const shown = items.slice(0, PacketWire.#GIT_PATHS_PER_CLASS).join(" · ");
                const more = items.length > PacketWire.#GIT_PATHS_PER_CLASS ? ` (+${items.length - PacketWire.#GIT_PATHS_PER_CLASS} more)` : "";
                return `${label}: ${shown}${more}`;
            });
        return [head, ...lines].join("\n");
    }

}
