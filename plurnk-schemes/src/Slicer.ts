// `<L>` line-marker semantics (plurnk.md §`<L>`):
//
//   <N>      selects position N (1-indexed)
//   <N,M>    selects positions N..M inclusive
//   <0>      sentinel: before position 1 (EDIT prepend)
//   <-1>     sentinel: after the last position (EDIT append)
//   <1,-1>   every position (in range context, -1 normalizes to last line)
//   <N.frac> fractional single mark: an INSERT POINT between lines, not a line
//            to replace (#18). EDIT inserts after line floor(N.frac), replacing
//            nothing (<2.5> = between lines 2 and 3; <0.5> = prepend; <T.5> at
//            T = totalLines = append). For READ it selects no content, like the
//            <0>/<-1> sentinels.
//
// "N and M are signed integers" — but plurnk.md only documents <0> and
// <-1> as defined sentinels. Other negatives (<-2>, <-3>) are not
// specified and rejected as 416. Within a range, -1 as the M endpoint
// means "include through the last line" (so <1,-1> is whole content).

import type { LineMarker } from "@plurnk/plurnk-grammar";
import Results, { type SchemeResult } from "./Results.ts";

interface NormalizedMarker {
    kind: "range" | "before-first" | "after-last" | "insert-between";
    start: number;
    end: number;
}

