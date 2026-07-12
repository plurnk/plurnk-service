import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/css")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/css via tree-sitter registry", () => {
    it("rule_set selectors → fields", async () => {
        const src = ".card { color: red; }\n#main, nav > ul { margin: 0; }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === ".card")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "#main, nav > ul")?.kind, "field");
    });

    it(":root custom properties → constants", async () => {
        const src = ":root {\n  --brand: #f00;\n  --gap: 1rem;\n  color: black;\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === ":root")?.kind, "field");
        assert.equal(syms.find((s) => s.name === "--brand")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "--gap")?.kind, "constant");
        assert.equal(syms.find((s) => s.name === "color"), undefined);
    });

    it("@keyframes → module with keyframe name", async () => {
        const src = "@keyframes spin { from { rotate: 0deg; } to { rotate: 360deg; } }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "spin")?.kind, "module");
    });

    it("@media → module and nested rules surface", async () => {
        const src = "@media (max-width: 600px) {\n  .compact { display: none; }\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name.startsWith("@media"))?.kind, "module");
        assert.equal(syms.find((s) => s.name === ".compact")?.kind, "field");
    });

    it("line positions are 1-based", async () => {
        const src = "/* header */\n.first { color: red; }\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === ".first")?.line, 2);
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("{{{ not css"));
    });
});

describe("text/css — container + columns (issue #18)", () => {
    it("rules inside @media carry the @media symbol name as container", async () => {
        const src = "@media (max-width: 600px) {\n  .card { color: red; }\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(
            syms.find((s) => s.name === "@media (max-width: 600px)")?.container,
            undefined,
        );
        assert.equal(
            syms.find((s) => s.name === ".card")?.container,
            "@media (max-width: 600px)",
        );
    });

    it(":root custom properties carry container \":root\"", async () => {
        const src = ":root {\n  --brand: #f00;\n}\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === ":root")?.container, undefined);
        assert.equal(syms.find((s) => s.name === "--brand")?.container, ":root");
    });

    it("top-level rule_sets carry no container; all symbols carry 1-indexed columns", async () => {
        const src = ".top { margin: 0; }\n";
        const syms = await h().extractRaw(src);
        const top = syms.find((s) => s.name === ".top");
        assert.equal(top?.container, undefined);
        assert.equal(top?.column, 1);
        assert.ok((top?.endColumn ?? 0) >= 1);
    });
});
