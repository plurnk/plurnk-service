import type { MatcherBody } from "@plurnk/plurnk-contracts";
import type { MatchEvidence } from "@plurnk/plurnk-schemes";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { TEXT_PRIMITIVE_MIMETYPE } from "@plurnk/plurnk-schemes";
import { assertEditBatchReceipt, projectEditReceipt } from "./edit-receipt.ts";
import type { DispatchResult } from "../core/mutation-types.ts";

// {§edit-pattern} {§kill-pattern} — a matcher's evidence over one resource becomes a batch of
// ordinary coordinate edits, all relative to the same original content, so the existing batch
// machinery (merges, compare-and-swap on touched lines, receipts) does the work. EDIT replaces
// each span within its line with the literal body; KILL, COPY and MOVE work in whole lines.
// Matching is line-limited: a span never crosses a line.
export type PatternEdit = { readonly marker: { readonly marks: [number] | [number, number, number, number] }; readonly body: string };

export type PatternSpan = { readonly line: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number };

export default class PatternEdits {
    // A pattern operation addresses source coordinates, so a regex or glob runs over the source
    // text itself — the lines a READ renders and an EDIT splices — never a handler's readable
    // projection (HTML's Markdown, a notebook's cells), whose lines are not the source's. Node
    // dialects need the channel's handler to find their nodes.
    static matchMimetype(matcher: MatcherBody, channelMimetype: string): string {
        return matcher.dialect === "regex" || matcher.dialect === "glob" ? TEXT_PRIMITIVE_MIMETYPE : channelMimetype;
    }

    // A pattern operation works line by line, so a regex anchors each line: `^` and `$` mean the
    // line's ends, as they do in a FIND over one line.
    static lineLimited(matcher: MatcherBody): MatcherBody {
        if (matcher.dialect !== "regex" || matcher.flags.includes("m")) return matcher;
        return { ...matcher, flags: `${matcher.flags}m` };
    }

    // The whole lines a matcher's evidence touches, in source order, within an inclusive line bound.
    static lines(evidence: ReadonlyArray<MatchEvidence>, bounds: { from: number; to: number } | null): number[] {
        const lines = new Set<number>();
        for (const item of evidence) {
            if (item.region === undefined) continue;
            for (let line = item.region.startLine; line <= item.region.endLine; line += 1) {
                if (bounds !== null && (line < bounds.from || line > bounds.to)) continue;
                lines.add(line);
            }
        }
        return [...lines].sort((a, b) => a - b);
    }

    // Column-exact spans for a replacement. A regex's evidence already carries its span, limited
    // to one line; a node dialect's evidence is the node's whole region, however many lines it
    // spans; a glob with no metacharacters is a literal whose occurrences on each matched line are
    // the spans; a glob with metacharacters selects whole lines, so its span is the whole line.
    static spans(matcher: MatcherBody, content: string, evidence: ReadonlyArray<MatchEvidence>, bounds: { from: number; to: number } | null): PatternSpan[] | { readonly error: string } {
        const spans: PatternSpan[] = [];
        const within = (line: number): boolean => bounds === null || (line >= bounds.from && line <= bounds.to);
        if (matcher.dialect === "regex" || matcher.dialect === "xpath" || matcher.dialect === "jsonpath") {
            for (const item of evidence) {
                const region = item.region;
                if (region === undefined) continue;
                if (matcher.dialect === "regex" && region.startLine !== region.endLine) return { error: "EDIT spans are line-limited; the pattern matched across a line break." };
                if (!within(region.startLine) || !within(region.endLine)) continue;
                spans.push({ line: region.startLine, startColumn: region.startColumn, endLine: region.endLine, endColumn: region.endColumn });
            }
        } else if (matcher.dialect === "glob") {
            const literal = !/[*?[]/u.test(matcher.raw);
            const lines = TextCoordinates.logicalLines(content);
            for (const line of PatternEdits.lines(evidence, bounds)) {
                const text = lines[line - 1] === undefined ? "" : content.slice(lines[line - 1]!.start, lines[line - 1]!.contentEnd);
                const points = [...text];
                if (!literal) {
                    spans.push({ line, startColumn: 1, endLine: line, endColumn: points.length + 1 });
                    continue;
                }
                const needle = [...matcher.raw];
                for (let at = 0; at + needle.length <= points.length; at += 1) {
                    if (needle.every((point, index) => points[at + index] === point)) {
                        spans.push({ line, startColumn: at + 1, endLine: line, endColumn: at + needle.length + 1 });
                        at += needle.length - 1;
                    }
                }
            }
        } else {
            return { error: `EDIT replaces text spans; a ${matcher.dialect} pattern selects resources, not spans.` };
        }
        return spans.sort((a, b) => a.line - b.line || a.startColumn - b.startColumn);
    }

    static replacements(spans: readonly PatternSpan[], body: string): PatternEdit[] {
        return spans.map(({ line, startColumn, endLine, endColumn }) => ({ marker: { marks: [line, startColumn, endLine, endColumn] as [number, number, number, number] }, body }));
    }

    // Every line an edit's marker covers: the one line of a line deletion, or a region's span.
    static touchedLines(edits: readonly PatternEdit[]): number[] {
        const lines = new Set<number>();
        for (const { marker } of edits) {
            const [start, , end] = marker.marks;
            for (let line = start; line <= (end ?? start); line += 1) lines.add(line);
        }
        return [...lines].sort((a, b) => a - b);
    }

    static deletions(lines: readonly number[]): PatternEdit[] {
        return lines.map((line) => ({ marker: { marks: [line] as [number] }, body: "" }));
    }

    // A numeric scope on a pattern operation bounds the lines it may touch. Sentinels that mean
    // prepend or append have no lines to match.
    static bounds(marks: readonly number[] | undefined, lineCount: number): { from: number; to: number } | null | { readonly error: string } {
        if (marks === undefined || marks.length === 0) return null;
        const clamp = (mark: number): number => mark === -1 ? lineCount : mark;
        if (marks.length === 1) {
            if (marks[0]! <= 0) return { error: "A pattern needs a line to match; <0> and <-1> name a position, not a line." };
            return { from: marks[0]!, to: marks[0]! };
        }
        if (marks.length === 2) {
            const from = marks[0]!; const to = clamp(marks[1]!);
            if (from <= 0 || to < from) return { error: "A pattern needs an inclusive line range; <0> and <-1> name a position, not a line." };
            return { from, to };
        }
        if (marks.length === 4) return { from: marks[0]!, to: marks[2]! };
        return { error: "A pattern scope is one line, an inclusive line range, or a four-coordinate region." };
    }

    // The landed batch as one operation result: `matched` spans, the first span's receipt, and
    // the last span's effect as `last` when there is more than one.
    static compactReceipt(result: DispatchResult, matched: number): DispatchResult {
        const { editReceipt, merges: _merges, applied: _applied, ...fields } = result as DispatchResult & { merges?: unknown; applied?: unknown };
        if (editReceipt === undefined || editReceipt === null) return { ...fields, matched };
        const receipt = assertEditBatchReceipt(editReceipt);
        const count = "disposition" in receipt ? receipt.superseded.length : receipt.effects.length;
        if (count === 0) return { ...fields, matched };
        const first = projectEditReceipt(receipt, 0);
        const last = count > 1 && !("disposition" in receipt) ? receipt.effects[count - 1] : undefined;
        return { ...fields, matched, receipt: first, ...(last === undefined ? {} : { last }) };
    }
}
