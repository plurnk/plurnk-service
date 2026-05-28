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

export interface SliceResult { status: number; text?: string; error?: string }

// READ a line range. Returns selected lines with `N:\t` prefix per
// plurnk.md ("READ output prefixes every line with line numbers, N:\t").
// Sentinel positions <0> and <-1> select no content (they're insertion
// points, not lines) → status 200 with empty text.
export const sliceLines = (content: string, marker: LineMarker): SliceResult => {
    const { lines } = splitLines(content);
    const norm = normalize(marker, lines.length);
    if ("error" in norm) return { status: 416, error: norm.error };
    if (norm.kind !== "range") return { status: 200, text: "" };
    const selected = lines.slice(norm.start - 1, norm.end);
    const numbered = selected.map((line, i) => `${norm.start + i}:\t${line}`).join("\n");
    return { status: 200, text: numbered };
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
