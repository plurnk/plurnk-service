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

const splitLines = (content: string): { lines: string[]; trailingNewline: boolean } => {
    const trailingNewline = content.endsWith("\n");
    if (content === "") return { lines: [], trailingNewline: false };
    const lines = content.split("\n");
    if (trailingNewline) lines.pop();
    return { lines, trailingNewline };
};

const normalize = (marker: LineMarker, totalLines: number): NormalizedMarker | { error: string } => {
    const { first, last } = marker;
    if (last === null) {
        if (first === 0) return { kind: "before-first", start: 0, end: 0 };
        if (first === -1) return { kind: "after-last", start: 0, end: 0 };
        if (first > 0 && first <= totalLines) return { kind: "range", start: first, end: first };
        return { error: `line ${first} out of range (1..${totalLines})` };
    }
    let n = first;
    let m = last;
    if (n === 0) n = 1;
    if (m === -1) m = totalLines;
    if (n < 1 || n > totalLines) return { error: `range start ${first} out of range (1..${totalLines})` };
    if (m < 1 || m > totalLines) return { error: `range end ${last} out of range (1..${totalLines})` };
    if (n > m) return { error: `range start ${first} > end ${last}` };
    return { kind: "range", start: n, end: m };
};

export interface SliceResult { status: number; text?: string; startLine?: number; error?: string }

// READ a line range. Returns the raw selected lines (no `N:\t` prefix)
// plus the 1-indexed position of the first selected line. The render
// layer adds `N:\t` per plurnk.md ("READ output prefixes every line with
// line numbers, N:\t") starting from `startLine` — keeps numbering as a
// presentation concern, prevents double-prefixing when the same content
// passes through the log render.
//
// Sentinel positions <0> and <-1> select no content (they're insertion
// points, not lines) → status 200 with empty text.
export const sliceLines = (content: string, marker: LineMarker): SliceResult => {
    const { lines } = splitLines(content);
    const norm = normalize(marker, lines.length);
    if ("error" in norm) return { status: 416, error: norm.error };
    if (norm.kind !== "range") return { status: 200, text: "", startLine: undefined };
    const selected = lines.slice(norm.start - 1, norm.end);
    return { status: 200, text: selected.join("\n"), startLine: norm.start };
};

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

const jsonValueToItems = (parsed: unknown): unknown[] => {
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === "object") {
        // Object items are single-key {key: value} wrappers, in insertion
        // order. Object.entries preserves spec-guaranteed iteration order
        // for string keys.
        return Object.entries(parsed).map(([k, v]) => ({ [k]: v }));
    }
    // Scalar (string, number, boolean, null): a length-1 list of itself.
    return [parsed];
};

export interface JsonSliceResult { status: number; body?: string; error?: string }

export const sliceJsonItems = (content: string, marker: LineMarker): JsonSliceResult => {
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch (err) { return { status: 400, error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}` }; }
    const items = jsonValueToItems(parsed);
    const total = items.length;
    const { first, last } = marker;
    if (last === null) {
        if (first === 0 || first === -1) return { status: 200, body: "[]" };
        if (first > 0 && first <= total) return { status: 200, body: JSON.stringify([items[first - 1]], null, 2) };
        return { status: 416, error: `item ${first} out of range (1..${total})` };
    }
    let n = first;
    let m = last;
    if (n === 0) n = 1;
    if (m === -1) m = total;
    if (n < 1 || n > total) return { status: 416, error: `range start ${first} out of range (1..${total})` };
    if (m < 1 || m > total) return { status: 416, error: `range end ${last} out of range (1..${total})` };
    if (n > m) return { status: 416, error: `range start ${first} > end ${last}` };
    return { status: 200, body: JSON.stringify(items.slice(n - 1, m), null, 2) };
};

// COPY-style raw line slice. Returns the selected lines verbatim (no line-
// number prefix), trailing newline appended if any lines were selected.
// Used for COPY/MOVE `<L>` per AGENTS.md "Resolved ambiguities" §4
// (source range, symmetric with READ but without the READ-output prefix
// that's a render concern, not a data concern).
export const sliceLinesRaw = (content: string, marker: LineMarker): SliceResult => {
    const { lines } = splitLines(content);
    const norm = normalize(marker, lines.length);
    if ("error" in norm) return { status: 416, error: norm.error };
    if (norm.kind !== "range") return { status: 200, text: "" };
    const selected = lines.slice(norm.start - 1, norm.end);
    const result = selected.length > 0 ? `${selected.join("\n")}\n` : "";
    return { status: 200, text: result };
};

export interface EditResult { status: number; result?: string; error?: string }

// EDIT applies body at the marker position:
//   <0>     prepend body before line 1
//   <-1>    append body after the last line
//   <N>     replace line N with body
//   <N,M>   replace lines N..M with body
//   <1,-1>  whole content (replace everything); empty body clears.
// Empty body with <N>/<N,M> deletes those lines.
export const applyLineMarkerEdit = (content: string, marker: LineMarker, body: string): EditResult => {
    const { lines, trailingNewline } = splitLines(content);
    const norm = normalize(marker, lines.length);
    if ("error" in norm) return { status: 416, error: norm.error };

    const bodyLines = splitLines(body).lines;
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
};
