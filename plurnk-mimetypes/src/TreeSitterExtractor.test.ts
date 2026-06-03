import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterExtractor from "./TreeSitterExtractor.ts";
import type { TreeSitterParser, TreeSitterTree, TreeSitterNode } from "./TreeSitterExtractor.ts";
import type { MimeSymbol } from "./types.ts";

const metadata = {
    mimetype: "text/x-fake",
    glyph: "x",
    extensions: [".fake"] as const,
};

// Fake tree-sitter that returns a fixed tree without actually loading WASM.
// Exercises the base class's parser-cache + error handling without needing
// the runtime dep.
function fakeNode(text: string): TreeSitterNode {
    return {
        type: "root",
        text,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: text.length },
        childCount: 0,
        namedChildCount: 0,
        child: () => null,
        namedChild: () => null,
        childForFieldName: () => null,
        descendantsOfType: () => [],
    };
}

describe("TreeSitterExtractor", () => {
    it("calls loadParser once across multiple extractRaw calls (primed cache)", async () => {
        let loadCount = 0;
        class Fake extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                loadCount += 1;
                return {
                    parse: (content): TreeSitterTree => ({ rootNode: fakeNode(content) }),
                };
            }
            protected override extractFromTree(_tree: TreeSitterTree, content: string): MimeSymbol[] {
                return [{ name: content, kind: "class", line: 1, endLine: 1 }];
            }
        }
        const h = new Fake(metadata);
        const a = await h.extractRaw("alpha");
        const b = await h.extractRaw("beta");
        const c = await h.extractRaw("gamma");
        assert.equal(loadCount, 1, "loadParser called only once across three calls");
        assert.equal(a[0]?.name, "alpha");
        assert.equal(b[0]?.name, "beta");
        assert.equal(c[0]?.name, "gamma");
    });

    it("returns [] when loadParser throws", async () => {
        class Fake extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                throw new Error("WASM init failed");
            }
            protected override extractFromTree(): MimeSymbol[] {
                return [{ name: "unreachable", kind: "class", line: 1, endLine: 1 }];
            }
        }
        const h = new Fake(metadata);
        const syms = await h.extractRaw("anything");
        assert.deepEqual(syms, []);
    });

    it("returns [] when parser.parse throws", async () => {
        class Fake extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                return {
                    parse: () => {
                        throw new Error("parse failed");
                    },
                };
            }
            protected override extractFromTree(): MimeSymbol[] {
                return [{ name: "unreachable", kind: "class", line: 1, endLine: 1 }];
            }
        }
        const h = new Fake(metadata);
        assert.deepEqual(await h.extractRaw("anything"), []);
    });

    it("returns [] when parser.parse returns null", async () => {
        class Fake extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                return { parse: () => null };
            }
            protected override extractFromTree(): MimeSymbol[] {
                return [{ name: "unreachable", kind: "class", line: 1, endLine: 1 }];
            }
        }
        const h = new Fake(metadata);
        assert.deepEqual(await h.extractRaw("anything"), []);
    });

    it("returns [] when extractFromTree throws", async () => {
        class Fake extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                return { parse: (content) => ({ rootNode: fakeNode(content) }) };
            }
            protected override extractFromTree(): MimeSymbol[] {
                throw new Error("visit failed");
            }
        }
        const h = new Fake(metadata);
        assert.deepEqual(await h.extractRaw("anything"), []);
    });

    it("returns [] when content is binary", async () => {
        class Fake extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                throw new Error("should never load — binary content rejects early");
            }
            protected override extractFromTree(): MimeSymbol[] {
                return [];
            }
        }
        const h = new Fake(metadata);
        assert.deepEqual(await h.extractRaw(new Uint8Array([1, 2, 3])), []);
    });

    it("calls tree.delete() after extraction for memory hygiene", async () => {
        let deleteCount = 0;
        class Fake extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                return {
                    parse: (content): TreeSitterTree => ({
                        rootNode: fakeNode(content),
                        delete: () => { deleteCount += 1; },
                    }),
                };
            }
            protected override extractFromTree(): MimeSymbol[] {
                return [];
            }
        }
        const h = new Fake(metadata);
        await h.extractRaw("a");
        await h.extractRaw("b");
        assert.equal(deleteCount, 2);
    });
});
