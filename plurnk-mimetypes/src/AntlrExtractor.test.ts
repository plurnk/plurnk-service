import { describe, it } from "node:test";
import assert from "node:assert/strict";
import AntlrExtractor from "./AntlrExtractor.ts";
import type { ExtractionVisitor, MimeSymbol, SymbolPreview } from "./types.ts";

const metadata = {
    mimetype: "application/x-test",
    glyph: "🧪",
    extensions: [".test"] as const,
};

// Test visitor that records visits and reports symbols set at construction.
function visitorReturning(symbols: MimeSymbol[]): ExtractionVisitor {
    return {
        visit(_tree: unknown): unknown {
            return null;
        },
        get symbols(): MimeSymbol[] {
            return symbols;
        },
    };
}

describe("AntlrExtractor", () => {
    it("orchestrates parseTree -> createVisitor -> visit -> symbols", () => {
        const expected: MimeSymbol[] = [
            { name: "Foo", kind: "class", line: 1, endLine: 10 },
        ];

        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return { fake: "tree" };
            }
            protected createVisitor(): ExtractionVisitor {
                return visitorReturning(expected);
            }
        }
        const e = new Extractor(metadata);
        assert.deepEqual(e.extractRaw("content"), expected);
    });

    it("returns [] when parseTree throws (parse failure)", () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                throw new Error("syntax error");
            }
            protected createVisitor(): ExtractionVisitor {
                throw new Error("should not be called");
            }
        }
        const e = new Extractor(metadata);
        assert.deepEqual(e.extractRaw("malformed"), []);
    });

    it("returns [] when parseTree returns null or undefined", () => {
        class NullExtractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return null;
            }
            protected createVisitor(): ExtractionVisitor {
                throw new Error("should not be called");
            }
        }
        class UndefExtractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return undefined;
            }
            protected createVisitor(): ExtractionVisitor {
                throw new Error("should not be called");
            }
        }
        assert.deepEqual(new NullExtractor(metadata).extractRaw("x"), []);
        assert.deepEqual(new UndefExtractor(metadata).extractRaw("x"), []);
    });

    it("returns [] when visit throws (visitor bug, defensively contained)", () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return { fake: "tree" };
            }
            protected createVisitor(): ExtractionVisitor {
                return {
                    visit(): unknown {
                        throw new Error("visitor crash");
                    },
                    get symbols(): MimeSymbol[] {
                        return [];
                    },
                };
            }
        }
        const e = new Extractor(metadata);
        assert.deepEqual(e.extractRaw("content"), []);
    });

    it("calls visit on the tree returned by parseTree", () => {
        let visitedTree: unknown = null;
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return { tag: "root" };
            }
            protected createVisitor(): ExtractionVisitor {
                return {
                    visit(tree: unknown): unknown {
                        visitedTree = tree;
                        return null;
                    },
                    get symbols(): MimeSymbol[] {
                        return [];
                    },
                };
            }
        }
        const e = new Extractor(metadata);
        e.extractRaw("content");
        assert.deepEqual(visitedTree, { tag: "root" });
    });

    it("inherits BaseHandler symbolsRaw/preview behavior via extractRaw output", async () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return { fake: "tree" };
            }
            protected createVisitor(): ExtractionVisitor {
                return visitorReturning([
                    { name: "Foo", kind: "class", line: 1, endLine: 10 },
                ]);
            }
        }
        const e = new Extractor(metadata);
        assert.equal(await e.symbolsRaw("anything"), "class Foo [1-10]");
        const preview = (await e.preview("anything")) as SymbolPreview;
        assert.equal(preview.kind, "symbols");
        assert.deepEqual(
            [...preview.symbols],
            [{ name: "Foo", kind: "class", line: 1, endLine: 10 }],
        );
    });
});

describe("AntlrExtractor.deepJson — duck-typed ANTLR parse tree walk", () => {
    // Mock the antlr4ng parse-tree shape: ParserRuleContext with start/stop
    // and children; TerminalNode with `symbol`.
    class Compilation_unitContext {
        readonly start = { line: 1 };
        readonly stop = { line: 5 };
        readonly children: unknown[];
        constructor(children: unknown[]) { this.children = children; }
    }
    class Class_declarationContext {
        readonly start = { line: 2 };
        readonly stop = { line: 4 };
        readonly children: unknown[];
        constructor(children: unknown[]) { this.children = children; }
    }
    function term(text: string, line: number): unknown {
        return { symbol: { line, text, type: 1 } };
    }

    it("walks rule contexts emitting type from constructor.name (stripped of Context)", async () => {
        const fakeTree = new Compilation_unitContext([
            new Class_declarationContext([term("class", 2), term("Foo", 2)]),
        ]);
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return fakeTree; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        const tree = await e.deepJson("anything") as { type: string; line: number; endLine: number; children?: unknown[] };
        assert.equal(tree.type, "compilation_unit");
        assert.equal(tree.line, 1);
        assert.equal(tree.endLine, 5);
        assert.ok(Array.isArray(tree.children));
        const classCtx = (tree.children![0] as { type: string });
        assert.equal(classCtx.type, "class_declaration");
    });

    it("walks terminal nodes as { type, line, endLine, text }", async () => {
        const fakeTree = new Compilation_unitContext([term("hello", 3)]);
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return fakeTree; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        const tree = await e.deepJson("anything") as { children: Array<{ type: string; text: string; line: number }> };
        const leaf = tree.children[0];
        assert.equal(leaf.text, "hello");
        assert.equal(leaf.line, 3);
        // Short token text becomes the type for jsonpath/xpath filtering ease.
        assert.equal(leaf.type, "hello");
    });

    it("returns null when parseTree throws", async () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { throw new Error("parse err"); }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        assert.equal(await e.deepJson("malformed"), null);
    });

    it("returns null for binary content", async () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return new Compilation_unitContext([]); }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        assert.equal(await e.deepJson(new Uint8Array([1, 2, 3])), null);
    });
});
