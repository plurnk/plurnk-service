// `<L>` line-marker semantics (plurnk.md §`<L>`):
//
//   <N>      selects position N (1-indexed)
//   <N,M>    selects positions N..M inclusive
//   <0>      sentinel: before position 1 (EDIT prepend)
//   <-1>     sentinel: after the last position (EDIT append)
//   <1,-1>   every position (in range context, -1 normalizes to last line)
//   <SL,SC,EL,EC> selects an exact text region with an exclusive end.
//
// Runtime tolerance (not canonical producer syntax): <SL,SC,EL> is accepted
// as <SL,SC> through the end of line EL and lowered immediately to four
// coordinates. Successful results carry the exact normalization evidence.
//
// "N and M are signed integers" — but plurnk.md only documents <0> and
// <-1> as defined sentinels. Other negatives (<-2>, <-3>) are not
// specified and rejected as 416. Within a range, -1 as the M endpoint
// means "include through the last line" (so <1,-1> is whole content).

import type { LineMarker, RangeExtent, TextRegion } from "@plurnk/plurnk-contracts";
import { TextCoordinates, type TextLine } from "@plurnk/plurnk-mimetypes";
import Results, { type SchemeResult, type ScopeNormalization } from "./Results.ts";

interface NormalizedMarker {
    kind: "range" | "before-first" | "after-last";
    start: number;
    end: number;
}

export interface TextReplacement {
    readonly start: number;
    readonly end: number;
    readonly body: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly normalization?: ScopeNormalization;
}

export type RangeUnit = RangeExtent["unit"];
export interface SliceResult extends SchemeResult {
    text?: string;
    startLine?: number;
    region?: TextRegion;
    range?: RangeExtent;
}
export interface PageResult<T> extends SchemeResult { items?: T[]; range?: RangeExtent }
export interface EditResult extends SchemeResult { result?: string; range?: RangeExtent }
export interface BatchEdit {
    readonly marker: LineMarker;
    readonly body: string;
}

