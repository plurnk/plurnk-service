import test from "node:test";
import assert from "node:assert/strict";
import BodyPreview from "./body-preview.ts";
import ReadResolve from "./read-resolve.ts";

for (const [name, text, maxLines, maxChars, expectedSlice, expectedRead] of [
    ["whole text", "a\nb", 2, 3, "a\nb", "a\nb"],
    ["line cap", "a\nb\nc", 2, 100, "a\nb\n", "a\nb"],
    ["character cap at a line boundary", "abc\ndef\nghi", 10, 8, "abc\ndef\n", "abc\ndef"],
    ["a first oversized line", "01234🙂7890\nafter", 10, 6, "01234🙂", "01234🙂"],
    ["one oversized line", "01234🙂7890", 10, 6, "01234🙂", "01234🙂"],
    ["CRLF counts once", "01234🙂\r\nafter\r\n", 10, 7, "01234🙂\r\n", "01234🙂"],
] as const) {
    test(`{§packet}: first-page preview respects ${name} with a readable source scope`, async () => {
        const originalLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
        const originalChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        process.env.PLURNK_SERVICE_PREVIEW_LINES = String(maxLines);
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = String(maxChars);
        try {
            const selected = BodyPreview.select(text);
            assert.equal(text.slice(0, selected.end), expectedSlice);
            const result = await ReadResolve.resolve({ content: text, mimetype: "text/plain", lineMarker: selected.marker });
            assert.equal(result.status, 200);
            assert.equal(result.content, expectedRead, "the advertised scope retrieves the selected range");
            assert.ok(Array.from(expectedSlice.replaceAll("\r\n", "\n")).length <= maxChars);
        } finally {
            if (originalLines === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES;
            else process.env.PLURNK_SERVICE_PREVIEW_LINES = originalLines;
            if (originalChars === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
            else process.env.PLURNK_SERVICE_PREVIEW_CHARS = originalChars;
        }
    });
}
