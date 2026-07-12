// Coverage: SPEC §4 (outline format).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { format } from "./format.ts";
import type { MimeSymbol } from "./types.ts";

describe("format", () => {
    it("returns empty string for empty input", () => {
        assert.equal(format([]), "");
    });

    it("formats a single heading with hash prefix and line number", () => {
        const symbols: MimeSymbol[] = [
            { name: "Intro", kind: "heading", line: 1, endLine: 1, level: 1 },
        ];
        assert.equal(format(symbols), "# Intro [1]");
    });

    it("nests headings by level under their parent", () => {
        const symbols: MimeSymbol[] = [
            { name: "Top", kind: "heading", line: 1, endLine: 1, level: 1 },
            { name: "Section", kind: "heading", line: 3, endLine: 3, level: 2 },
            { name: "Subsection", kind: "heading", line: 5, endLine: 5, level: 3 },
            { name: "Other", kind: "heading", line: 10, endLine: 10, level: 2 },
        ];
        assert.equal(
            format(symbols),
            [
                "# Top [1]",
                "  ## Section [3]",
                "    ### Subsection [5]",
                "  ## Other [10]",
            ].join("\n"),
        );
    });

    it("formats a function with parameters and multi-line range", () => {
        const symbols: MimeSymbol[] = [
            { name: "parse", kind: "function", line: 10, endLine: 25, params: ["source", "options"] },
        ];
        assert.equal(format(symbols), "function parse(source, options) [10-25]");
    });

    it("nests methods inside their containing class by line-range containment", () => {
        const symbols: MimeSymbol[] = [
            { name: "Parser", kind: "class", line: 5, endLine: 47 },
            { name: "parse", kind: "method", line: 10, endLine: 20, params: ["source"] },
            { name: "load", kind: "method", line: 22, endLine: 45, params: ["dir"] },
        ];
        assert.equal(
            format(symbols),
            [
                "class Parser [5-47]",
                "  method parse(source) [10-20]",
                "  method load(dir) [22-45]",
            ].join("\n"),
        );
    });

    it("uses single-line range notation when line equals endLine", () => {
        const symbols: MimeSymbol[] = [
            { name: "PORT", kind: "constant", line: 3, endLine: 3 },
        ];
        assert.equal(format(symbols), "constant PORT [3]");
    });

    it("renders independent top-level symbols at depth 0", () => {
        const symbols: MimeSymbol[] = [
            { name: "Foo", kind: "class", line: 5, endLine: 10 },
            { name: "bar", kind: "function", line: 12, endLine: 15, params: [] },
        ];
        assert.equal(
            format(symbols),
            ["class Foo [5-10]", "function bar() [12-15]"].join("\n"),
        );
    });
});
