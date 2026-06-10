import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-rust")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-rust via tree-sitter registry", () => {
    it("fn → function with params", async () => {
        const syms = await h().extractRaw("fn add(a: i32, b: i32) -> i32 { a + b }\n");
        const fn = syms.find((s) => s.name === "add");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("struct + enum + union + trait → class/enum/class/interface", async () => {
        const src = "struct P { x: i32 }\nenum E { A, B }\nunion U { a: i32, b: f32 }\ntrait T { fn run(&self); }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "P")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "E")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "U")?.kind, "class");
        assert.equal(syms.find((s) => s.name === "T")?.kind, "interface");
        const run = syms.find((s) => s.name === "run");
        assert.equal(run?.kind, "method", "fn inside trait body should be method");
    });

    it("impl block contents → method", async () => {
        const src = "struct C;\nimpl C { fn foo(&self, x: i32) {} }\n";
        const syms = await h().extractRaw(src);
        const foo = syms.find((s) => s.name === "foo");
        assert.equal(foo?.kind, "method");
        assert.deepEqual(foo?.params, ["self", "x"]);
    });

    it("mod block → module, recurse into children", async () => {
        const src = "mod inner { fn deep() {} struct S; }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "inner")?.kind, "module");
        assert.equal(syms.find((s) => s.name === "deep")?.kind, "function");
        assert.equal(syms.find((s) => s.name === "S")?.kind, "class");
    });

    it("const + static → constant, type alias → type", async () => {
        const src = "const MAX: i32 = 100;\nstatic GLOBAL: i32 = 7;\ntype Name = String;\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "MAX")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "GLOBAL")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "Name")?.kind, "type");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("fn ((( broken"));
    });
});

describe("text/x-rust — container + columns (issue #18)", () => {
    it("impl methods carry the impl'd type as container; mod nesting is dotted", async () => {
        const src = "mod inner {\n  struct S;\n  impl S { fn act(&self) {} }\n  fn deep() {}\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "inner")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "S")?.container, "inner");
        assert.equal(syms.find((s) => s.name === "act")?.container, "inner.S");
        const deep = syms.find((s) => s.name === "deep");
        assert.equal(deep?.kind, "function");
        assert.equal(deep?.container, "inner");
    });

    it("generic impl resolves container to the base type name; trait fns carry the trait", async () => {
        const src = "struct Wrap<T>(T);\nimpl<T> Wrap<T> { fn get(&self) {} }\ntrait Tr { fn req(&self); }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "get")?.container, "Wrap");
        assert.equal(syms.find((s) => s.name === "req")?.container, "Tr");
    });

    it("top-level symbols carry no container; all symbols carry 1-indexed columns", async () => {
        const syms = await h().extractRaw("fn solo() {}\n");
        const solo = syms.find((s) => s.name === "solo");
        assert.equal(solo?.container, undefined);
        assert.equal(solo?.column, 1);
        assert.ok((solo?.endColumn ?? 0) >= 1);
    });
});
