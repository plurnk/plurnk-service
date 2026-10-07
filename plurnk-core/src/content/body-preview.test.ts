import test from "node:test";
import assert from "node:assert/strict";
import BodyPreview from "./body-preview.ts";
import ReadResolve from "./read-resolve.ts";

for (const [name, text, maxLines, maxChars, expected] of [
    ["whole text", "a\nb", 2, 3, "a\nb"],
    ["line cap", "a\nb\nc", 2, 100, "b\nc"],
    ["character cap at a line boundary", "abc\ndef\nghi", 10, 7, "def\nghi"],
    ["a final oversized line", "before\n01234🙂7890", 10, 5, "🙂7890"],
    ["one oversized line", "01234🙂7890", 10, 5, "🙂7890"],
    ["CRLF counts once", "before\r\n01234🙂7890\r\n", 10, 6, "🙂7890\r\n"],
    ["a separator at the bound", "oversized\r\n", 10, 1, "\r\n"],
] as const) {
    test(`{§reasoning-row} {§body-projection}: tail preview respects ${name} with a readable source scope`, async () => {
        const original = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = String(maxChars);
        try {
            const tail = BodyPreview.selectTail(text, maxLines);
            assert.equal(text.slice(tail.start), expected);
            assert.equal(tail.whole, expected === text);
            const result = await ReadResolve.resolve({ content: text, mimetype: "text/plain", lineMarker: tail.marker });
            assert.equal(result.status, 200);
            assert.equal(result.content, expected, "the advertised scope retrieves exactly the selected bytes");
            assert.ok([...expected.replaceAll("\r\n", "\n")].length <= maxChars);
        } finally {
            if (original === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
            else process.env.PLURNK_SERVICE_PREVIEW_CHARS = original;
        }
    });
}
