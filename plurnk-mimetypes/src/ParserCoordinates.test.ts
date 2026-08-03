import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    materializeTreeSitterSymbols,
    ParserCoordinateError,
    treeSitterSpan,
} from "./ParserCoordinates.ts";

function node(startIndex: number, endIndex: number): never {
    return {
        text: "",
        startIndex,
        endIndex,
        startPosition: { row: 99, column: 99 },
        endPosition: { row: 99, column: 99 },
    } as never;
}

describe("parser-native source spans", () => {
    it("materializes Tree-sitter UTF-16 offsets as Unicode-code-point regions", () => {
        const source = "a😀b\r\ncafe\u0301\rz";
        assert.deepEqual(
            materializeTreeSitterSymbols(source, [{
                name: "astral",
                kind: "variable",
                span: treeSitterSpan(node(1, 3)),
            }]),
            [{
                name: "astral",
                kind: "variable",
                line: 1,
                column: 2,
                endLine: 1,
                endColumn: 3,
            }],
        );
        assert.deepEqual(
            materializeTreeSitterSymbols(source, [{
                name: "multiline",
                kind: "variable",
                span: treeSitterSpan(node(1, source.length)),
            }]),
            [{
                name: "multiline",
                kind: "variable",
                line: 1,
                column: 2,
                endLine: 3,
                endColumn: 2,
            }],
        );
    });

    it("preserves a terminal zero-width insertion point", () => {
        assert.deepEqual(
            materializeTreeSitterSymbols("x😀", [{
                name: "end",
                kind: "variable",
                span: treeSitterSpan(node(3, 3)),
            }]),
            [{
                name: "end",
                kind: "variable",
                line: 1,
                column: 3,
                endLine: 1,
                endColumn: 3,
            }],
        );
    });

    it("can end a semantic span at the next node's start boundary", () => {
        assert.deepEqual(
            materializeTreeSitterSymbols("first\nsecond", [{
                name: "first",
                kind: "variable",
                span: treeSitterSpan(node(0, 5), node(6, 12), "start"),
            }]),
            [{
                name: "first",
                kind: "variable",
                line: 1,
                column: 1,
                endLine: 2,
                endColumn: 1,
            }],
        );
    });

    it("normalizes point-only synthetic nodes through the same source boundary", () => {
        const synthetic = {
            startPosition: { row: 0, column: 1 },
            endPosition: { row: 0, column: 3 },
        };
        assert.deepEqual(
            materializeTreeSitterSymbols("a😀", [{
                name: "astral",
                kind: "variable",
                span: treeSitterSpan(synthetic),
            }]),
            [{
                name: "astral",
                kind: "variable",
                line: 1,
                column: 2,
                endLine: 1,
                endColumn: 3,
            }],
        );
    });

    it("surfaces a native span that bisects an astral character", () => {
        assert.throws(
            () => materializeTreeSitterSymbols("x😀", [{
                name: "broken",
                kind: "variable",
                span: treeSitterSpan(node(2, 3)),
            }]),
            ParserCoordinateError,
        );
    });
});
