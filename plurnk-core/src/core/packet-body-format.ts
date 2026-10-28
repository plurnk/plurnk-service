import { TextCoordinates, type TextLine } from "@plurnk/plurnk-mimetypes";
import BodyPreview from "../content/body-preview.ts";
import { LineAnchors } from "../content/index.ts";
import PatternEdits from "../content/pattern-edits.ts";
import ScopeFormat from "../content/scope-format.ts";
import type LogBody from "./LogBody.ts";
import type { ResolvedLogBody } from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import LogVisibility, { type LogFoldRanges } from "./LogVisibility.ts";
import PacketRowFacts, { type RowIdentity, type RowResultFacts } from "./packet-row-facts.ts";
import type { LogEntryView } from "./packet-wire.ts";

export interface VisibleLogBody {
    readonly content: string;
    readonly ordinals: readonly number[];
    readonly readableContent: string;
    readonly readableOrdinals: readonly number[];
    readonly folded: LogFoldRanges;
    readonly trimmed: LogFoldRanges;
    readonly totalLines: number;
    readonly fullyFolded: boolean;
}

export interface RowBody {
    readonly body: string;
    readonly display: "none" | "folded" | "open";
}

export default class PacketBodyFormat {
    // Number a non-READ body line as `<N>:<line>` — `N:` followed by NO separator whitespace
    // ({§zero-width-column-one-insert}): the leading digit prevents column-zero fence collisions and gives
    // the model line refs for free (`READ (...) <42-46>`), while the absence of any separator means a
    // reproduced line has nothing between `N:` and the content to copy. The content's OWN leading whitespace is
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
        const displayed = ordinals.map((ordinal) => sourceLineNumbers === null ? startLine + ordinal - 1 : sourceLineNumbers[ordinal - 1]);
        const width = lineAnchors === null
            ? numericLineNumberWidth > 0
                ? numericLineNumberWidth
                : String(Math.max(...displayed)).length
            : lineNumberWidth ?? 0;
        if (lineAnchors !== null && !LineAnchors.isLineNumberWidth(width)) {
            throw new TypeError("An anchored sparse log-body projection requires a valid source line width.");
        }
        return lines.map((line, index) => {
            const ordinal = ordinals[index];
            const lineNumber = displayed[index];
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
    static renderContentBody(
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
                ? PacketBodyFormat.#numberSelectedLines(
                    content,
                    lineOrdinals,
                    startLine,
                    lineAnchors,
                    lineNumberWidth,
                    numericLineNumberWidth,
                    sourceLineNumbers,
                )
                : lineAnchors === null
                    ? PacketBodyFormat.#numberLines(content, startLine, numericLineNumberWidth)
                    : LineAnchors.render(content, startLine, lineAnchors, lineNumberWidth ?? 0)
            : content;
        return PacketBodyFormat.#frameBody(rendered);
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

    static visibleBody(
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
            const line = lines[ordinal - 1];
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

    // {§packet} — a body the model did not author or ask for exactly takes its first page in
    // the packet: not the model's own row, not a retrieval (paged at its source), not an emission row,
    // and not the operator's message, which keeps its own rule ({§message-arrival}).
    static #receivedBody(e: LogEntryView, op: string | null): boolean {
        if (e.origin === "model" || op === "READ" || op === "FIND" || LogEntryProjection.isEmission(e)) return false;
        if (PacketRowFacts.isArrival(e)) {
            const source = typeof e.source === "string" ? e.source : null;
            return source !== null && source.startsWith("session://");
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
            chunk: cut ? PacketBodyFormat.#chunk(coordinates, physicalLines, end, text.length) : null,
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

    // The body the row shows: the canonical full body, shared with log READ, log FIND and search
    // derivation, whole. Whether a result fit was decided where it landed ({§tokenomics}).
    static rowBody(
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
        // {§packet} — what came back unasked in size is its first page here too; what the
        // model authored or asked for exactly, and a retrieval's own page, render whole.
        const projection = PacketBodyFormat.#receivedBody(e, op)
            ? PacketBodyFormat.#preview(projectedBody.content)
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
                const shown = BodyPreview.items(evidence, JSON.stringify);
                meta.matches = shown;
                if (shown.length !== evidence.length) meta.matchLocationCount = evidence.length;
            }
        }
        const body = emptyFind || projectedText.length === 0
            ? ""
            : PacketBodyFormat.renderContentBody(
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
        // {§log-wire-format} — a page states what it shows of what the row holds.
        const projectedChunk = projection.chunk !== null && bodyVisibility.folded.length > 0 && !bodyVisibility.fullyFolded
            ? PacketBodyFormat.#sparseChunk(fullBody.content, projectedBody.content, sourceOrdinals, projection.text)
            : projection.chunk;
        if (display === "open" && projectedChunk !== null) {
            meta.preview = projectedChunk;
            delete meta.lines;
        }
        return { body, display };
    }
}