export type RangeUnit = "line" | "item" | "result";
export interface RangeExtent {
    readonly unit: RangeUnit;
    readonly requested: { readonly first: number; readonly last: number | null };
    readonly available: { readonly first: number | null; readonly last: number | null; readonly total: number };
}
export interface SliceResult extends SchemeResult { text?: string; startLine?: number; range?: RangeExtent }
export interface JsonSliceResult extends SchemeResult { body?: string; range?: RangeExtent }
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

    static #extent(marker: LineMarker, total: number, unit: RangeUnit): RangeExtent {
        return {
            unit,
            requested: {
                first: marker.marks[0],
                last: marker.marks.length > 1 ? marker.marks[1] : null,
            },
            available: {
                first: total === 0 ? null : 1,
                last: total === 0 ? null : total,
                total,
            },
        };
    }

    static #splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
        const trailingNewline = content.endsWith("\n");
        if (content === "") return { lines: [], trailingNewline: false };
        const lines = content.split("\n");
        if (trailingNewline) lines.pop();
        return { lines, trailingNewline };
    }

    static #normalize(marker: LineMarker, totalLines: number): NormalizedMarker | { error: string } {
        // grammar 0.49 carries raw `marks: [number, ...]` and punts role
        // assignment to us (#19): marks[0] = first/position, marks[1] = last
        // (range end). A single mark is a position/sentinel; two is a range.
        const first = marker.marks[0];
        const last = marker.marks.length > 1 ? marker.marks[1] : null;
        if (last === null) {
            if (first === 0) return { kind: "before-first", start: 0, end: 0 };
            if (first === -1) return { kind: "after-last", start: totalLines, end: totalLines };
            // Fractional single mark <N.frac> is an insert point between lines,
            // not a position to replace (#18): insert after line floor(N.frac).
            // floor 0 = prepend, floor totalLines = append.
            if (!Number.isInteger(first)) {
                const at = Math.floor(first);
                if (first > 0 && at <= totalLines) return { kind: "insert-between", start: at, end: at };
                return { error: `Insert point ${first} is outside the available boundary range 0..${totalLines}.` };
            }
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
            if ((first === 0 || first === 1) && last === -1) return { kind: "range", start: 1, end: 0 };
            return { error: `Range ${first},${last} cannot select from empty content.` };
        }
        let n = first;
        let m = last;
        if (n === 0) n = 1;
        if (m === -1) m = totalLines;
        if (n < 1 || n > totalLines) return { error: `Range start ${first} is outside the available line range 1..${totalLines}.` };
        if (m < 1 || m > totalLines) return { error: `Range end ${last} is outside the available line range 1..${totalLines}.` };
        if (n > m) return { error: `Range start ${first} exceeds end ${last}.` };
        return { kind: "range", start: n, end: m };
    }

    // READ a line range. Returns the raw selected lines (no `N:\t` prefix)
    // plus the 1-indexed position of the first selected line. The render
    // layer adds `N:\t` per plurnk.md ("READ output prefixes every line with
    // line numbers, N:\t") starting from `startLine` — keeps numbering as a
    // presentation concern, prevents double-prefixing when the same content
    // passes through the log render.
    //
    // Sentinel positions <0> and <-1> select no content (they're insertion
    // points, not lines) → status 200 with empty text.
    static lines(content: string, marker: LineMarker): SliceResult {
        const { lines } = Slicer.#splitLines(content);
        const norm = Slicer.#normalize(marker, lines.length);
        if ("error" in norm) {
            return Slicer.#rangeFailure(norm.error, Slicer.#extent(marker, lines.length, "line"));
        }
        if (norm.kind !== "range") return { status: 200, text: "", startLine: undefined };
        const selected = lines.slice(norm.start - 1, norm.end);
        return { status: 200, text: selected.join("\n"), startLine: norm.start };
    }

    // Structural `<L>` slice for JSON sources (plurnk-grammar 0.13.0).
    // "On structured entries, <L> addresses item index, not line number."
    // Every JSON value becomes a list of top-level items:
    //   array `[a, b, c]`     → items are the array elements
    //   object `{k1: v1, ...}` → items are key-value pairs (as single-key objects)
    //   scalar `"hello"` / 42  → item is the scalar itself (length-1 list)
    // `<L>` indexes into that list (1-indexed). Result is always a JSON array.
    // Sentinels `<0>` / `<-1>` are insertion points — empty `[]` for READ.
    // Out-of-range positions return 416. Matches the uniform "always JSON
    // array out" shape we settled for matcher results.
    static #jsonValueToItems(parsed: unknown): unknown[] {
        if (Array.isArray(parsed)) return parsed;
        if (parsed !== null && typeof parsed === "object") {
            // Object items are single-key {key: value} wrappers, in insertion
            // order. Object.entries preserves spec-guaranteed iteration order
            // for string keys.
            return Object.entries(parsed).map(([k, v]) => ({ [k]: v }));
        }
        // Scalar (string, number, boolean, null): a length-1 list of itself.
        return [parsed];
    }

    static jsonItems(content: string, marker: LineMarker): JsonSliceResult {
        let parsed: unknown;
        try { parsed = JSON.parse(content); }
        catch (err) {
            return Slicer.#failure(
                "malformed-json",
                400,
                `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
                {},
                {
                    stage: "decode",
                    recovery: "Correct the JSON content before using structural operations.",
                    retryable: false,
                },
            );
        }
        const items = Slicer.#jsonValueToItems(parsed);
        const total = items.length;
        const first = marker.marks[0];
        const last = marker.marks.length > 1 ? marker.marks[1] : null;
        if (last === null) {
            if (first === 0 || first === -1) return { status: 200, body: "[]" };
            if (first > 0 && first <= total) return { status: 200, body: JSON.stringify([items[first - 1]], null, 2) };
            return Slicer.#rangeFailure(
                `Item ${first} is out of range; available positions are 1..${total}.`,
                Slicer.#extent(marker, total, "item"),
            );
        }
        // Whole-content `<1,-1>` is valid on an empty item list — it selects
        // the entire, empty range (mirrors #normalize's empty-content rule).
        if (total === 0) {
            if ((first === 0 || first === 1) && last === -1) return { status: 200, body: "[]" };
            return Slicer.#rangeFailure(
                `Range ${first},${last} cannot select from an empty item set.`,
                Slicer.#extent(marker, total, "item"),
            );
        }
        let n = first;
        let m = last;
        if (n === 0) n = 1;
        if (m === -1) m = total;
        if (n < 1 || n > total) return Slicer.#rangeFailure(
            `Range start ${first} is out of range; available positions are 1..${total}.`,
            Slicer.#extent(marker, total, "item"),
        );
        if (m < 1 || m > total) return Slicer.#rangeFailure(
            `Range end ${last} is out of range; available positions are 1..${total}.`,
            Slicer.#extent(marker, total, "item"),
        );
        if (n > m) return Slicer.#rangeFailure(
            `Range start ${first} exceeds end ${last}.`,
            Slicer.#extent(marker, total, "item"),
        );
        return { status: 200, body: JSON.stringify(items.slice(n - 1, m), null, 2) };
    }

    // `<L>` over an ordered result set uses the same positional contract as
    // READ slicing. The returned extent lets a scheme put exact recovery facts
    // in RFC 9457 Problem Details instead of emitting a bare 416.
    static page<T>(items: readonly T[], marker: LineMarker): PageResult<T> {
        const total = items.length;
        const extent = Slicer.#extent(marker, total, "result");
        const { first, last } = extent.requested;
        if (!Number.isInteger(first) || (last !== null && !Number.isInteger(last))) {
            return Slicer.#rangeFailure(
                `Result ranges require integer positions; the result set contains ${total} item(s).`,
                extent,
            );
        }
        if (last === null) {
            if (first === 0 || first === -1) return { status: 200, items: [] };
            if (first > 0 && first <= total) return { status: 200, items: [items[first - 1]] };
            return Slicer.#rangeFailure(
                `Result ${first} is out of range; available positions are 1..${total}.`,
                extent,
            );
        }
        if (total === 0) {
            if ((first === 0 || first === 1) && last === -1) return { status: 200, items: [] };
            return Slicer.#rangeFailure(
                `Result range ${first},${last} cannot select from an empty result set.`,
                extent,
            );
        }
        const n = first === 0 ? 1 : first;
        const m = last === -1 ? total : last;
        if (n < 1 || n > total) return Slicer.#rangeFailure(
            `Result range start ${first} is out of range; available positions are 1..${total}.`,
            extent,
        );
        if (m < 1 || m > total) return Slicer.#rangeFailure(
            `Result range end ${last} is out of range; available positions are 1..${total}.`,
            extent,
        );
        if (n > m) return Slicer.#rangeFailure(
            `Result range start ${first} exceeds end ${last}.`,
            extent,
        );
        return { status: 200, items: items.slice(n - 1, m) };
    }

    // Structural `<L>` EDIT for JSON sources (plurnk-grammar 0.13.0/0.14.0).
    // Source-shape rules (matches jsonItems' item definition):
    //   array  → items are elements
    //   object → items are key-value pairs (single-key fragments)
    //   scalar → length-1 list of itself; grow markers (<0>,<-1>) reject
    //
    // Body shape (Resolution B):
    //   body parses as JSON array → those are the items to splice in
    //   body parses as non-array JSON → single item to splice in
    //   empty body → delete the selection
    //   body fails JSON parse → 400 (path-extension declares intent; honor it)
    //
    // Marker semantics (parallel to line-EDIT):
    //   <N>    replace item N with body item(s)
    //   <N,M>  replace items N..M with body item(s)
    //   <0>    prepend body item(s)
    //   <-1>   append body item(s)
    //   <1,-1> replace whole top-level with body item(s); empty body clears
    //   Empty body on a sentinel insertion (<0> or <-1>) → no-op.
    static #itemsFromBody(body: string): { items: unknown[] } | { error: string } {
        if (body === "") return { items: [] };  // empty body = delete
        let parsed: unknown;
        try { parsed = JSON.parse(body); }
        catch (err) { return { error: `malformed JSON body: ${err instanceof Error ? err.message : String(err)}` }; }
        if (Array.isArray(parsed)) return { items: parsed };
        return { items: [parsed] };
    }

    static #applyJsonArrayEdit(source: unknown[], marker: LineMarker, items: unknown[]): EditResult {
        const total = source.length;
        const first = marker.marks[0];
        const last = marker.marks.length > 1 ? marker.marks[1] : null;
        let result: unknown[];
        if (last === null) {
            if (first === 0) result = [...items, ...source];
            else if (first === -1) result = [...source, ...items];
            else if (first > 0 && first <= total) result = [...source.slice(0, first - 1), ...items, ...source.slice(first)];
            else return Slicer.#rangeFailure(
                `Position ${first} is out of range; available positions are 1..${total}.`,
                Slicer.#extent(marker, total, "item"),
            );
        } else if (total === 0) {
            // Empty array: only whole-content `<1,-1>` (or `<0,-1>` alias) is
            // valid — it replaces the (empty) whole with the body items. Any
            // other range on an empty array is out of range.
            if ((first !== 1 && first !== 0) || last !== -1) return Slicer.#rangeFailure(
                `Range ${first},${last} cannot edit an empty array.`,
                Slicer.#extent(marker, total, "item"),
            );
            result = [...items];
        } else {
            let n = first;
            let m = last;
            if (n === 0) n = 1;
            if (m === -1) m = total;
            if (n < 1 || n > total) return Slicer.#rangeFailure(
                `Range start ${first} is out of range; available positions are 1..${total}.`,
                Slicer.#extent(marker, total, "item"),
            );
            if (m < 1 || m > total) return Slicer.#rangeFailure(
                `Range end ${last} is out of range; available positions are 1..${total}.`,
                Slicer.#extent(marker, total, "item"),
            );
            if (n > m) return Slicer.#rangeFailure(
                `Range start ${first} exceeds end ${last}.`,
                Slicer.#extent(marker, total, "item"),
            );
            result = [...source.slice(0, n - 1), ...items, ...source.slice(m)];
        }
        return { status: 200, result: JSON.stringify(result, null, 2) };
    }

    static #applyJsonObjectEdit(source: Record<string, unknown>, marker: LineMarker, items: unknown[]): EditResult {
        // Object items are key-value pairs. Body items must be objects;
        // each object's entries become kv-pairs to splice in. Items that
        // aren't single objects → 400 (model used wrong body shape for an
        // object source).
        const bodyEntries: [string, unknown][] = [];
        for (const item of items) {
            if (item === null || typeof item !== "object" || Array.isArray(item)) {
                return Slicer.#failure(
                    "invalid-edit-body",
                    400,
                    "An object source requires every body item to be a JSON object containing key-value pairs.",
                    {},
                    {
                        stage: "mutation",
                        recovery: "Provide JSON objects as the replacement items.",
                        retryable: false,
                    },
                );
            }
            bodyEntries.push(...Object.entries(item as Record<string, unknown>));
        }
        const entries = Object.entries(source);
        const total = entries.length;
        const first = marker.marks[0];
        const last = marker.marks.length > 1 ? marker.marks[1] : null;
        let result: [string, unknown][];
        if (last === null) {
            if (first === 0) result = [...bodyEntries, ...entries];
            else if (first === -1) result = [...entries, ...bodyEntries];
            else if (first > 0 && first <= total) result = [...entries.slice(0, first - 1), ...bodyEntries, ...entries.slice(first)];
            else return Slicer.#rangeFailure(
                `Position ${first} is out of range; available positions are 1..${total}.`,
                Slicer.#extent(marker, total, "item"),
            );
        } else if (total === 0) {
            // Empty object: only whole-content `<1,-1>` (or `<0,-1>` alias) is
            // valid — replaces the (empty) whole with the body kv-pairs.
            if ((first !== 1 && first !== 0) || last !== -1) return Slicer.#rangeFailure(
                `Range ${first},${last} cannot edit an empty object.`,
                Slicer.#extent(marker, total, "item"),
            );
            result = [...bodyEntries];
        } else {
            let n = first;
            let m = last;
            if (n === 0) n = 1;
            if (m === -1) m = total;
            if (n < 1 || n > total) return Slicer.#rangeFailure(
                `Range start ${first} is out of range; available positions are 1..${total}.`,
                Slicer.#extent(marker, total, "item"),
            );
            if (m < 1 || m > total) return Slicer.#rangeFailure(
                `Range end ${last} is out of range; available positions are 1..${total}.`,
                Slicer.#extent(marker, total, "item"),
            );
            if (n > m) return Slicer.#rangeFailure(
                `Range start ${first} exceeds end ${last}.`,
                Slicer.#extent(marker, total, "item"),
            );
            result = [...entries.slice(0, n - 1), ...bodyEntries, ...entries.slice(m)];
        }
        return { status: 200, result: JSON.stringify(Object.fromEntries(result), null, 2) };
    }

    static #applyJsonScalarEdit(source: unknown, marker: LineMarker, items: unknown[]): EditResult {
        // Scalar source is a length-1 list of itself. Only `<1>` replace
        // works cleanly; grow markers (<0>,<-1>) and ranges that imply
        // growth/delete would require type promotion (scalar → array),
        // which is the kind of implicit magic that bites later. Reject.
        const first = marker.marks[0];
        const last = marker.marks.length > 1 ? marker.marks[1] : null;
        if (last === null && first === 1) {
            if (items.length === 0) return { status: 200, result: "null" };  // delete the scalar
            if (items.length === 1) return { status: 200, result: JSON.stringify(items[0], null, 2) };
            return Slicer.#failure(
                "invalid-edit-body",
                400,
                "A scalar source EDIT at <1> must produce zero or one item; implicit array promotion is forbidden.",
                {},
                {
                    stage: "mutation",
                    recovery: "Provide zero or one replacement item.",
                    retryable: false,
                },
            );
        }
        if (last === -1 && first === 1) {
            // <1,-1> = whole content. Same constraints as <1> for scalars.
            if (items.length === 0) return { status: 200, result: "null" };
            if (items.length === 1) return { status: 200, result: JSON.stringify(items[0], null, 2) };
            return Slicer.#failure(
                "invalid-edit-body",
                400,
                "A scalar source EDIT at <1,-1> must produce zero or one item; implicit array promotion is forbidden.",
                {},
                {
                    stage: "mutation",
                    recovery: "Provide zero or one replacement item.",
                    retryable: false,
                },
            );
        }
        return Slicer.#failure(
            "invalid-edit-range",
            400,
            "A scalar JSON source supports only <1> or <1,-1>; grow markers would require implicit array promotion.",
            {},
            {
                stage: "mutation",
                recovery: "Use <1> or <1,-1> to replace the scalar.",
                retryable: false,
            },
        );
    }

    static jsonItemEdit(content: string, marker: LineMarker, body: string): EditResult {
        let parsed: unknown;
        try { parsed = JSON.parse(content); }
        catch (err) {
            return Slicer.#failure(
                "malformed-json-source",
                400,
                `Malformed JSON source: ${err instanceof Error ? err.message : String(err)}`,
                {},
                {
                    stage: "decode",
                    recovery: "Correct the stored JSON before using structural EDIT.",
                    retryable: false,
                },
            );
        }
        const bodyResult = Slicer.#itemsFromBody(body);
        if ("error" in bodyResult) {
            return Slicer.#failure(
                "malformed-json-body",
                400,
                bodyResult.error,
                {},
                {
                    stage: "decode",
                    recovery: "Provide a valid JSON body.",
                    retryable: false,
                },
            );
        }
        const items = bodyResult.items;
        // Empty-body sentinel insertion is a no-op (model accidentally
        // emitted no items at an insertion point). Single mark <0>/<-1> (#19).
        const isInsertSentinel = marker.marks.length === 1 && (marker.marks[0] === 0 || marker.marks[0] === -1);
        if (items.length === 0 && isInsertSentinel) {
            return { status: 200, result: content };
        }
        if (Array.isArray(parsed)) return Slicer.#applyJsonArrayEdit(parsed, marker, items);
        if (parsed !== null && typeof parsed === "object") return Slicer.#applyJsonObjectEdit(parsed as Record<string, unknown>, marker, items);
        return Slicer.#applyJsonScalarEdit(parsed, marker, items);
    }

    // COPY-style raw line slice. Returns the selected lines verbatim (no line-
    // number prefix), trailing newline appended if any lines were selected.
    // Used for COPY/MOVE `<L>` per the service SPEC (COPY/MOVE source-range, symmetric
    // with READ but without the READ-output prefix that's a render concern,
    // not a data concern).
    static linesRaw(content: string, marker: LineMarker): SliceResult {
        const { lines } = Slicer.#splitLines(content);
        const norm = Slicer.#normalize(marker, lines.length);
        if ("error" in norm) {
            return Slicer.#rangeFailure(norm.error, Slicer.#extent(marker, lines.length, "line"));
        }
        if (norm.kind !== "range") return { status: 200, text: "" };
        const selected = lines.slice(norm.start - 1, norm.end);
        const result = selected.length > 0 ? `${selected.join("\n")}\n` : "";
        return { status: 200, text: result };
    }

    // EDIT applies body at the marker position:
    //   <0>     prepend body before line 1
    //   <-1>    append body after the last line
    //   <N>     replace line N with body
    //   <N,M>   replace lines N..M with body
    //   <N.frac> insert body BETWEEN lines (after line floor(N.frac)); replaces
    //           nothing — empty body is a no-op (#18).
    //   <1,-1>  whole content (replace everything); empty body clears.
    // Empty body with <N>/<N,M> deletes those lines.
    static lineMarkerEdit(content: string, marker: LineMarker, body: string): EditResult {
        const { lines, trailingNewline } = Slicer.#splitLines(content);
        const norm = Slicer.#normalize(marker, lines.length);
        if ("error" in norm) {
            return Slicer.#rangeFailure(norm.error, Slicer.#extent(marker, lines.length, "line"));
        }

        const bodyLines = Slicer.#splitLines(body).lines;
        let newLines: string[];
        if (norm.kind === "before-first") {
            newLines = [...bodyLines, ...lines];
        } else if (norm.kind === "after-last") {
            newLines = [...lines, ...bodyLines];
        } else if (norm.kind === "insert-between") {
            // Insert after line floor(N.frac); both neighbours survive.
            newLines = [...lines.slice(0, norm.start), ...bodyLines, ...lines.slice(norm.start)];
        } else {
            newLines = [...lines.slice(0, norm.start - 1), ...bodyLines, ...lines.slice(norm.end)];
        }
        let result = newLines.join("\n");
        if (newLines.length > 0 && trailingNewline) result += "\n";
        return { status: 200, result };
    }

    static #batchOrder(edits: readonly BatchEdit[], total: number): {
        edits?: BatchEdit[];
        error?: string;
        status?: number;
        range?: RangeExtent;
        extensions?: Readonly<Record<string, unknown>>;
    } {
        if (edits.length === 0) return { edits: [] };
        const regions: Array<{ edit: BatchEdit; start: number; end: number; insertion: boolean; whole: boolean }> = [];
        for (const edit of edits) {
            const norm = Slicer.#normalize(edit.marker, total);
            if ("error" in norm) {
                return {
                    status: 416,
                    error: norm.error,
                    range: Slicer.#extent(edit.marker, total, "line"),
                };
            }
            const insertion = norm.kind !== "range";
            const whole = norm.kind === "range" && norm.start === 1 && norm.end === total;
            regions.push({ edit, start: norm.start, end: norm.end, insertion, whole });
        }
        if (regions.some(({ whole }) => whole) && regions.length > 1) {
            return {
                status: 409,
                error: "A whole-resource replacement cannot coexist with another EDIT.",
                extensions: { editCount: regions.length },
            };
        }
        for (let i = 0; i < regions.length; i += 1) {
            for (let j = i + 1; j < regions.length; j += 1) {
                const a = regions[i];
                const b = regions[j];
                if (a.insertion && b.insertion && a.start === b.start) {
                    return {
                        status: 409,
                        error: `Multiple EDITs target insertion boundary ${a.start}.`,
                        extensions: { insertionBoundary: a.start },
                    };
                }
                if (!a.insertion && !b.insertion && a.start <= b.end && b.start <= a.end) {
                    return {
                        status: 409,
                        error: `EDIT ranges ${a.start},${a.end} and ${b.start},${b.end} overlap.`,
                        extensions: {
                            conflictingRanges: [
                                { first: a.start, last: a.end },
                                { first: b.start, last: b.end },
                            ],
                        },
                    };
                }
                if (a.insertion !== b.insertion) {
                    const insertionRegion = a.insertion ? a : b;
                    const rangeRegion = a.insertion ? b : a;
                    if (insertionRegion.start >= rangeRegion.start && insertionRegion.start < rangeRegion.end) {
                        return {
                            status: 409,
                            error: `EDIT insertion boundary ${insertionRegion.start} falls inside range ${rangeRegion.start},${rangeRegion.end}.`,
                            extensions: {
                                insertionBoundary: insertionRegion.start,
                                conflictingRange: { first: rangeRegion.start, last: rangeRegion.end },
                            },
                        };
                    }
                }
            }
        }
        return {
            edits: regions
                .sort((a, b) => b.start - a.start || Number(a.insertion) - Number(b.insertion))
                .map(({ edit }) => edit),
        };
    }

    static lineMarkerEditBatch(content: string, edits: readonly BatchEdit[]): EditResult {
        const total = Slicer.#splitLines(content).lines.length;
        const ordered = Slicer.#batchOrder(edits, total);
        if (ordered.error !== undefined) {
            const status = ordered.status ?? 409;
            return Slicer.#failure(
                status === 416 ? "range-not-satisfiable" : "overlapping-edits",
                status,
                ordered.error,
                ordered.range === undefined ? {} : { range: ordered.range },
                status === 416
                    ? {
                        ...(ordered.range === undefined ? {} : { range: ordered.range }),
                        stage: "projection",
                        recovery: "Choose a range within the available extent.",
                        retryable: false,
                    }
                    : {
                        stage: "mutation",
                        ...ordered.extensions,
                        recovery: "Submit non-overlapping EDIT ranges.",
                        retryable: false,
                    },
            );
        }
        let result = content;
        for (const edit of ordered.edits ?? []) {
            const applied = Slicer.lineMarkerEdit(result, edit.marker, edit.body);
            if (applied.status !== 200) return applied;
            result = applied.result ?? "";
        }
        return { status: 200, result };
    }

    static jsonItemEditBatch(content: string, edits: readonly BatchEdit[]): EditResult {
        let parsed: unknown;
        try { parsed = JSON.parse(content); }
        catch (err) {
            return Slicer.#failure(
                "malformed-json-source",
                400,
                `Malformed JSON source: ${err instanceof Error ? err.message : String(err)}`,
                {},
                {
                    stage: "decode",
                    recovery: "Correct the stored JSON before using structural EDIT.",
                    retryable: false,
                },
            );
        }
        const total = Slicer.#jsonValueToItems(parsed).length;
        const ordered = Slicer.#batchOrder(edits, total);
        if (ordered.error !== undefined) {
            const status = ordered.status ?? 409;
            return Slicer.#failure(
                status === 416 ? "range-not-satisfiable" : "overlapping-edits",
                status,
                ordered.error,
                ordered.range === undefined ? {} : { range: ordered.range },
                status === 416
                    ? {
                        ...(ordered.range === undefined ? {} : { range: ordered.range }),
                        stage: "projection",
                        recovery: "Choose a range within the available extent.",
                        retryable: false,
                    }
                    : {
                        stage: "mutation",
                        ...ordered.extensions,
                        recovery: "Submit non-overlapping EDIT ranges.",
                        retryable: false,
                    },
            );
        }
        let result = content;
        for (const edit of ordered.edits ?? []) {
            const applied = Slicer.jsonItemEdit(result, edit.marker, edit.body);
            if (applied.status !== 200) return applied;
            result = applied.result ?? "";
        }
        return { status: 200, result };
    }
}
