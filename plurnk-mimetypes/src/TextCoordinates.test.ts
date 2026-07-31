import assert from "node:assert/strict";
import test from "node:test";
import TextCoordinates from "./TextCoordinates.ts";

test("TextCoordinates counts Unicode code points rather than UTF-16 code units", () => {
    const content = "a😀b\nnext";
    assert.equal(TextCoordinates.offsetAtPosition(content, 1, 3), 3);
    assert.deepEqual(TextCoordinates.regionFromOffsets(content, 1, 3), {
        startLine: 1,
        startColumn: 2,
        endLine: 1,
        endColumn: 3,
    });
    assert.equal(TextCoordinates.positionAtOffset(content, 2), null);
});

test("TextCoordinates recognizes CRLF, CR, and LF boundaries", () => {
    const content = "one\r\ntwo\rthree\nfour";
    assert.deepEqual(
        TextCoordinates.lines(content).map(({ start, contentEnd, end, separator }) => ({
            start,
            contentEnd,
            end,
            separator,
        })),
        [
            { start: 0, contentEnd: 3, end: 5, separator: "\r\n" },
            { start: 5, contentEnd: 8, end: 9, separator: "\r" },
            { start: 9, contentEnd: 14, end: 15, separator: "\n" },
            { start: 15, contentEnd: 19, end: 19, separator: "" },
        ],
    );
    assert.deepEqual(TextCoordinates.positionAtOffset(content, 5), { line: 2, column: 1 });
    assert.deepEqual(TextCoordinates.positionAtOffset(content, 15), { line: 4, column: 1 });
    assert.deepEqual(TextCoordinates.positionAtOffset(content, 19), { line: 4, column: 5 });
    assert.equal(TextCoordinates.positionAtOffset(content, 4), null);
    assert.deepEqual(TextCoordinates.positionAtOffset(content, 8), { line: 2, column: 4 });
});

test("TextCoordinates minimally encloses offsets inside indivisible text units", () => {
    assert.deepEqual(TextCoordinates.enclosingRegionFromOffsets("a\r\nb", 2, 3), {
        startLine: 1,
        startColumn: 2,
        endLine: 2,
        endColumn: 1,
    });
    assert.deepEqual(TextCoordinates.enclosingRegionFromOffsets("a😀b", 1, 2), {
        startLine: 1,
        startColumn: 2,
        endLine: 1,
        endColumn: 3,
    });
});

test("TextCoordinates produces complete exclusive whole-line regions", () => {
    assert.deepEqual(TextCoordinates.lineRegion("one\r\ntwo\r\n", 1, 2), {
        startLine: 1,
        startColumn: 1,
        endLine: 2,
        endColumn: 4,
    });
    assert.deepEqual(TextCoordinates.lineRegion("", 1, 1), {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
    });
    assert.equal(TextCoordinates.lineRegion("one", 2, 2), null);
});

test("TextCoordinates distinguishes a terminal insertion position from a whole line", () => {
    assert.equal(TextCoordinates.offsetAtPosition("one\n", 2, 1), 4);
    assert.deepEqual(TextCoordinates.regionFromOffsets("one\n", 4, 4), {
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 1,
    });
    assert.equal(TextCoordinates.lineRegion("one\n", 2, 2), null);
});

test("TextCoordinates translates UTF-8 parser points to Unicode code-point columns", () => {
    assert.deepEqual(
        TextCoordinates.regionFromUtf8Points(
            "a😀b\n",
            { row: 0, column: 1 },
            { row: 0, column: 5 },
        ),
        {
            startLine: 1,
            startColumn: 2,
            endLine: 1,
            endColumn: 3,
        },
    );
    assert.deepEqual(
        TextCoordinates.regionFromUtf8Points(
            "a😀b\n",
            { row: 0, column: 0 },
            { row: 1, column: 0 },
        ),
        {
            startLine: 1,
            startColumn: 1,
            endLine: 2,
            endColumn: 1,
        },
    );
    assert.equal(
        TextCoordinates.regionFromUtf8Points(
            "a😀b",
            { row: 0, column: 2 },
            { row: 0, column: 5 },
        ),
        null,
    );
});
