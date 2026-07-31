// Query-evidence conformance for the tree-sitter channel. All grammar
// packages route through the ONE shared TreeSitterLanguageHandler, so gating it
// across a spread of languages here proves the whole class: the root structural
// match spans the exact readable source. Handler-specific suites cover parser
// node positions below that root.

import { describe, it } from "node:test";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";
import { assertQueryEvidenceConformance } from "../conformance.ts";

const cases: ReadonlyArray<[string, string, number]> = [
    ["text/x-python", "def f(x):\n    y = x + 1\n    return y\n", 4],
    ["text/x-rust", "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n", 4],
    ["text/x-go", "package main\nfunc add(a int) int {\n    return a\n}\n", 5],
    ["text/javascript", "function add(a, b) {\n  const s = a + b;\n  return s;\n}\n", 5],
    ["text/x-c", "int add(int a, int b) {\n    return a + b;\n}\n", 4],
    ["text/x-ruby", "def add(a, b)\n  a + b\nend\n", 4],
];

describe("tree-sitter query-evidence conformance (shared handler, all grammars)", () => {
    for (const [mimetype, source, finalLine] of cases) {
        it(`${mimetype}: both structural dialects retain the exact root region`, async () => {
            const entry = lookupTreeSitterLanguage(mimetype);
            if (!entry) throw new Error(`no registry entry for ${mimetype}`);
            const h = new TreeSitterLanguageHandler(
                { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions },
                entry,
            );
            await assertQueryEvidenceConformance(h, [
                {
                    source,
                    dialect: "jsonpath",
                    pattern: "$",
                    verdict: "exact",
                    expectRegions: [[{
                        startLine: 1,
                        startColumn: 1,
                        endLine: finalLine,
                        endColumn: 1,
                    }]],
                },
                {
                    source,
                    dialect: "xpath",
                    pattern: "/*",
                    verdict: "exact",
                    expectRegions: [[{
                        startLine: 1,
                        startColumn: 1,
                        endLine: finalLine,
                        endColumn: 1,
                    }]],
                },
            ]);
        });
    }
});