export default class Slicer {
    static #failure<T extends SchemeResult>(
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): T {
        return Results.failure("schemes:slicer", code, status, detail, fields, extensions) as T;
    }

    static #rangeFailure<T extends SchemeResult>(
        detail: string,
        range: RangeExtent,
    ): T {
        return Slicer.#failure(
            "range-not-satisfiable",
            416,
            detail,
            { range },
            {
                range,
                stage: "projection",
                recovery: "Choose a range within the available extent.",
                retryable: false,
            },
        );
    }

    static #regionFailure<T extends SchemeResult>(
        detail: string,
        marker: LineMarker,
    ): T {
        return Slicer.#failure(
            "range-not-satisfiable",
            416,
            detail,
            {},
            {
                requestedCoordinates: marker.marks,
                columnKind: "unicodeCodePoints",
                stage: "projection",
                recovery: "Choose a region within the available text.",
                retryable: false,
            },
        );
    }

    static #extent(marker: LineMarker, total: number, unit: RangeUnit): RangeExtent {
        const first = marker.marks[0];
        return {
            unit,
            total,
            requested: [first, marker.marks[1] ?? first],
        };
    }

    static #projectedExtent(
        extent: RangeExtent,
        first: number | null,
        last: number | null,
    ): RangeExtent {
        return first === null || last === null
            ? extent
            : { ...extent, returned: [first, last] };
    }

    static coversAvailable(range: RangeExtent): boolean {
        return range.total === 0
            || (range.returned?.[0] === 1 && range.returned[1] === range.total);
    }

    static #exactTextReplacement(
        content: string,
        marker: LineMarker,
        body: string,
    ): TextReplacement | { error: string } {
        const [startLine, startColumn, endLine, rawEndColumn] = marker.marks;
        if (![startLine, startColumn, endLine, rawEndColumn].every(Number.isSafeInteger)) {
            return { error: "An exact text region requires four integer coordinates." };
        }
        const lines = TextCoordinates.lines(content);
        if (startLine < 1 || startLine > lines.length) {
            return { error: `Start line ${startLine} is outside the available line range 1..${lines.length}.` };
        }
        if (endLine < 1) {
            return { error: `End line ${endLine} is outside the available line range 1..${lines.length}.` };
        }
        if (rawEndColumn < 1) {
            return { error: `End column ${rawEndColumn} must be positive.` };
        }
        const pastEof = endLine > lines.length;
        const resolvedEndLine = pastEof ? lines.length : endLine;
        const endLineData = lines[resolvedEndLine - 1]!;
        const maxEndColumn = [...content.slice(endLineData.start, endLineData.contentEnd)].length + 1;
        const endColumn = pastEof ? maxEndColumn : Math.min(rawEndColumn, maxEndColumn);
        let start: number;
        let end: number;
        try {
            start = TextCoordinates.offsetAtPosition(content, startLine, startColumn);
            end = TextCoordinates.offsetAtPosition(content, resolvedEndLine, endColumn);
        } catch (cause) {
            return { error: cause instanceof Error ? cause.message : String(cause) };
        }
        if (end < start) {
            return {
                error: `Exact region ${startLine},${startColumn},${endLine},${rawEndColumn} ends before it starts.`,
            };
        }
        return { start, end, body, startLine, endLine: resolvedEndLine };
    }

    static #preferredSeparator(content: string, lines: readonly TextLine[]): string {
        return lines.find(({ separator }) => separator.length > 0)?.separator
            ?? (content.includes("\r\n") ? "\r\n" : content.includes("\r") ? "\r" : "\n");
    }

    static #lineTextReplacement(
        content: string,
        marker: LineMarker,
        body: string,
    ): TextReplacement | { error: string } {
        const lines = TextCoordinates.logicalLines(content);
        const norm = Slicer.#normalize(marker, lines.length);
        if ("error" in norm) return norm;
        const separator = Slicer.#preferredSeparator(content, lines);
        if (norm.kind === "before-first") {
            const inserted = body.length > 0 && content.length > 0 && !/[\r\n]$/.test(body)
                ? `${body}${separator}`
                : body;
            return { start: 0, end: 0, body: inserted, startLine: 1, endLine: 1 };
        }
        if (norm.kind === "after-last") {
            const prefix = body.length > 0 && content.length > 0 && !/[\r\n]$/.test(content)
                ? separator
                : "";
            const suffix = body.length > 0 && /[\r\n]$/.test(content) && !/[\r\n]$/.test(body)
                ? separator
                : "";
            return {
                start: content.length,
                end: content.length,
                body: `${prefix}${body}${suffix}`,
                startLine: Math.max(lines.length, 1),
                endLine: Math.max(lines.length, 1),
            };
        }
        const first = lines[norm.start - 1];
        const last = lines[norm.end - 1];
        if (first === undefined || last === undefined) {
            if (lines.length === 0 && norm.start === 1 && norm.end === 0) {
                return { start: 0, end: 0, body, startLine: 1, endLine: 1 };
            }
            return { error: `Line range ${norm.start},${norm.end} cannot be resolved.` };
        }
        const inserted = body.length > 0 && last.separator.length > 0 && !/[\r\n]$/.test(body)
            ? `${body}${last.separator}`
            : body;
        return {
            start: first.start,
            end: last.end,
            body: inserted,
            startLine: norm.start,
            endLine: norm.end,
        };
    }

    static textReplacement(
        content: string,
        marker: LineMarker,
        body: string,
    ): TextReplacement | { error: string } {
        if (marker.marks.length === 3) {
            const expanded = Slicer.#expandRegion3(content, marker);
            if ("error" in expanded) return expanded;
            const replacement = Slicer.#exactTextReplacement(content, expanded.marker, body);
            return "error" in replacement
                ? replacement
                : { ...replacement, normalization: expanded.normalization };
        }
        if (marker.marks.length === 4) {
            return Slicer.#exactTextReplacement(content, marker, body);
        }
        if (marker.marks.length === 1 || marker.marks.length === 2) {
            return Slicer.#lineTextReplacement(content, marker, body);
        }
        return {
            error: `Text regions require one, two, or four coordinates; received ${marker.marks.length}.`,
        };
    }

    static #expandRegion3(
        content: string,
        marker: LineMarker,
    ): { marker: LineMarker; normalization: ScopeNormalization } | { error: string } {
        const [startLine, startColumn, endLine] = marker.marks;
        if (![startLine, startColumn, endLine].every(Number.isSafeInteger)) {
            return { error: "A tolerated three-coordinate text region requires integer coordinates." };
        }
        const lines = TextCoordinates.lines(content);
        if (endLine < 1) {
            return { error: `End line ${endLine} is outside the available line range 1..${lines.length}.` };
        }
        const resolvedEndLine = Math.min(endLine, lines.length);
        const last = lines[resolvedEndLine - 1];
        if (last === undefined) {
            return { error: `End line ${endLine} cannot select from empty content.` };
        }
        const endColumn = [...content.slice(last.start, last.contentEnd)].length + 1;
        const requested: ScopeNormalization["requested"] = [startLine, startColumn, endLine];
        const canonical: ScopeNormalization["canonical"] = [startLine, startColumn, resolvedEndLine, endColumn];
        return {
            marker: { ...marker, marks: [...canonical] },
            normalization: { requested, canonical },
        };
    }

    static #normalize(marker: LineMarker, totalLines: number): NormalizedMarker | { error: string } {
        // {§slicer-text-algebra} The parser carries raw `marks: [number, ...]`;
        // this owner assigns roles: marks[0] = first/position, marks[1] = last
        // (range end). A single mark is a position/sentinel; two is a range.
        if (marker.marks.length !== 1 && marker.marks.length !== 2) {
            return { error: `A positional range requires one or two coordinates; received ${marker.marks.length}.` };
        }
        const first = marker.marks[0];
        const last = marker.marks.length > 1 ? marker.marks[1] : null;
        if (!Number.isInteger(first) || (last !== null && !Number.isInteger(last))) {
            return { error: "Whole-line scopes require integer coordinates." };
        }
        if (last === null) {
            if (first === 0) return { kind: "before-first", start: 0, end: 0 };
            if (first === -1) return { kind: "after-last", start: totalLines, end: totalLines };
            if (first > 0 && first <= totalLines) return { kind: "range", start: first, end: first };
            return {
                error: totalLines === 0
                    ? `Line ${first} cannot select from empty content.`
                    : `Line ${first} is outside the available line range 1..${totalLines}.`,
            };
        }
        // Whole-content `<1,-1>` (and its `<0,-1>` alias) is valid even on
        // empty content — it selects the entire, possibly-empty range. Without
        // this, an EDIT that replaces-everything on a freshly-created empty
        // entry would 416. start>end here yields an empty slice for READ and a
        // full replacement for EDIT.
        if (totalLines === 0) {
            if ((first === 0 || first === 1) && (last === -1 || last > 0)) {
                return { kind: "range", start: 1, end: 0 };
            }
            return { error: `Range ${first},${last} cannot select from empty content.` };
        }
        let n = first;
        let m = last;
        if (n === 0) n = 1;
        if (m === -1 || m > totalLines) m = totalLines;
        if (n < 1 || n > totalLines) return { error: `Range start ${first} is outside the available line range 1..${totalLines}.` };
        if (m < 1) return { error: `Range end ${last} is outside the available line range 1..${totalLines}.` };
        if (n > m) return { error: `Range start ${first} exceeds end ${last}.` };
        return { kind: "range", start: n, end: m };
    }

    // READ a line range. Returns the raw selected lines (no `N:` prefix)
    // plus the 1-indexed position of the first selected line. The render
    // READ projection and packet presentation add the applicable coordinate
    // prefix from `startLine`; canonical content remains unprefixed.
    //
    // Sentinel positions <0> and <-1> select no content (they're insertion
    // points, not lines) → status 200 with empty text.
    static lines(content: string, marker: LineMarker): SliceResult {
        const requestedMarker = marker;
        let normalization: ScopeNormalization | undefined;
        if (marker.marks.length === 3) {
            const expanded = Slicer.#expandRegion3(content, marker);
            if ("error" in expanded) return Slicer.#regionFailure(expanded.error, requestedMarker);
            marker = expanded.marker;
            normalization = expanded.normalization;
        }
        if (marker.marks.length === 4) {
            const selected = Slicer.#exactTextReplacement(content, marker, "");
            if ("error" in selected) {
                return Slicer.#regionFailure(selected.error, requestedMarker);
            }
            const region = TextCoordinates.regionFromOffsets(
                content,
                selected.start,
                selected.end,
            );
            if (region === null) {
                throw new Error("Slicer resolved an exact replacement with no addressable TextRegion.");
            }
            return {
                status: 200,
                text: content.slice(selected.start, selected.end),
                startLine: selected.startLine,
                region,
                ...(normalization === undefined ? {} : { scopeNormalizations: [normalization] }),
            };
        }
        if (marker.marks.length !== 1 && marker.marks.length !== 2) {
            return Slicer.#regionFailure(
                `Text regions require one, two, or four coordinates; received ${marker.marks.length}.`,
                marker,
            );
        }
        const lines = TextCoordinates.logicalLines(content);
        const norm = Slicer.#normalize(marker, lines.length);
        if ("error" in norm) {
            return Slicer.#rangeFailure(norm.error, Slicer.#extent(marker, lines.length, "line"));
        }
        const extent = Slicer.#extent(marker, lines.length, "line");
        if (norm.kind !== "range") {
            return {
                status: 200,
                text: "",
                startLine: undefined,
                range: Slicer.#projectedExtent(extent, null, null),
            };
        }
        if (lines.length === 0) {
            const region = TextCoordinates.regionFromOffsets(content, 0, 0);
            if (region === null) {
                throw new Error("Slicer could not address an empty text resource.");
            }
            return {
                status: 200,
                text: "",
                startLine: 1,
                region,
                range: Slicer.#projectedExtent(extent, null, null),
            };
        }
        const selected = lines
            .slice(norm.start - 1, norm.end)
            .map(({ start, contentEnd }) => content.slice(start, contentEnd));
        const region = TextCoordinates.lineRegion(content, norm.start, norm.end);
        if (region === null) {
            throw new Error("Slicer resolved a whole-line selection with no addressable TextRegion.");
        }
        return {
            status: 200,
            text: selected.join("\n"),
            startLine: norm.start,
            region,
            range: Slicer.#projectedExtent(extent, norm.start, norm.end),
        };
    }

    // `<L>` over an ordered result set uses the same positional contract as
    // READ slicing. The returned extent lets a scheme put exact recovery facts
    // in RFC 9457 Problem Details instead of emitting a bare 416.
    static page<T>(
        items: readonly T[],
        marker: LineMarker,
        options: { readonly unit?: RangeUnit; readonly allowEmpty?: boolean } = {},
    ): PageResult<T> {
        const total = items.length;
        const extent = Slicer.#extent(marker, total, options.unit ?? "result");
        if (marker.marks.length !== 1 && marker.marks.length !== 2) {
            return Slicer.#failure(
                "range-not-satisfiable",
                416,
                `Result pagination requires one position or an inclusive two-position range; received ${marker.marks.length} positions.`,
                { range: extent },
                {
                    range: extent,
                    requestedPositions: marker.marks,
                    stage: "projection",
                    recovery: "Use <N> or <N,M> to select results.",
                    retryable: false,
                },
            );
        }
        const [first, last] = extent.requested;
        if (!Number.isInteger(first) || !Number.isInteger(last)) {
            return Slicer.#rangeFailure(
                `Result ranges require integer positions; the result set contains ${total} item(s).`,
                extent,
            );
        }
        if (marker.marks.length === 1) {
            if (first === 0 || first === -1) {
                return { status: 200, items: [], range: Slicer.#projectedExtent(extent, null, null) };
            }
            if (total === 0 && options.allowEmpty === true && first > 0) {
                return { status: 200, items: [], range: Slicer.#projectedExtent(extent, null, null) };
            }
            if (first > 0 && first <= total) {
                return {
                    status: 200,
                    items: [items[first - 1]],
                    range: Slicer.#projectedExtent(extent, first, first),
                };
            }
            return Slicer.#rangeFailure(
                `Result ${first} is out of range; available positions are 1..${total} — this scope pages ${extent.unit} items, not text lines.`,
                extent,
            );
        }
        if (total === 0) {
            if (options.allowEmpty === true && first > 0 && (last === -1 || last >= first)) {
                return { status: 200, items: [], range: Slicer.#projectedExtent(extent, null, null) };
            }
            if ((first === 0 || first === 1) && last === -1) {
                return { status: 200, items: [], range: Slicer.#projectedExtent(extent, null, null) };
            }
            return Slicer.#rangeFailure(
                `Result range ${first},${last} cannot select from an empty result set.`,
                extent,
            );
        }
        const n = first === 0 ? 1 : first;
        const m = last === -1 ? total : Math.min(last, total);
        if (n < 1 || n > total) return Slicer.#rangeFailure(
            `Result range start ${first} is out of range; available positions are 1..${total} — this scope pages ${extent.unit} items, not text lines.`,
            extent,
        );
        if (m < 1) return Slicer.#rangeFailure(
            `Result range end ${last} is out of range; available positions are 1..${total}.`,
            extent,
        );
        if (n > m) return Slicer.#rangeFailure(
            `Result range start ${first} exceeds end ${last}.`,
            extent,
        );
        return {
            status: 200,
            items: items.slice(n - 1, m),
            range: Slicer.#projectedExtent(extent, n, m),
        };
    }

    // COPY-style raw slice. Returns the selected source bytes verbatim (no
    // line-number prefix), including any separators owned by a whole-line
    // selection.
    // Used for COPY/MOVE `<L>` per the service SPEC (COPY/MOVE source-range, symmetric
    // with READ but without the READ-output prefix that's a render concern,
    // not a data concern).
    static linesRaw(content: string, marker: LineMarker): SliceResult {
        const selected = Slicer.textReplacement(content, marker, "");
        if ("error" in selected) {
            return marker.marks.length !== 1 && marker.marks.length !== 2
                ? Slicer.#regionFailure(selected.error, marker)
                : Slicer.#rangeFailure(
                    selected.error,
                    Slicer.#extent(marker, TextCoordinates.logicalLines(content).length, "line"),
                );
        }
        return {
            status: 200,
            text: content.slice(selected.start, selected.end),
            startLine: selected.startLine,
            ...(selected.normalization === undefined
                ? {}
                : { scopeNormalizations: [selected.normalization] }),
        };
    }

    // EDIT applies body at the marker position:
    //   <0>     prepend body before line 1
    //   <-1>    append body after the last line
    //   <N>     replace line N with body
    //   <N,M>   replace lines N..M with body
    //   <SL,SC,EL,EC> replace an exact region; equal endpoints insert
    //   <1,-1>  whole content (replace everything); empty body clears.
    // Empty body with <N>/<N,M> deletes those lines.
    static lineMarkerEdit(content: string, marker: LineMarker, body: string): EditResult {
        return Slicer.lineMarkerEditBatch(content, [{ marker, body }]);
    }

    static lineMarkerEditBatch(content: string, edits: readonly BatchEdit[]): EditResult {
        const replacements: Array<TextReplacement & { readonly marker: LineMarker }> = [];
        for (const edit of edits) {
            const replacement = Slicer.textReplacement(content, edit.marker, edit.body);
            if ("error" in replacement) {
                return edit.marker.marks.length !== 1 && edit.marker.marks.length !== 2
                    ? Slicer.#regionFailure(replacement.error, edit.marker)
                    : Slicer.#rangeFailure(
                        replacement.error,
                        Slicer.#extent(edit.marker, TextCoordinates.logicalLines(content).length, "line"),
                    );
            }
            replacements.push({ ...replacement, marker: edit.marker });
        }
        if (replacements.length > 1 && replacements.some(({ start, end }) =>
            start === 0 && end === content.length && start !== end)) {
            return Slicer.#failure(
                "overlapping-edits",
                409,
                "A whole-resource replacement cannot coexist with another EDIT.",
                {},
                {
                    stage: "mutation",
                    editCount: replacements.length,
                    recovery: "Submit the whole-resource replacement by itself.",
                    retryable: false,
                },
            );
        }
        for (let i = 0; i < replacements.length; i += 1) {
            for (let j = i + 1; j < replacements.length; j += 1) {
                const a = replacements[i]!;
                const b = replacements[j]!;
                const aInsertion = a.start === a.end;
                const bInsertion = b.start === b.end;
                const conflicts = aInsertion && bInsertion
                    ? a.start === b.start
                    : aInsertion
                        ? a.start >= b.start && a.start < b.end
                        : bInsertion
                            ? b.start >= a.start && b.start < a.end
                            : a.start < b.end && b.start < a.end;
                if (conflicts) {
                    const lineRanges = [a.marker, b.marker].every(({ marks }) =>
                        marks.length === 1 || marks.length === 2)
                        ? {
                            conflictingRanges: [a.marker, b.marker].map(({ marks }) => ({
                                first: marks[0],
                                last: marks[1] ?? marks[0],
                            })),
                        }
                        : {};
                    return Slicer.#failure(
                        "overlapping-edits",
                        409,
                        `EDIT regions <${a.marker.marks.join(",")}> and <${b.marker.marks.join(",")}> overlap.`,
                        {},
                        {
                            stage: "mutation",
                            conflictingRegions: [a.marker.marks, b.marker.marks],
                            ...lineRanges,
                            recovery: "Submit non-overlapping EDIT regions.",
                            retryable: false,
                        },
                    );
                }
            }
        }
        let result = content;
        for (const replacement of replacements.toSorted((a, b) => b.start - a.start || b.end - a.end)) {
            result = `${result.slice(0, replacement.start)}${replacement.body}${result.slice(replacement.end)}`;
        }
        const scopeNormalizations = replacements.flatMap(({ normalization }) =>
            normalization === undefined ? [] : [normalization]);
        return {
            status: 200,
            result,
            ...(scopeNormalizations.length === 0 ? {} : { scopeNormalizations }),
        };
    }

}
