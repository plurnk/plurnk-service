import type { LineMarker } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { Knob } from "@plurnk/plurnk-meta";

// {§packet} — one selector for ordinary packet previews and implicit
// text acquisition. Explicit operation scopes never pass through this policy.
export default class BodyPreview {
    // Structured previews keep complete items under the same line/character allowance.
    static items<T>(items: readonly T[], render: (item: T) => string): T[] {
        const text = items.map(render).join("\n");
        const { end } = BodyPreview.select(text);
        const complete = TextCoordinates.logicalLines(text).filter((line) => line.contentEnd <= end).length;
        return items.slice(0, complete);
    }

    // {§packet} — the implicit marker of every markerless retrieval. A marker's unit
    // is whatever the projection counts: lines of text, bytes of a byte view, results of a FIND.
    static firstPage(): LineMarker {
        return { marks: [1, Knob.integer("PLURNK_SERVICE_PREVIEW_LINES", 1)] };
    }

    static select(text: string): { end: number; marker: LineMarker } {
        const maxLines = Knob.integer("PLURNK_SERVICE_PREVIEW_LINES", 1);
        const maxChars = Knob.integer("PLURNK_SERVICE_PREVIEW_CHARS", 1);
        const coordinates = new TextCoordinates(text);
        const lines = coordinates.logicalLines();
        const lineEnd = lines.length > maxLines ? lines[maxLines - 1].end : text.length;
        let characterEnd = 0;
        for (let consumed = 0; characterEnd < text.length && consumed < maxChars; consumed++) {
            // A CRLF is one indivisible separator, a Unicode code point one character.
            characterEnd += text.startsWith("\r\n", characterEnd)
                ? 2
                : String.fromCodePoint(text.codePointAt(characterEnd)!).length;
        }
        if (characterEnd < text.length && characterEnd <= lineEnd) {
            const completeLine = lines.findLastIndex((line) => line.separator.length > 0 && line.end <= characterEnd);
            if (completeLine !== -1) {
                return { end: lines[completeLine].end, marker: { marks: [1, completeLine + 1] } };
            }
            const region = coordinates.regionFromOffsets(0, characterEnd);
            if (region === null) throw new Error("An automatic text preview must have an addressable region.");
            return { end: characterEnd, marker: { marks: [region.startLine, region.startColumn, region.endLine, region.endColumn] } };
        }
        return { end: lineEnd, marker: { marks: [1, maxLines] } };
    }

    // {§packet} {§exec-stream} — trailing page for concluded stream observations, bounded by the
    // same `PLURNK_SERVICE_PREVIEW_LINES` and `PLURNK_SERVICE_PREVIEW_CHARS` envelope as `select`.
    static tail(text: string): { start: number; marker: LineMarker } {
        const maxLines = Knob.integer("PLURNK_SERVICE_PREVIEW_LINES", 1);
        const maxChars = Knob.integer("PLURNK_SERVICE_PREVIEW_CHARS", 1);
        const coordinates = new TextCoordinates(text);
        const lines = coordinates.logicalLines();
        if (lines.length === 0) {
            return { start: 0, marker: { marks: [1, maxLines] } };
        }
        const lineStartIdx = Math.max(0, lines.length - maxLines);
        const lineStart = lines[lineStartIdx].start;
        const stepBack = (offset: number): number => {
            if (offset >= 2 && text.slice(offset - 2, offset) === "\r\n") return offset - 2;
            const low = text.charCodeAt(offset - 1);
            const high = offset >= 2 ? text.charCodeAt(offset - 2) : 0;
            return offset - (low >= 0xDC00 && low <= 0xDFFF && high >= 0xD800 && high <= 0xDBFF ? 2 : 1);
        };
        let characterStart = text.length;
        for (let consumed = 0; characterStart > 0 && consumed < maxChars; consumed++) {
            characterStart = stepBack(characterStart);
        }
        if (characterStart > 0 && characterStart > lineStart) {
            const completeLine = lines.findIndex((line, idx) => idx >= lineStartIdx && line.start >= characterStart);
            if (completeLine !== -1) {
                return { start: lines[completeLine].start, marker: { marks: [completeLine + 1, lines.length] } };
            }
            const lastLine = lines[lines.length - 1];
            let regionStart = lastLine.contentEnd;
            for (let consumed = 0; regionStart > lastLine.start && consumed < maxChars; consumed++) {
                regionStart = stepBack(regionStart);
            }
            const region = coordinates.regionFromOffsets(regionStart, lastLine.contentEnd);
            if (region === null) throw new Error("An automatic text preview must have an addressable region.");
            return { start: regionStart, marker: { marks: [region.startLine, region.startColumn, region.endLine, region.endColumn] } };
        }
        if (lineStartIdx === 0) {
            return { start: 0, marker: { marks: [1, maxLines] } };
        }
        return { start: lineStart, marker: { marks: [lineStartIdx + 1, lines.length] } };
    }
}
