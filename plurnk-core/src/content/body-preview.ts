import type { LineMarker } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import Knob from "../core/Knob.ts";

// {§body-projection} — one selector for ordinary packet previews and implicit
// text acquisition. Explicit operation scopes never pass through this policy.
export default class BodyPreview {
    // {§markerless-first-page} — the implicit marker of every markerless retrieval. A marker's unit
    // is whatever the projection counts: lines of text, bytes of a byte view, results of a FIND.
    static firstPage(): LineMarker {
        return { marks: [1, Knob.integer("PLURNK_SERVICE_PREVIEW_LINES", 1)] };
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
