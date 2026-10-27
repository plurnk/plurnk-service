import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ParserCoordinateError } from "../ParserCoordinates.ts";
import { collectReferences, type RefsCaptureNode, type RefsQuery } from "./refsEngine.ts";
import type { MimeSymbol } from "../types.ts";
import type { TreeSitterNode, TreeSitterTree } from "../TreeSitterExtractor.ts";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage, TREE_SITTER_REGISTRY } from "./registry.ts";
import { assertQueryEvidenceConformance } from "../conformance.ts";
import { readFile, readdir } from "node:fs/promises";
import { loadRefsQuery } from "./reference-query.ts";

// ─── refsEngine.test.ts ───
{
// Contract: {§mimetype-references}.








function fakeNode(text: string, line: number, column: number): TreeSitterNode {
    return {
        text,
        startPosition: { row: line - 1, column: column - 1 },
        endPosition: { row: line - 1, column: column - 1 + text.length },
    } as TreeSitterNode;
}

function fakeQuery(captures: Array<{ name: string; node: RefsCaptureNode }>): RefsQuery {
    return { captures: () => captures };
}

const fakeTree = {
    rootNode: {
        text: Array.from({ length: 40 }, () => " ".repeat(40)).join("\n"),
    } as TreeSitterNode,
} as TreeSitterTree;

const SYMBOLS: MimeSymbol[] = [
    { name: "Parser", kind: "class", line: 1, endLine: 20 },
    { name: "parse", kind: "method", line: 3, endLine: 10, container: "Parser" },
    { name: "helper", kind: "function", line: 22, endLine: 25 },
];

describe("{§mimetype-references} container is the innermost def's FULL qualified path", () => {
    it("{§mimetype-references} ref inside a method carries container.parent-composed path", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.call", node: fakeNode("tokenize", 5, 9) }]),
            fakeTree,
            SYMBOLS,
            fakeTree.rootNode.text,
        );
        assert.equal(refs[0].container, "Parser.parse", "full qualified path, not just Parser");
    });

    it("{§mimetype-references} ref in the class body but outside any method carries the class path", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.type", node: fakeNode("Shape", 15, 5) }]),
            fakeTree,
            SYMBOLS,
            fakeTree.rootNode.text,
        );
        assert.equal(refs[0].container, "Parser");
    });

    it("{§mimetype-references} module-level ref omits container entirely (absent, not empty)", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.call", node: fakeNode("main", 30, 1) }]),
            fakeTree,
            SYMBOLS,
            fakeTree.rootNode.text,
        );
        assert.equal("container" in refs[0], false);
    });
});

describe("{§mimetype-references} engine hygiene", () => {
    it("{§mimetype-references} non-ref and unknown-kind captures are ignored", () => {
        const refs = collectReferences(
            fakeQuery([
                { name: "def.name", node: fakeNode("x", 1, 1) },
                { name: "ref.bogus", node: fakeNode("y", 2, 1) },
                { name: "ref.call", node: fakeNode("z", 3, 1) },
            ]),
            fakeTree,
            SYMBOLS,
            fakeTree.rootNode.text,
        );
        assert.equal(refs.length, 1);
        assert.equal(refs[0].name, "z");
    });

    it("{§mimetype-references} duplicate captures at one position dedupe; output is document-ordered", () => {
        const refs = collectReferences(
            fakeQuery([
                { name: "ref.call", node: fakeNode("b", 9, 2) },
                { name: "ref.call", node: fakeNode("b", 9, 2) },
                { name: "ref.call", node: fakeNode("a", 4, 7) },
            ]),
            fakeTree,
            SYMBOLS,
            fakeTree.rootNode.text,
        );
        assert.deepEqual(refs.map((r) => [r.name, r.line]), [["a", 4], ["b", 9]]);
    });

    it("{§mimetype-references} rows carry 1-indexed positions with end coordinates", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.import", node: fakeNode("Helper", 1, 10) }]),
            fakeTree,
            SYMBOLS,
            fakeTree.rootNode.text,
        );
        assert.deepEqual(refs[0], {
            name: "Helper",
            kind: "import",
            line: 1,
            column: 10,
            endLine: 1,
            endColumn: 16,
            container: "Parser",
        });
    });

    it("{§mimetype-references} surfaces a capture span that bisects an astral character", () => {
        const tree = {
            rootNode: { text: "😀" } as TreeSitterNode,
        } as TreeSitterTree;
        const node = {
            text: "😀",
            startIndex: 1,
            endIndex: 2,
            startPosition: { row: 0, column: 1 },
            endPosition: { row: 0, column: 2 },
        };
        assert.throws(
            () => collectReferences(
                fakeQuery([{ name: "ref.use", node }]),
                tree,
                [],
                tree.rootNode.text,
            ),
            ParserCoordinateError,
        );
    });
});

