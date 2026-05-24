import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitContent, fitPreview, fitSymbols } from "./fit.ts";
import type { MimeSymbol, Preview, TokenizeFn } from "./types.ts";

// Deterministic tokenizer: one token per character.
const charTokenize: TokenizeFn = async (text) => text.length;

describe("fitSymbols", () => {
    it("returns empty string for empty input", async () => {
        assert.equal(await fitSymbols([], 100, charTokenize), "");
    });

    it("returns full outline when under budget", async () => {
        const symbols: MimeSymbol[] = [
            { name: "Foo", kind: "class", line: 1, endLine: 10 },
            { name: "bar", kind: "method", line: 3, endLine: 5, params: [] },
        ];
        const out = await fitSymbols(symbols, 1000, charTokenize);
        assert.equal(out, ["class Foo [1-10]", "  method bar() [3-5]"].join("\n"));
    });

    it("drops deepest level when full outline exceeds budget", async () => {
        const symbols: MimeSymbol[] = [
            { name: "Foo", kind: "class", line: 1, endLine: 50 },
            { name: "a", kind: "method", line: 3, endLine: 5, params: [] },
            { name: "b", kind: "method", line: 7, endLine: 9, params: [] },
            { name: "c", kind: "method", line: 11, endLine: 13, params: [] },
        ];
        const out = await fitSymbols(symbols, 20, charTokenize);
        assert.equal(out, "class Foo [1-50]");
    });

    it("drops trailing roots when even root-only outline exceeds budget", async () => {
        const symbols: MimeSymbol[] = [
            { name: "A", kind: "class", line: 1, endLine: 5 },
            { name: "B", kind: "class", line: 10, endLine: 15 },
            { name: "C", kind: "class", line: 20, endLine: 25 },
        ];
        const out = await fitSymbols(symbols, 15, charTokenize);
        assert.equal(out, "class A [1-5]");
    });

    it("returns empty string when even a single root cannot fit", async () => {
        const symbols: MimeSymbol[] = [
            { name: "VeryLongClassName", kind: "class", line: 1, endLine: 100 },
        ];
        assert.equal(await fitSymbols(symbols, 10, charTokenize), "");
    });

    it("calls tokenize on each iteration (verifying it is awaited)", async () => {
        let calls = 0;
        const counting: TokenizeFn = async (text) => {
            calls += 1;
            return text.length;
        };
        const symbols: MimeSymbol[] = [
            { name: "Foo", kind: "class", line: 1, endLine: 50 },
            { name: "bar", kind: "method", line: 3, endLine: 5, params: [] },
        ];
        await fitSymbols(symbols, 1000, counting);
        assert.ok(calls >= 1, "tokenize should be called at least once");
    });
});

describe("fitContent", () => {
    it("returns the full string when it fits the budget", async () => {
        assert.equal(await fitContent("hello", 100, charTokenize), "hello");
    });

    it("returns empty for empty content", async () => {
        assert.equal(await fitContent("", 100, charTokenize), "");
    });

    it("returns empty for zero or negative budget", async () => {
        assert.equal(await fitContent("hello", 0, charTokenize), "");
    });

    it("keeps the head of the content under 'head' orientation", async () => {
        const out = await fitContent("abcdefghij", 4, charTokenize, "head");
        assert.ok(out.length <= 4);
        assert.ok("abcdefghij".startsWith(out));
    });

    it("keeps the tail of the content under 'tail' orientation", async () => {
        const out = await fitContent("abcdefghij", 4, charTokenize, "tail");
        assert.ok(out.length <= 4);
        assert.ok("abcdefghij".endsWith(out));
    });

    it("defaults to 'head' orientation when unspecified", async () => {
        const out = await fitContent("abcdefghij", 4, charTokenize);
        assert.ok("abcdefghij".startsWith(out));
    });
});

describe("fitPreview", () => {
    it("returns empty string for null preview material", async () => {
        assert.equal(await fitPreview(null, 100, charTokenize), "");
    });

    it("dispatches symbols material through fitSymbols", async () => {
        const preview: Preview = {
            kind: "symbols",
            symbols: [{ name: "Foo", kind: "class", line: 1, endLine: 10 }],
        };
        assert.equal(await fitPreview(preview, 1000, charTokenize), "class Foo [1-10]");
    });
});
