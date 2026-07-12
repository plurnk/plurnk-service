// Issue #19: 0.15 P3+P4 — references channel: RefKind lock, query engine,
// priority languages. https://github.com/plurnk/plurnk-mimetypes/issues/19
//
// Load-bearing claims, restated as testable contracts:
//
//   C1. The engine resolves each ref's `container` to the FULL qualified
//       path of the innermost enclosing emitted def (SPEC §16 — the @> join
//       key): a ref inside method `parse` of class `Parser` carries
//       "Parser.parse", never just "Parser". Module-level refs omit the key.
//   C2. Engine hygiene: only `@ref.<frozen-kind>` captures are emitted;
//       duplicate captures at one position dedupe; output is in document
//       order.
//   C3. End-to-end: process({channels:["references"]}) on a language with a
//       refsQuery yields classified rows; a language without one yields [].
//
// Per-language capture coverage lives in test/conformance/{slug}.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectReferences } from "../treesitter/refsEngine.ts";
import type { RefsQuery } from "../treesitter/refsEngine.ts";
import type { MimeSymbol } from "../types.ts";
import type { TreeSitterNode, TreeSitterTree } from "../TreeSitterExtractor.ts";

function fakeNode(text: string, line: number, column: number): TreeSitterNode {
    return {
        text,
        startPosition: { row: line - 1, column: column - 1 },
        endPosition: { row: line - 1, column: column - 1 + text.length },
    } as TreeSitterNode;
}

function fakeQuery(captures: Array<{ name: string; node: TreeSitterNode }>): RefsQuery {
    return { captures: () => captures };
}

const fakeTree = { rootNode: {} as TreeSitterNode } as TreeSitterTree;

const SYMBOLS: MimeSymbol[] = [
    { name: "Parser", kind: "class", line: 1, endLine: 20 },
    { name: "parse", kind: "method", line: 3, endLine: 10, container: "Parser" },
    { name: "helper", kind: "function", line: 22, endLine: 25 },
];

describe("Issue #19 — C1: container is the innermost def's FULL qualified path", () => {
    it("ref inside a method carries container.parent-composed path", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.call", node: fakeNode("tokenize", 5, 9) }]),
            fakeTree,
            SYMBOLS,
        );
        assert.equal(refs[0].container, "Parser.parse", "full qualified path, not just Parser");
    });

    it("ref in the class body but outside any method carries the class path", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.type", node: fakeNode("Shape", 15, 5) }]),
            fakeTree,
            SYMBOLS,
        );
        assert.equal(refs[0].container, "Parser");
    });

    it("module-level ref omits container entirely (absent, not empty)", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.call", node: fakeNode("main", 30, 1) }]),
            fakeTree,
            SYMBOLS,
        );
        assert.equal("container" in refs[0], false);
    });
});

describe("Issue #19 — C2: engine hygiene", () => {
    it("non-ref and unknown-kind captures are ignored", () => {
        const refs = collectReferences(
            fakeQuery([
                { name: "def.name", node: fakeNode("x", 1, 1) },
                { name: "ref.bogus", node: fakeNode("y", 2, 1) },
                { name: "ref.call", node: fakeNode("z", 3, 1) },
            ]),
            fakeTree,
            SYMBOLS,
        );
        assert.equal(refs.length, 1);
        assert.equal(refs[0].name, "z");
    });

    it("duplicate captures at one position dedupe; output is document-ordered", () => {
        const refs = collectReferences(
            fakeQuery([
                { name: "ref.call", node: fakeNode("b", 9, 2) },
                { name: "ref.call", node: fakeNode("b", 9, 2) },
                { name: "ref.call", node: fakeNode("a", 4, 7) },
            ]),
            fakeTree,
            SYMBOLS,
        );
        assert.deepEqual(refs.map((r) => [r.name, r.line]), [["a", 4], ["b", 9]]);
    });

    it("rows carry 1-indexed positions with end coordinates", () => {
        const refs = collectReferences(
            fakeQuery([{ name: "ref.import", node: fakeNode("Helper", 1, 10) }]),
            fakeTree,
            SYMBOLS,
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
});

describe("Issue #19 — C3: end-to-end through process()", () => {
    it("typescript yields classified references via the channel", async () => {
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

    it("a language without a refsQuery yields []", async () => {
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
