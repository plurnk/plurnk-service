import type { LineMarker } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";

// {§body-projection} — one selector for ordinary packet previews and implicit
// text acquisition. Explicit operation scopes never pass through this policy.
export default class BodyPreview {
    static select(text: string): { end: number; marker: LineMarker } {
        const rawLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
        const rawChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        const maxLines = Number(rawLines);
        const maxChars = Number(rawChars);
        if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
            throw new Error(`PLURNK_SERVICE_PREVIEW_LINES must be a positive safe integer, got ${JSON.stringify(rawLines)}`);
        }
        if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
            throw new Error(`PLURNK_SERVICE_PREVIEW_CHARS must be a positive safe integer, got ${JSON.stringify(rawChars)}`);
        }
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
