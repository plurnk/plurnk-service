import type { MatcherBody, TextRegion } from "@plurnk/plurnk-contracts";
import type { MatchEvidence } from "@plurnk/plurnk-schemes";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { assertEditBatchReceipt, projectEditReceipt } from "./edit-receipt.ts";
import type { DispatchResult } from "../core/mutation-types.ts";
import LineMarkerOps from "./line-marker.ts";

// {§edit-pattern} {§kill-pattern} — a matcher's evidence over one resource becomes a batch of
// ordinary coordinate edits, all relative to the same original content, so the existing batch
// machinery (merges, compare-and-swap on touched lines, receipts) does the work.
export type PatternEdit = { readonly marker: { readonly marks: [number] | [number, number, number, number] }; readonly body: string };

export default class PatternEdits {
    // {§read-pattern} Anchors refer to source lines; matches may still span lines.
    static lineAnchored(matcher: MatcherBody): MatcherBody {
        if (matcher.dialect !== "regex" || matcher.flags.includes("m")) return matcher;
        return { ...matcher, flags: `${matcher.flags}m` };
    }

    // The whole lines a matcher's evidence touches, in source order, within an inclusive line bound.
    static lines(evidence: ReadonlyArray<MatchEvidence>, bounds: { from: number; to: number } | null): number[] {
        const lines = new Set<number>();
        for (const item of evidence) {
            const region = item.region ?? item.enclosingRegion;
            if (region === undefined) continue;
            const last = region.endLine - (region.endLine > region.startLine && region.endColumn === 1 ? 1 : 0);
            for (let line = region.startLine; line <= last; line += 1) {
                if (bounds !== null && (line < bounds.from || line > bounds.to)) continue;
                lines.add(line);
            }
        }
        return [...lines].sort((a, b) => a - b);
    }

    // {§read-pattern-evidence} — presentation may clip a match, but cannot redefine it.
    static visible(evidence: readonly MatchEvidence[], lines: readonly number[], window?: TextRegion): MatchEvidence[] {
        const shown = new Set(lines);
        const compare = (line: number, column: number, otherLine: number, otherColumn: number): number => line - otherLine || column - otherColumn;
        return evidence.filter((item) => {
            const region = item.region ?? item.enclosingRegion;
            if (region === undefined || !PatternEdits.lines([item], null).some((line) => shown.has(line))) return false;
            if (window === undefined) return true;
            const startsBeforeEnd = compare(region.startLine, region.startColumn, window.endLine, window.endColumn) < 0;
            const endsAfterStart = compare(region.endLine, region.endColumn, window.startLine, window.startColumn) > 0;
            const point = region.startLine === region.endLine && region.startColumn === region.endColumn;
            return point
                ? compare(region.startLine, region.startColumn, window.startLine, window.startColumn) >= 0
                    && compare(region.startLine, region.startColumn, window.endLine, window.endColumn) <= 0
                : startsBeforeEnd && endsAfterStart;
        });
    }

    // {§slice-semantics-compose-pattern} Selection consumes evidence; it never matches again.
    static spans(evidence: readonly MatchEvidence[], bounds: TextRegion | null): TextRegion[] {
        const compare = (line: number, column: number, otherLine: number, otherColumn: number): number => line - otherLine || column - otherColumn;
        return evidence.flatMap(({ region }) => region === undefined ? [] : [region])
            .filter((region) => bounds === null || (
                compare(region.startLine, region.startColumn, bounds.startLine, bounds.startColumn) >= 0
                && compare(region.endLine, region.endColumn, bounds.endLine, bounds.endColumn) <= 0
            ))
            .toSorted((left, right) => compare(left.startLine, left.startColumn, right.startLine, right.startColumn)
                || compare(left.endLine, left.endColumn, right.endLine, right.endColumn));
    }

    static replacements(spans: readonly TextRegion[], body: string): PatternEdit[] {
        return spans.map(({ startLine, startColumn, endLine, endColumn }) => ({ marker: { marks: [startLine, startColumn, endLine, endColumn] as [number, number, number, number] }, body }));
    }

    static text(content: string, spans: readonly TextRegion[]): string {
        const coordinates = new TextCoordinates(content);
        return spans.map(({ startLine, startColumn, endLine, endColumn }) => content.slice(
            coordinates.offsetAtPosition(startLine, startColumn),
            coordinates.offsetAtPosition(endLine, endColumn),
        )).join("");
    }

    // Every line an edit's marker covers: the one line of a line deletion, or a region's span.
    static touchedLines(edits: readonly PatternEdit[]): number[] {
        return PatternEdits.lines(edits.map(({ marker: { marks } }) => ({ region: {
            startLine: marks[0], startColumn: marks[1] ?? 1,
            endLine: marks[2] ?? marks[0], endColumn: marks[3] ?? 1,
        } })), null);
    }

    // {§slice-semantics-compose-pattern} Resolve scopes through the existing text algebra.
    static bounds(marks: readonly number[] | undefined, content: string): TextRegion | null | { readonly error: string } {
        if (marks === undefined || marks.length === 0) return null;
        if (marks.length === 1 && marks[0]! <= 0) return { error: "A pattern scope selects source text, not a prepend or append position." };
        const selected = LineMarkerOps.textReplacement(content, { marks: [marks[0]!, ...marks.slice(1)] }, "");
        if ("error" in selected) return selected;
        const region = TextCoordinates.regionFromOffsets(content, selected.start, selected.end);
        if (region === null) throw new Error("A resolved text scope has no source coordinates.");
        return region;
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
