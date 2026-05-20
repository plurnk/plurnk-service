import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fit } from "./fit.ts";
import type { MimeSymbol, TokenizeFn } from "./types.ts";

// Deterministic tokenizer: one token per character.
const charTokenize: TokenizeFn = async (text) => text.length;

describe("fit", () => {
    it("returns empty string for empty input", async () => {
        assert.equal(await fit([], 100, charTokenize), "");
    });

    it("returns full outline when under budget", async () => {
        const symbols: MimeSymbol[] = [
            { name: "Foo", kind: "class", line: 1, endLine: 10 },
            { name: "bar", kind: "method", line: 3, endLine: 5, params: [] },
        ];
        const out = await fit(symbols, 1000, charTokenize);
        assert.equal(out, ["class Foo [1-10]", "  method bar() [3-5]"].join("\n"));
    });

    it("drops deepest level when full outline exceeds budget", async () => {
        const symbols: MimeSymbol[] = [
            { name: "Foo", kind: "class", line: 1, endLine: 50 },
            { name: "a", kind: "method", line: 3, endLine: 5, params: [] },
            { name: "b", kind: "method", line: 7, endLine: 9, params: [] },
            { name: "c", kind: "method", line: 11, endLine: 13, params: [] },
        ];
        // Full output: "class Foo [1-50]\n  method a() [3-5]\n  method b() [7-9]\n  method c() [11-13]"
        // Roots only: "class Foo [1-50]" (16 chars)
        const out = await fit(symbols, 20, charTokenize);
        assert.equal(out, "class Foo [1-50]");
    });

    it("drops trailing roots when even root-only outline exceeds budget", async () => {
        const symbols: MimeSymbol[] = [
            { name: "A", kind: "class", line: 1, endLine: 5 },
            { name: "B", kind: "class", line: 10, endLine: 15 },
            { name: "C", kind: "class", line: 20, endLine: 25 },
        ];
        // Each root is ~14 chars + newline. Budget 15 fits only one.
        const out = await fit(symbols, 15, charTokenize);
        assert.equal(out, "class A [1-5]");
    });

    it("returns empty string when even a single root cannot fit", async () => {
        const symbols: MimeSymbol[] = [
            { name: "VeryLongClassName", kind: "class", line: 1, endLine: 100 },
        ];
        // Output: "class VeryLongClassName [1-100]" — 31 chars. Budget 10 too small.
        assert.equal(await fit(symbols, 10, charTokenize), "");
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
        await fit(symbols, 1000, counting);
        assert.ok(calls >= 1, "tokenize should be called at least once");
    });
});
