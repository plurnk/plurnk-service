import type { TextLineMarker } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import LineAnchors from "../content/line-anchors.ts";
import ScopeFormat from "../content/scope-format.ts";

export type LogFoldRange = readonly [startLine: number, endLine: number];
export type LogFoldRanges = readonly LogFoldRange[];

export type LogVisibilityScopeResolution =
    | { readonly ok: true; readonly range: LogFoldRange | null }
    | { readonly ok: false; readonly status: 400 | 416; readonly code: string; readonly detail: string; readonly recovery: string };

const INFINITY = Number.POSITIVE_INFINITY;

// One owner for durable log-body visibility. Stored ranges are sorted,
// disjoint, non-adjacent inclusive line intervals; -1 is the open-ended final
// endpoint. Scoped KILL unions intervals. Numeric scopes are intersected with
// each selected body's current physical lines, so a valid bulk scope outside
// one body is an idempotent no-op rather than an error.
export default class LogVisibility {
    static readonly OPEN: LogFoldRanges = Object.freeze([]);
    static readonly FOLDED: LogFoldRanges = Object.freeze([Object.freeze([1, -1] as const)]);

    static parse(value: unknown): LogFoldRanges {
        let decoded = value;
        if (typeof value === "string") {
            try {
                decoded = JSON.parse(value) as unknown;
            } catch (cause) {
                throw new TypeError("A log row carries malformed folded-range JSON.", { cause });
            }
        }
        if (!Array.isArray(decoded)) {
            throw new TypeError("A log row's folded ranges must be an array.");
        }
        const ranges: LogFoldRange[] = decoded.map((candidate) => {
            if (
                !Array.isArray(candidate)
                || candidate.length !== 2
                || !Number.isSafeInteger(candidate[0])
                || !Number.isSafeInteger(candidate[1])
            ) {
                throw new TypeError("Each folded range must contain exactly two safe integer line coordinates.");
            }
            const [start, end] = candidate as [number, number];
            if (start < 1 || (end !== -1 && end < start)) {
                throw new TypeError(`Folded range <${start},${end}> is invalid.`);
            }
            return [start, end];
        });
        for (let index = 1; index < ranges.length; index += 1) {
            const previous = ranges[index - 1]!;
            const current = ranges[index]!;
            if (previous[1] === -1 || current[0] <= previous[1] + 1) {
                throw new TypeError("Folded ranges must be sorted, disjoint, and non-adjacent.");
            }
        }
        return ranges;
    }

    static serialize(ranges: LogFoldRanges): string {
        return JSON.stringify(LogVisibility.parse(ranges));
    }

    static equal(left: LogFoldRanges, right: LogFoldRanges): boolean {
        return LogVisibility.serialize(left) === LogVisibility.serialize(right);
    }

    static resolveScope(
        marker: TextLineMarker | null,
        identity: string,
        content: string,
        publishedAnchors: readonly string[] = [],
    ): LogVisibilityScopeResolution {
        // {§log-scope-recovery} — every refusal ends in the forms that work on this row.
        const retire = `KILL (${identity}) with no scope retires the whole row`;
        const refuse = (detail: string, recovery = `Trim one line with <L> or lines L through M with <L,M>; ${retire}.`) =>
            ({ ok: false, status: 400, code: "curation-scope-invalid", detail, recovery }) as const;
        const total = TextCoordinates.lineCount(content);
        if (marker === null) {
            return { ok: true, range: total === 0 ? null : [1, -1] };
        }
        if (marker.marks.length !== 1 && marker.marks.length !== 2) {
            return refuse(`Log-body scopes require one line or an inclusive two-line range; received ${marker.marks.length} coordinates.`);
        }

        let marks: readonly (number | string)[] = marker.marks;
        if (LineAnchors.hasAnchor(marker)) {
            if (publishedAnchors.length > 0) {
                LineAnchors.assertProjection(content, publishedAnchors);
            }
            const anchorSets = [publishedAnchors, LineAnchors.tokens(identity, content)]
                .filter((anchors) => anchors.length > 0);
            const resolved = [...marker.marks];
            for (const [index, mark] of marker.marks.entries()) {
                if (typeof mark !== "string") continue;
                if (!LineAnchors.isAnchor(mark)) {
                    return refuse("A log-body anchor is malformed.");
                }
                const matches = new Set(anchorSets.flatMap((anchors) =>
                    anchors.flatMap((anchor, line) => anchor === mark ? [line + 1] : [])));
                // Log rows are immutable observations and curation is
                // idempotent. A hash that does not uniquely name a line in one
                // selected body therefore changes that body by the empty interval.
                if (matches.size !== 1) return { ok: true, range: null };
                resolved[index] = [...matches][0]!;
            }
            marks = resolved;
        }
        if (!marks.every((mark) => typeof mark === "number" && Number.isSafeInteger(mark))) {
            return refuse("Log-body line scopes require integer coordinates.");
        }
        const first = marks[0] as number;
        if (marks.length === 1) {
            if (first < 1) {
                return refuse(`<${first}> is not a line of a log body; lines are numbered from 1.`, `Write <1> to trim the first line; ${retire}.`);
            }
            return { ok: true, range: first <= total ? [first, first] : null };
        }

        const rawEnd = marks[1] as number;
        const written = `<${first},${rawEnd}>`;
        // {§range-starts-at-one} — one rule with the file slicer: a range never starts at 0 and is
        // never clamped; the refusal is its 416 in its words, naming the forms a log body takes.
        if (first < 1) {
            return {
                ok: false,
                status: 416,
                code: "range-not-satisfiable",
                detail: `Range ${written} starts at ${first}, which is not a line; lines are numbered from 1.`,
                recovery: rawEnd < 1
                    ? `Write <1,-1> to trim every line of the body; ${retire}.`
                    : `To trim lines 1 through ${rawEnd}, write <1,${rawEnd}>; ${retire}.`,
            };
        }
        if (rawEnd !== -1 && rawEnd < 1) {
            return refuse(`Range ${written} ends at ${rawEnd}, which is not a line; a range ends at a line from 1, or at -1 for the last line.`, `Write <${first},-1> to trim through the last line; ${retire}.`);
        }
        if (rawEnd !== -1 && rawEnd < first) {
            return refuse(`Range ${written} runs backward; a range names its first line first.`, `Write <${rawEnd},${first}>; ${retire}.`);
        }
        if (total === 0) return { ok: true, range: null };
        const start = first;
        const end = rawEnd === -1 ? total : Math.min(rawEnd, total);
        if (start > total || end < 1 || start > end) {
            return { ok: true, range: null };
        }
        return { ok: true, range: [start, rawEnd === -1 ? -1 : end] };
    }

