// `<L>` line-marker semantics (plurnk.md §`<L>`):
//
//   <N>      selects position N (1-indexed)
//   <N,M>    selects positions N..M inclusive
//   <0>      sentinel: before position 1 (EDIT prepend)
//   <-1>     sentinel: after the last position (EDIT append)
//   <1,-1>   every position (in range context, -1 normalizes to last line)
//
// "N and M are signed integers" — but plurnk.md only documents <0> and
// <-1> as defined sentinels. Other negatives (<-2>, <-3>) are not
// specified and rejected as 416. Within a range, -1 as the M endpoint
// means "include through the last line" (so <1,-1> is whole content).

import type { LineMarker } from "@plurnk/plurnk-grammar";

interface NormalizedMarker {
    kind: "range" | "before-first" | "after-last";
    start: number;
    end: number;
}

export interface SliceResult { status: number; text?: string; startLine?: number; error?: string }
export interface JsonSliceResult { status: number; body?: string; error?: string }
export interface EditResult { status: number; result?: string; error?: string }

export default class Slicer {
    static #splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
        const trailingNewline = content.endsWith("\n");
        if (content === "") return { lines: [], trailingNewline: false };
        const lines = content.split("\n");
        if (trailingNewline) lines.pop();
        return { lines, trailingNewline };
    }

    static #normalize(marker: LineMarker, totalLines: number): NormalizedMarker | { error: string } {
        const { first, last } = marker;
        if (last === null) {
            if (first === 0) return { kind: "before-first", start: 0, end: 0 };
            if (first === -1) return { kind: "after-last", start: 0, end: 0 };
            if (first > 0 && first <= totalLines) return { kind: "range", start: first, end: first };
            return { error: `line ${first} out of range (1..${totalLines})` };
        }
        // Whole-content `<1,-1>` (and its `<0,-1>` alias) is valid even on
        // empty content — it selects the entire, possibly-empty range. Without
        // this, an EDIT that replaces-everything on a freshly-created empty
        // entry would 416. start>end here yields an empty slice for READ and a
        // full replacement for EDIT.
        if (totalLines === 0) {
            if ((first === 0 || first === 1) && last === -1) return { kind: "range", start: 1, end: 0 };
            return { error: `range ${first},${last} out of range (content is empty)` };
        }
        let n = first;
        let m = last;
        if (n === 0) n = 1;
        if (m === -1) m = totalLines;
        if (n < 1 || n > totalLines) return { error: `range start ${first} out of range (1..${totalLines})` };
        if (m < 1 || m > totalLines) return { error: `range end ${last} out of range (1..${totalLines})` };
        if (n > m) return { error: `range start ${first} > end ${last}` };
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
        if ("error" in norm) return { status: 416, error: norm.error };
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
        catch (err) { return { status: 400, error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}` }; }
        const items = Slicer.#jsonValueToItems(parsed);
        const total = items.length;
        const { first, last } = marker;
        if (last === null) {
            if (first === 0 || first === -1) return { status: 200, body: "[]" };
            if (first > 0 && first <= total) return { status: 200, body: JSON.stringify([items[first - 1]], null, 2) };
            return { status: 416, error: `item ${first} out of range (1..${total})` };
        }
        // Whole-content `<1,-1>` is valid on an empty item list — it selects
        // the entire, empty range (mirrors #normalize's empty-content rule).
        if (total === 0) {
            if ((first === 0 || first === 1) && last === -1) return { status: 200, body: "[]" };
            return { status: 416, error: `range ${first},${last} out of range (no items)` };
        }
        let n = first;
        let m = last;
        if (n === 0) n = 1;
        if (m === -1) m = total;
        if (n < 1 || n > total) return { status: 416, error: `range start ${first} out of range (1..${total})` };
        if (m < 1 || m > total) return { status: 416, error: `range end ${last} out of range (1..${total})` };
        if (n > m) return { status: 416, error: `range start ${first} > end ${last}` };
        return { status: 200, body: JSON.stringify(items.slice(n - 1, m), null, 2) };
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
        const { first, last } = marker;
        let result: unknown[];
        if (last === null) {
            if (first === 0) result = [...items, ...source];
            else if (first === -1) result = [...source, ...items];
            else if (first > 0 && first <= total) result = [...source.slice(0, first - 1), ...items, ...source.slice(first)];
            else return { status: 416, error: `position ${first} out of range (1..${total})` };
        } else if (total === 0) {
            // Empty array: only whole-content `<1,-1>` (or `<0,-1>` alias) is
            // valid — it replaces the (empty) whole with the body items. Any
            // other range on an empty array is out of range.
            if ((first !== 1 && first !== 0) || last !== -1) return { status: 416, error: `range on empty array` };
            result = [...items];
        } else {
            let n = first;
            let m = last;
            if (n === 0) n = 1;
            if (m === -1) m = total;
            if (n < 1 || n > total) return { status: 416, error: `range start ${first} out of range (1..${total})` };
            if (m < 1 || m > total) return { status: 416, error: `range end ${last} out of range (1..${total})` };
            if (n > m) return { status: 416, error: `range start ${first} > end ${last}` };
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
                return { status: 400, error: "object source requires body items to be JSON objects (key-value pairs)" };
            }
            bodyEntries.push(...Object.entries(item as Record<string, unknown>));
        }
        const entries = Object.entries(source);
        const total = entries.length;
        const { first, last } = marker;
        let result: [string, unknown][];
        if (last === null) {
            if (first === 0) result = [...bodyEntries, ...entries];
            else if (first === -1) result = [...entries, ...bodyEntries];
            else if (first > 0 && first <= total) result = [...entries.slice(0, first - 1), ...bodyEntries, ...entries.slice(first)];
            else return { status: 416, error: `position ${first} out of range (1..${total})` };
        } else if (total === 0) {
            // Empty object: only whole-content `<1,-1>` (or `<0,-1>` alias) is
            // valid — replaces the (empty) whole with the body kv-pairs.
            if ((first !== 1 && first !== 0) || last !== -1) return { status: 416, error: `range on empty object` };
            result = [...bodyEntries];
        } else {
            let n = first;
            let m = last;
            if (n === 0) n = 1;
            if (m === -1) m = total;
            if (n < 1 || n > total) return { status: 416, error: `range start ${first} out of range (1..${total})` };
            if (m < 1 || m > total) return { status: 416, error: `range end ${last} out of range (1..${total})` };
            if (n > m) return { status: 416, error: `range start ${first} > end ${last}` };
            result = [...entries.slice(0, n - 1), ...bodyEntries, ...entries.slice(m)];
        }
        return { status: 200, result: JSON.stringify(Object.fromEntries(result), null, 2) };
    }

    static #applyJsonScalarEdit(source: unknown, marker: LineMarker, items: unknown[]): EditResult {
        // Scalar source is a length-1 list of itself. Only `<1>` replace
        // works cleanly; grow markers (<0>,<-1>) and ranges that imply
        // growth/delete would require type promotion (scalar → array),
        // which is the kind of implicit magic that bites later. Reject.
        const { first, last } = marker;
        if (last === null && first === 1) {
            if (items.length === 0) return { status: 200, result: "null" };  // delete the scalar
            if (items.length === 1) return { status: 200, result: JSON.stringify(items[0], null, 2) };
            return { status: 400, error: "scalar source: <1> body must produce 0 or 1 items (no implicit promotion to array)" };
        }
        if (last === -1 && first === 1) {
            // <1,-1> = whole content. Same constraints as <1> for scalars.
            if (items.length === 0) return { status: 200, result: "null" };
            if (items.length === 1) return { status: 200, result: JSON.stringify(items[0], null, 2) };
            return { status: 400, error: "scalar source: <1,-1> body must produce 0 or 1 items (no implicit promotion to array)" };
        }
        return { status: 400, error: "scalar JSON source: only <1> or <1,-1> markers supported (no implicit promotion to array via grow markers)" };
    }

    static jsonItemEdit(content: string, marker: LineMarker, body: string): EditResult {
        let parsed: unknown;
        try { parsed = JSON.parse(content); }
        catch (err) { return { status: 400, error: `malformed JSON source: ${err instanceof Error ? err.message : String(err)}` }; }
        const bodyResult = Slicer.#itemsFromBody(body);
        if ("error" in bodyResult) return { status: 400, error: bodyResult.error };
        const items = bodyResult.items;
        // Empty-body sentinel insertion is a no-op (model accidentally
        // emitted no items at an insertion point).
        if (items.length === 0 && marker.last === null && (marker.first === 0 || marker.first === -1)) {
            return { status: 200, result: content };
        }
        if (Array.isArray(parsed)) return Slicer.#applyJsonArrayEdit(parsed, marker, items);
        if (parsed !== null && typeof parsed === "object") return Slicer.#applyJsonObjectEdit(parsed as Record<string, unknown>, marker, items);
        return Slicer.#applyJsonScalarEdit(parsed, marker, items);
    }

    // COPY-style raw line slice. Returns the selected lines verbatim (no line-
    // number prefix), trailing newline appended if any lines were selected.
    // Used for COPY/MOVE `<L>` per SPEC.md §16.9 (source range, symmetric
    // with READ but without the READ-output prefix that's a render concern,
    // not a data concern).
    static linesRaw(content: string, marker: LineMarker): SliceResult {
        const { lines } = Slicer.#splitLines(content);
        const norm = Slicer.#normalize(marker, lines.length);
        if ("error" in norm) return { status: 416, error: norm.error };
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
    //   <1,-1>  whole content (replace everything); empty body clears.
    // Empty body with <N>/<N,M> deletes those lines.
    static lineMarkerEdit(content: string, marker: LineMarker, body: string): EditResult {
        const { lines, trailingNewline } = Slicer.#splitLines(content);
        const norm = Slicer.#normalize(marker, lines.length);
        if ("error" in norm) return { status: 416, error: norm.error };

        const bodyLines = Slicer.#splitLines(body).lines;
        let newLines: string[];
        if (norm.kind === "before-first") {
            newLines = [...bodyLines, ...lines];
        } else if (norm.kind === "after-last") {
            newLines = [...lines, ...bodyLines];
        } else {
            newLines = [...lines.slice(0, norm.start - 1), ...bodyLines, ...lines.slice(norm.end)];
        }
        let result = newLines.join("\n");
        if (newLines.length > 0 && trailingNewline) result += "\n";
        return { status: 200, result };
    }
}
