// #41 query-line conformance for the tree-sitter channel. All 30 grammar
// packages route through the ONE shared TreeSitterLanguageHandler, so gating it
// across a spread of languages here proves the whole class: a structural match
// on any tree-sitter deepJson carries a source-line span. A regression in the
// shared deepJson projection is a red build, not a silent ecosystem-wide gap.

import { describe, it } from "node:test";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";
import { assertQueryLineConformance } from "../conformance.ts";

const cases: ReadonlyArray<[string, string]> = [
    ["text/x-python", "def f(x):\n    y = x + 1\n    return y\n"],
    ["text/x-rust", "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n"],
    ["text/x-go", "package main\nfunc add(a int) int {\n    return a\n}\n"],
    ["text/javascript", "function add(a, b) {\n  const s = a + b;\n  return s;\n}\n"],
    ["text/x-c", "int add(int a, int b) {\n    return a + b;\n}\n"],
    ["text/x-ruby", "def add(a, b)\n  a + b\nend\n"],
];

describe("#41 — tree-sitter query-line conformance (shared handler, all grammars)", () => {
    for (const [mimetype, source] of cases) {
        it(`${mimetype}: every structural match carries a source-line span`, async () => {
            const entry = lookupTreeSitterLanguage(mimetype);
            if (!entry) throw new Error(`no registry entry for ${mimetype}`);
            const h = new TreeSitterLanguageHandler(
                { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions },
                entry,
            );
            await assertQueryLineConformance(h, [
                { source, dialect: "jsonpath", pattern: "$..children[*]" },
            ]);
        });
    }
});
