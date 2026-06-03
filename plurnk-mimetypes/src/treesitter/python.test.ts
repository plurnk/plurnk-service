import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-python")!;
const metadata = {
    mimetype: entry.mimetype,
    glyph: entry.glyph,
    extensions: entry.extensions,
};

function makeHandler(): TreeSitterLanguageHandler {
    return new TreeSitterLanguageHandler(metadata, entry);
}

describe("text/x-python via tree-sitter registry", () => {
    it("extracts top-level functions with params", async () => {
        const h = makeHandler();
        const syms = await h.extractRaw("def add(a, b):\n    return a + b\n");
        const add = syms.find((s) => s.name === "add");
        assert.ok(add);
        assert.equal(add.kind, "function");
        assert.deepEqual(add.params, ["a", "b"]);
    });

    it("extracts classes + methods (method kind inside class scope)", async () => {
        const h = makeHandler();
        const src = [
            "class Parser:",
            "    name = \"\"",
            "    def parse(self, source):",
            "        return source",
            "    def load(self, path, strict):",
            "        return path",
            "",
        ].join("\n");
        const syms = await h.extractRaw(src);
        const cls = syms.find((s) => s.name === "Parser" && s.kind === "class");
        assert.ok(cls);
        const name = syms.find((s) => s.name === "name" && s.kind === "field");
        assert.ok(name);
        const parse = syms.find((s) => s.name === "parse");
        assert.ok(parse);
        assert.equal(parse.kind, "method");
        assert.deepEqual(parse.params, ["self", "source"]);
        const load = syms.find((s) => s.name === "load");
        assert.deepEqual(load?.params, ["self", "path", "strict"]);
    });

    it("classifies top-level assignment by SCREAMING_SNAKE → constant vs variable", async () => {
        const h = makeHandler();
        const syms = await h.extractRaw("MAX_RETRIES = 3\nversion = 1\n");
        const m = syms.find((s) => s.name === "MAX_RETRIES");
        assert.ok(m);
        assert.equal(m.kind, "constant");
        const v = syms.find((s) => s.name === "version");
        assert.ok(v);
        assert.equal(v.kind, "variable");
    });

    it("handles decorated definitions (decorators unwrap to the inner def)", async () => {
        const h = makeHandler();
        const src = [
            "@dataclass",
            "class Point:",
            "    x: int",
            "    y: int",
            "",
            "@staticmethod",
            "def helper():",
            "    pass",
            "",
        ].join("\n");
        const syms = await h.extractRaw(src);
        const cls = syms.find((s) => s.name === "Point");
        assert.ok(cls);
        assert.equal(cls.kind, "class");
        const fn = syms.find((s) => s.name === "helper");
        assert.ok(fn);
        assert.equal(fn.kind, "function");
    });

    it("extracts async functions as function kind", async () => {
        const h = makeHandler();
        const syms = await h.extractRaw("async def fetch(url):\n    pass\n");
        const f = syms.find((s) => s.name === "fetch");
        assert.ok(f);
        assert.equal(f.kind, "function");
        assert.deepEqual(f.params, ["url"]);
    });

    it("excludes function-body locals (no recursion into function bodies)", async () => {
        const h = makeHandler();
        const src = [
            "def compute():",
            "    x = 1",
            "    y = 2",
            "    return x + y",
            "",
        ].join("\n");
        const syms = await h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names, ["compute"]);
    });

    it("returns [] for empty input", async () => {
        const h = makeHandler();
        assert.deepEqual(await h.extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        const h = makeHandler();
        await assert.doesNotReject(h.extractRaw("def (((broken"));
        await assert.doesNotReject(h.extractRaw("@@ totally bogus"));
    });

    it("primes the parser cache — second call doesn't re-init WASM", async () => {
        const h = makeHandler();
        const t0 = process.hrtime.bigint();
        await h.extractRaw("def first(): pass\n");
        const t1 = process.hrtime.bigint();
        await h.extractRaw("def second(): pass\n");
        const t2 = process.hrtime.bigint();
        const firstMs = Number(t1 - t0) / 1e6;
        const secondMs = Number(t2 - t1) / 1e6;
        assert.ok(secondMs < firstMs, `second call (${secondMs.toFixed(1)}ms) should be faster than first (${firstMs.toFixed(1)}ms) — cache primed`);
    });
});