describe("{§mimetype-references} end-to-end through process()", () => {
    it("{§mimetype-references} typescript yields classified references via the channel", async () => {
        const { default: Mimetypes } = await import("../Mimetypes.ts");
        const m = new Mimetypes();
        await m.ready();
        const r = await m.process(
            {
                content: "import { A } from \"./a\";\nclass C extends A { run() { go(); } }\n",
                hint: "text/typescript",
            },
            { channels: ["references"] },
        );
        const refs = r.references!;
        // A is referenced twice: as an import binding (line 1) and as the
        // extends target (line 2) — both edges, distinctly classified.
        assert.ok(refs.some((ref) => ref.name === "A" && ref.kind === "import" && ref.line === 1));
        assert.ok(refs.some((ref) => ref.name === "A" && ref.kind === "inherit" && ref.line === 2));
        const go = refs.find((ref) => ref.name === "go")!;
        assert.equal(go.kind, "call");
        assert.equal(go.container, "C.run");
    });

    it("{§mimetype-references} a language without a refsQuery yields []", async () => {
        const { default: Mimetypes } = await import("../Mimetypes.ts");
        const m = new Mimetypes();
        await m.ready();
        const r = await m.process(
            { content: "key: value\n", hint: "application/yaml" },
            { channels: ["references"] },
        );
        assert.deepEqual(r.references, []);
    });
});
}

// ─── queryEvidence.conformance.test.ts ───
{
// Query-evidence conformance for the tree-sitter channel. All grammar
// packages route through the ONE shared TreeSitterLanguageHandler, so gating it
// across a spread of languages here proves the whole class: the root structural
// match spans the exact readable source. Handler-specific suites cover parser
// node positions below that root.





const cases: ReadonlyArray<[string, string, number]> = [
    ["text/x-python", "def f(x):\n    y = x + 1\n    return y\n", 4],
    ["text/x-rust", "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n", 4],
    ["text/x-go", "package main\nfunc add(a int) int {\n    return a\n}\n", 5],
    ["text/javascript", "function add(a, b) {\n  const s = a + b;\n  return s;\n}\n", 5],
    ["text/x-c", "int add(int a, int b) {\n    return a + b;\n}\n", 4],
    ["text/x-ruby", "def add(a, b)\n  a + b\nend\n", 4],
];

describe("{§mimetype-query} tree-sitter query-evidence conformance (shared handler, all grammars)", () => {
    for (const [mimetype, source, finalLine] of cases) {
        it(`{§mimetype-query} ${mimetype}: both structural dialects retain the exact root region`, async () => {
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
}

// ─── reference-query.test.ts ───
{
test("{§mimetype-references} missing assets surface their I/O failure", async () => {
    await assert.rejects(loadRefsQuery("missing-query-fixture"), { code: "ENOENT" });
});

test("{§mimetype-references} every reference mapping uses its packaged query asset", async () => {
    const assets = new Set((await readdir(new URL("../../queries/", import.meta.url)))
        .filter((name) => name.endsWith(".scm")));
    const used = new Set<string>();
    for (const entry of TREE_SITTER_REGISTRY) {
        const mapping = await entry.importMapping();
        if (mapping.refsQuery === undefined) continue;
        const names = entry.slug === "tsx" ? ["typescript", "tsx"] : [entry.slug];
        const sources = await Promise.all(names.map((name) => {
            used.add(`${name}.scm`);
            return readFile(new URL(`../../queries/${name}.scm`, import.meta.url), "utf8");
        }));
        assert.equal(mapping.refsQuery, sources.join(""), entry.slug);
        assert.match(mapping.refsQuery, /@ref\./u, `${entry.slug} has actual capture patterns`);
    }
    assert.ok(used.size > 0, "reference assets are exercised");
    assert.deepEqual(used, assets, "every shipped query serves an installed mapping");
});
}
