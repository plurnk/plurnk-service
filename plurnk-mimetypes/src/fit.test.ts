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

    it("returns empty when budget is smaller than the truncation marker", async () => {
        // Marker "...[[TRUNCATED]]" is 16 chars / 16 tokens with charTokenize.
        // Budget of 10 can't even fit the marker alone — no meaningful slice.
        const long = "a".repeat(100);
        assert.equal(await fitContent(long, 10, charTokenize), "");
    });
});

describe("fitContent — head orientation with truncation marker", () => {
    it("keeps the head of the content and appends ...[[TRUNCATED]]", async () => {
        // 100 char content, budget 50 (well above 16-char marker reservation).
        const long = "abcdefghij".repeat(10);
        const out = await fitContent(long, 50, charTokenize, "head");
        assert.ok(out.endsWith("...[[TRUNCATED]]"), `expected trailing marker; got ${JSON.stringify(out)}`);
        assert.ok(out.length <= 50);
        const head = out.slice(0, out.length - "...[[TRUNCATED]]".length);
        assert.ok(long.startsWith(head), "head slice should be a prefix of content");
    });

    it("defaults to head orientation when unspecified", async () => {
        const long = "abcdefghij".repeat(10);
        const out = await fitContent(long, 50, charTokenize);
        assert.ok(out.endsWith("...[[TRUNCATED]]"));
    });

    it("does not add the marker when no truncation occurs", async () => {
        const short = "hello";
        const out = await fitContent(short, 100, charTokenize, "head");
        assert.equal(out, "hello");
        assert.ok(!out.includes("[[TRUNCATED]]"));
    });
});

describe("fitContent — tail orientation with truncation marker", () => {
    it("keeps the tail of the content and prepends [[TRUNCATED]]...", async () => {
        const long = "abcdefghij".repeat(10);
        const out = await fitContent(long, 50, charTokenize, "tail");
        assert.ok(out.startsWith("[[TRUNCATED]]..."), `expected leading marker; got ${JSON.stringify(out)}`);
        assert.ok(out.length <= 50);
        const tail = out.slice("[[TRUNCATED]]...".length);
        assert.ok(long.endsWith(tail), "tail slice should be a suffix of content");
    });

    it("does not add the marker when no truncation occurs", async () => {
        const out = await fitContent("recent\nlog\nlines", 100, charTokenize, "tail");
        assert.equal(out, "recent\nlog\nlines");
        assert.ok(!out.includes("[[TRUNCATED]]"));
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

    it("dispatches text material through fitContent with handler-declared orientation", async () => {
        const headPreview: Preview = { kind: "text", text: "a".repeat(100), orientation: "head" };
        const headOut = await fitPreview(headPreview, 50, charTokenize);
        assert.ok(headOut.endsWith("...[[TRUNCATED]]"));

        const tailPreview: Preview = { kind: "text", text: "a".repeat(100), orientation: "tail" };
        const tailOut = await fitPreview(tailPreview, 50, charTokenize);
        assert.ok(tailOut.startsWith("[[TRUNCATED]]..."));
    });

    it("returns text as-is when it fits the budget (no marker, no symbols)", async () => {
        const preview: Preview = { kind: "text", text: "hello", orientation: "head" };
        assert.equal(await fitPreview(preview, 100, charTokenize), "hello");
    });
});
