import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-php")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-php via tree-sitter registry", () => {
    it("class + method + property → class + method + field", async () => {
        const src = "<?php\nclass User {\n  public string $name;\n  public function greet($prefix) { return $prefix . $this->name; }\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "User")?.kind, "class");
        const greet = syms.find((s) => s.name === "greet");
        assert.equal(greet?.kind, "method");
        assert.deepEqual(greet?.params, ["prefix"]);
        assert.equal(syms.find((s) => s.name === "name")?.kind, "field");
    });

    it("function_definition → function", async () => {
        const src = "<?php\nfunction add($a, $b) { return $a + $b; }\n";
        const syms = await h().extractRaw(src);
        const fn = syms.find((s) => s.name === "add");
        assert.equal(fn?.kind, "function");
        assert.deepEqual(fn?.params, ["a", "b"]);
    });

    it("interface + trait → interface + class", async () => {
        const src = "<?php\ninterface Doable { public function run(); }\ntrait Greeter { public function hi() {} }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Doable")?.kind, "interface");
        assert.equal(syms.find((s) => s.name === "Greeter")?.kind, "class");
    });

    it("enum → enum + cases as constants", async () => {
        const src = "<?php\nenum Color { case Red; case Green; }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "Color")?.kind, "enum");
        assert.equal(syms.find((s) => s.name === "Red")?.kind, "constant");
    });

    it("namespace → module", async () => {
        const src = "<?php\nnamespace App\\Domain;\nclass C {}\n";
        const syms = await h().extractRaw(src);
        const m = syms.find((s) => s.kind === "module");
        assert.ok(m, "namespace should produce a module symbol");
        assert.equal(syms.find((s) => s.name === "C")?.kind, "class");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("<?php class ((( broken"));
    });
});

describe("text/x-php — container + columns (issue #18)", () => {
    it("members carry the enclosing class as container", async () => {
        const src = "<?php\nclass User {\n  public string $name;\n  public function greet($prefix) { return $prefix; }\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "User")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "greet")?.container, "User");
        assert.equal(syms.find((s) => s.name === "name")?.container, "User");
    });

    it("top-level symbols carry no container; columns are 1-indexed", async () => {
        const syms = await h().extractRaw("<?php\nfunction add($a, $b) { return $a + $b; }\n");
        const fn = syms.find((s) => s.name === "add");
        assert.equal(fn?.container, undefined);
        assert.equal(fn?.column, 1);
        assert.ok((fn?.endColumn ?? 0) >= 1);
    });
});
