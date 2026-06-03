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