    // {§log-kill-scope} — suppression is one-way: a scoped KILL unions its range into the stored set.
    static apply(
        folded: LogFoldRanges,
        range: LogFoldRange | null,
        totalLines: number,
    ): LogFoldRanges {
        const current = LogVisibility.parse(folded);
        if (range === null || totalLines === 0) return current;
        const next = LogVisibility.#union(current, [range]);
        return LogVisibility.#covers(next, 1, totalLines)
            ? LogVisibility.FOLDED
            : next;
    }

    static clipped(folded: LogFoldRanges, totalLines: number): LogFoldRanges {
        if (!Number.isSafeInteger(totalLines) || totalLines < 0) {
            throw new RangeError(`A log body requires a non-negative safe line count, got ${totalLines}.`);
        }
        if (totalLines === 0) return LogVisibility.OPEN;
        const clipped = LogVisibility.parse(folded).flatMap(([start, end]) => {
            if (start > totalLines) return [];
            const finiteEnd = end === -1 ? totalLines : Math.min(end, totalLines);
            return finiteEnd < start ? [] : [[start, end === -1 ? -1 : finiteEnd] as const];
        });
        return LogVisibility.#normalize(clipped);
    }

    static fullyFolded(folded: LogFoldRanges, totalLines: number): boolean {
        return totalLines > 0 && LogVisibility.#covers(
            LogVisibility.clipped(folded, totalLines),
            1,
            totalLines,
        );
    }

    static visibleLineOrdinals(folded: LogFoldRanges, totalLines: number): readonly number[] {
        const hidden = LogVisibility.clipped(folded, totalLines);
        const visible: number[] = [];
        let rangeIndex = 0;
        for (let line = 1; line <= totalLines; line += 1) {
            while (
                rangeIndex < hidden.length
                && LogVisibility.#end(hidden[rangeIndex]![1]) < line
            ) rangeIndex += 1;
            const range = hidden[rangeIndex];
            if (range === undefined || line < range[0]) visible.push(line);
        }
        return visible;
    }

    static combine(initial: LogFoldRanges, trimmed: LogFoldRanges): LogFoldRanges {
        return LogVisibility.#normalize([...LogVisibility.parse(initial), ...LogVisibility.parse(trimmed)]);
    }

    static format(ranges: LogFoldRanges): readonly string[] {
        return LogVisibility.parse(ranges).map(([start, end]) => ScopeFormat.lines(start, end));
    }

    static #end(end: number): number {
        return end === -1 ? INFINITY : end;
    }

    static #storedEnd(end: number): number {
        return end === INFINITY ? -1 : end;
    }

    static #normalize(ranges: LogFoldRanges): LogFoldRanges {
        if (ranges.length === 0) return LogVisibility.OPEN;
        const ordered = [...ranges]
            .map(([start, end]) => [start, LogVisibility.#end(end)] as const)
            .toSorted((left, right) => left[0] - right[0] || left[1] - right[1]);
        const merged: Array<[number, number]> = [];
        for (const [start, end] of ordered) {
            const previous = merged.at(-1);
            if (previous === undefined || start > previous[1] + 1) {
                merged.push([start, end]);
            } else {
                previous[1] = Math.max(previous[1], end);
            }
        }
        return merged.map(([start, end]) => [start, LogVisibility.#storedEnd(end)] as const);
    }

    static #union(left: LogFoldRanges, right: LogFoldRanges): LogFoldRanges {
        return LogVisibility.#normalize([...left, ...right]);
    }

    static #covers(ranges: LogFoldRanges, start: number, end: number): boolean {
        return ranges.some(([rangeStart, rangeEnd]) =>
            rangeStart <= start && LogVisibility.#end(rangeEnd) >= end);
    }
}
