import assert from "node:assert/strict";
import test from "node:test";
import ReadResolve from "./read-resolve.ts";

test("{§body-projection}: markerless READ bounds long result lines before packet rendering", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => JSON.stringify({ index, text: "x".repeat(1900) }));
    const content = lines.join("\n");
    const preview = await ReadResolve.resolve({ content, mimetype: "application/json", lineMarker: null });
    assert.equal(preview.content, lines[0], "ten long JSON records are not a small preview");
    assert.deepEqual(preview.range, { unit: "line", total: 10, requested: [1, 1], returned: [1, 1] });
    const complete = await ReadResolve.resolve({ content, mimetype: "application/json", lineMarker: { marks: [1, -1] } });
    assert.equal(complete.content, content, "an explicit complete READ remains exact");
    const selected = await ReadResolve.resolve({ content, mimetype: "application/json", lineMarker: { marks: [2, 4] } });
    assert.equal(selected.content, lines.slice(1, 4).join("\n"), "explicit lines are not silently cut by preview policy");
});

test("{§body-projection}: a single long line uses the same Unicode character bound and exact region", async () => {
    const content = "😀".repeat(3000);
    const preview = await ReadResolve.resolve({ content, mimetype: "text/plain", lineMarker: null });
    assert.equal(preview.content, "😀".repeat(2560));
    assert.deepEqual(preview.region, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2561 });
    assert.equal(preview.range, undefined, "a partial line is a region, not a falsely complete line range");
});

test("{§body-projection}: markerless READ shares configured line and CRLF character limits", async () => {
    const previous = { lines: process.env.PLURNK_SERVICE_PREVIEW_LINES, chars: process.env.PLURNK_SERVICE_PREVIEW_CHARS };
    process.env.PLURNK_SERVICE_PREVIEW_LINES = "2";
    process.env.PLURNK_SERVICE_PREVIEW_CHARS = "5";
    try {
        const preview = await ReadResolve.resolve({ content: "ab\r\ncdef\r\ngh", mimetype: "text/plain", lineMarker: null });
        assert.equal(preview.content, "ab", "the character cut retreats to the last complete physical line");
        assert.deepEqual(preview.range, { unit: "line", total: 3, requested: [1, 1], returned: [1, 1] });
        const small = await ReadResolve.resolve({ content: "a\nb\nc", mimetype: "text/plain", lineMarker: null });
        assert.equal(small.content, "a\nb", "the configured line bound is shared with ordinary previews");
    } finally {
        if (previous.lines === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES;
        else process.env.PLURNK_SERVICE_PREVIEW_LINES = previous.lines;
        if (previous.chars === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        else process.env.PLURNK_SERVICE_PREVIEW_CHARS = previous.chars;
    }
});
