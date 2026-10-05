import type { LineMarker } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { Knob } from "@plurnk/plurnk-meta";

// {§body-projection} — one selector for ordinary packet previews and implicit
// text acquisition. Explicit operation scopes never pass through this policy.
export default class BodyPreview {
    // Structured previews keep complete items under the same line/character allowance.
    static items<T>(items: readonly T[], render: (item: T) => string): T[] {
        const text = items.map(render).join("\n");
        const { end } = BodyPreview.select(text);
        const complete = TextCoordinates.logicalLines(text).filter((line) => line.contentEnd <= end).length;
        return items.slice(0, complete);
    }

    // {§markerless-first-page} — the implicit marker of every markerless retrieval. A marker's unit
    // is whatever the projection counts: lines of text, bytes of a byte view, results of a FIND.
    static firstPage(): LineMarker {
        return { marks: [1, Knob.integer("PLURNK_SERVICE_PREVIEW_LINES", 1)] };
    }

    // {§reasoning-row} — the last page of a text whose conclusions sit at its end: the final `maxLines` logical
    // lines, trimmed from the front to the shared character bound on a line boundary. `whole` says the text fits
    // the page as it stands, in which case `start` is 0 and the marker covers every line.
    static selectTail(text: string, maxLines: number): { start: number; marker: LineMarker; whole: boolean } {
        const maxChars = Knob.integer("PLURNK_SERVICE_PREVIEW_CHARS", 1);
        const lines = new TextCoordinates(text).logicalLines();
        if (lines.length === 0) return { start: 0, marker: { marks: [1, -1] }, whole: true };
        // Code points, a CRLF counted as one separator — the same unit as the first page.
        const points = (from: number): number => Array.from(text.slice(from).replaceAll("\r\n", "\n")).length;
        let first = Math.max(0, lines.length - maxLines);
        while (first < lines.length - 1 && points(lines[first]!.start) > maxChars) first++;
        const whole = first === 0 && points(0) <= maxChars;
        return { start: lines[first]!.start, marker: { marks: [first + 1, lines.length] }, whole };
    }

    static select(text: string): { end: number; marker: LineMarker } {
        const maxLines = Knob.integer("PLURNK_SERVICE_PREVIEW_LINES", 1);
        const maxChars = Knob.integer("PLURNK_SERVICE_PREVIEW_CHARS", 1);
        const coordinates = new TextCoordinates(text);
        const lines = coordinates.logicalLines();
        const lineEnd = lines.length > maxLines ? lines[maxLines - 1]!.end : text.length;
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
                return { end: lines[completeLine]!.end, marker: { marks: [1, completeLine + 1] } };
            }
            const region = coordinates.regionFromOffsets(0, characterEnd);
            if (region === null) throw new Error("An automatic text preview must have an addressable region.");
            return { end: characterEnd, marker: { marks: [region.startLine, region.startColumn, region.endLine, region.endColumn] } };
        }
        return { end: lineEnd, marker: { marks: [1, maxLines] } };
    }
}
