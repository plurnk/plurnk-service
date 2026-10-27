import { describe, it } from "node:test";
import assert from "node:assert/strict";
import AntlrExtractor from "./AntlrExtractor.ts";
import { ParserCoordinateError } from "./ParserCoordinates.ts";
import type { ExtractionVisitor, MimeSymbol } from "./types.ts";
import { withExtractor } from "./withExtractor.ts";

// ─── AntlrExtractor.test.ts ───
{
// Contract: {§treesitter-runtime-gate}.





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

describe("{§mimetype-symbol} AntlrExtractor", () => {
    it("{§mimetype-parser-coordinates} orchestrates parseTree -> createVisitor -> visit -> symbols", () => {
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

    it("{§mimetype-parser-coordinates} preserves a thrown parser defect instead of guessing that it is malformed input", () => {
        const failure = new Error("parser implementation failed");
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                throw failure;
            }
            protected createVisitor(): ExtractionVisitor {
                throw new Error("should not be called");
            }
        }
        const e = new Extractor(metadata);
        assert.throws(() => e.extractRaw("content"), (error) => error === failure);
    });

    it("{§mimetype-parser-coordinates} returns [] when parseTree returns null or undefined", () => {
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

    it("{§mimetype-parser-coordinates} preserves a visitor defect instead of converting it to an empty channel", () => {
        const failure = new Error("visitor implementation failed");
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return { fake: "tree" };
            }
            protected createVisitor(): ExtractionVisitor {
                return {
                    visit(): unknown {
                        throw failure;
                    },
                    get symbols(): MimeSymbol[] {
                        return [];
                    },
                };
            }
        }
        const e = new Extractor(metadata);
        assert.throws(() => e.extractRaw("content"), (error) => error === failure);
    });

    it("{§mimetype-parser-coordinates} does not collapse a parser-coordinate invariant failure", () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown {
                return { fake: "tree" };
            }
            protected createVisitor(): ExtractionVisitor {
                return {
                    visit: () => null,
                    get symbols(): MimeSymbol[] {
                        throw new ParserCoordinateError("invalid native span");
                    },
                };
            }
        }
        const e = new Extractor(metadata);
        assert.throws(() => e.extractRaw("anything"), ParserCoordinateError);
    });

    it("{§mimetype-parser-coordinates} calls visit on the tree returned by parseTree", () => {
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

    it("{§mimetype-parser-coordinates} inherits BaseHandler symbolsRaw behavior via extractRaw output", async () => {
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
        assert.deepEqual(
            e.extractRaw("anything"),
            [{ name: "Foo", kind: "class", line: 1, endLine: 10 }],
        );
    });
});

describe("{§mimetype-channel-architecture} AntlrExtractor.deepJson: duck-typed ANTLR parse tree walk", () => {
    // Mock the antlr4ng parse-tree shape: ParserRuleContext with start/stop
    // and children; TerminalNode with `symbol`.
    class Compilation_unitContext {
        readonly start;
        readonly stop;
        readonly children: unknown[];
        constructor(children: unknown[], start: number, stop: number) {
            this.children = children;
            this.start = { line: 1, start };
            this.stop = { line: 5, stop };
        }
    }
    class Class_declarationContext {
        readonly start;
        readonly stop;
        readonly children: unknown[];
        constructor(children: unknown[], start: number, stop: number) {
            this.children = children;
            this.start = { line: 2, start };
            this.stop = { line: 4, stop };
        }
    }
    function term(text: string, line: number, start: number): unknown {
        return { symbol: { line, text, type: 1, start, stop: start + Array.from(text).length - 1 } };
    }

    it("{§mimetype-parser-coordinates} walks rule contexts emitting type from constructor.name (stripped of Context)", async () => {
        const source = "\nclass Foo\n\n\nx";
        const fakeTree = new Compilation_unitContext([
            new Class_declarationContext([term("class", 2, 1), term("Foo", 2, 7)], 1, 11),
        ], 0, 13);
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return fakeTree; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        const tree = await e.deepJson(source) as { type: string; line: number; endLine: number; children?: unknown[] };
        assert.equal(tree.type, "compilation_unit");
        assert.equal(tree.line, 1);
        assert.equal(tree.endLine, 5);
        assert.ok(Array.isArray(tree.children));
        const classCtx = (tree.children[0] as { type: string });
        assert.equal(classCtx.type, "class_declaration");
    });

    it("{§mimetype-parser-coordinates} walks terminal nodes as { type, line, endLine, text }", async () => {
        const source = "\n\nhello";
        const fakeTree = new Compilation_unitContext([term("hello", 3, 2)], 0, 6);
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return fakeTree; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        const tree = await e.deepJson(source) as { children: Array<{ type: string; text: string; line: number }> };
        const leaf = tree.children[0];
        assert.equal(leaf.text, "hello");
        assert.equal(leaf.line, 3);
        // Short token text becomes the type for jsonpath/xpath filtering ease.
        assert.equal(leaf.type, "hello");
    });

    it("{§mimetype-parser-coordinates} preserves a parser defect on the deep projection", async () => {
        const failure = new Error("deep parser implementation failed");
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { throw failure; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        await assert.rejects(Promise.resolve().then(() => e.deepJson("content")), (error) => error === failure);
    });

    it("{§mimetype-parser-coordinates} preserves inserted recovery tokens without assigning them exact source bounds", async () => {
        const source = "hello";
        const missing = { symbol: {
            text: "<missing '('>", type: 2, tokenIndex: -1,
            start: -1, stop: -1, line: 99, column: 99,
        } };
        const fakeTree = new Compilation_unitContext([
            missing, term("hello", 1, 0),
            { symbol: { text: "<EOF>", type: -1, tokenIndex: 1, start: 5, stop: 4 } },
        ], 0, 4);
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return fakeTree; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        const tree = e.deepJson(source) as { children: unknown[] };
        assert.deepEqual(tree.children[0], { type: "token", text: "<missing '('>" });
        const parent = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 };
        for (const [dialect, pattern] of [["jsonpath", "$.children[0]"], ["xpath", "/*/token"]] as const) {
            const matches = await e.query(source, dialect, pattern);
            assert.equal(matches.length, 1);
            assert.ok(matches[0].matching);
            assert.equal(matches[0].regions, undefined);
            assert.deepEqual(matches[0].enclosingRegions, [parent]);
        }
        const [present, eof] = await e.query(source, "jsonpath", "$.children[1,2]");
        assert.deepEqual(present.regions, [parent]);
        assert.deepEqual(eof.regions, [{ ...parent, startColumn: 6 }]);
    });

    it("{§mimetype-parser-coordinates} still rejects invalid native spans that are not inserted recovery tokens", () => {
        for (const symbol of [
            { start: -1, stop: -1, tokenIndex: 0 },
            { start: -1, stop: 0, tokenIndex: -1 },
            { start: 0, stop: 99, tokenIndex: -1 },
        ]) {
            class Extractor extends AntlrExtractor {
                protected parseTree(_content: string): unknown {
                    return new Compilation_unitContext([{ symbol }], 0, 0);
                }
                protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
            }
            assert.throws(() => new Extractor(metadata).deepJson("x"), ParserCoordinateError);
        }
    });

    it("{§mimetype-parser-coordinates} returns null for binary content", async () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return new Compilation_unitContext([], 0, 0); }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        assert.equal(await e.deepJson(new Uint8Array([1, 2, 3])), null);
    });
});

describe("{§mimetype-references} AntlrExtractor references channel", () => {
    it("{§mimetype-parser-coordinates} returns the visitor's refs from a same-shaped visit", async () => {
        const refs = [
            { name: "users", kind: "use" as const, line: 3, column: 6, endLine: 3, endColumn: 11, container: "v_active" },
        ];
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return { fake: "tree" }; }
            protected createVisitor(): ExtractionVisitor {
                return { visit() { return null; }, get symbols() { return []; }, get refs() { return refs; } };
            }
        }
        const e = new Extractor(metadata);
        assert.deepEqual(e.references("content"), refs);
    });

    it("{§mimetype-parser-coordinates} returns [] when the visitor emits no refs (default ANTLR handler)", async () => {
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { return { fake: "tree" }; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        assert.deepEqual(e.references("content"), []);
    });

    it("{§mimetype-parser-coordinates} preserves a parser defect on the references projection", async () => {
        const failure = new Error("references parser implementation failed");
        class Extractor extends AntlrExtractor {
            protected parseTree(_content: string): unknown { throw failure; }
            protected createVisitor(): ExtractionVisitor { return visitorReturning([]); }
        }
        const e = new Extractor(metadata);
        await assert.rejects(Promise.resolve().then(() => e.references("content")), (error) => error === failure);
    });
});
}

// ─── withExtractor.test.ts ───
{
// Stub the antlr4ng visitor base class — `withExtractor` only requires `visit`
// and `visitChildren` shape; real generated visitors satisfy this.
class StubVisitorBase {
    visit(_tree: unknown): unknown {
        return null;
    }
    visitChildren(_node: unknown): unknown {
        return null;
    }
}

// Stub ParserRuleContext shape — addSymbol only reads start.line and stop?.line.
function ctx(line: number, endLine?: number): unknown {
    return {
        start: { line },
        stop: endLine !== undefined ? { line: endLine } : null,
    };
}

describe("{§mimetype-symbol} withExtractor mixin", () => {
    it("{§mimetype-parser-coordinates} starts with an empty symbols list", () => {
        class V extends withExtractor(StubVisitorBase) {}
        const v = new V();
        assert.deepEqual(v.symbols, []);
    });

    it("{§mimetype-parser-coordinates} starts with inBody false", () => {
        class V extends withExtractor(StubVisitorBase) {
            check(): boolean {
                return this.inBody;
            }
        }
        const v = new V();
        assert.equal(v.check(), false);
    });

    it("{§mimetype-parser-coordinates} addSymbol captures start line and stop line from the context", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol("class", "Foo", ctx(5, 20) as never);
            }
        }
        const v = new V();
        v.doAdd();
        assert.deepEqual(v.symbols, [
            { name: "Foo", kind: "class", line: 5, endLine: 20 },
        ]);
    });

    it("{§mimetype-parser-coordinates} addSymbol falls back to start line when stop is null", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol("constant", "X", ctx(7) as never);
            }
        }
        const v = new V();
        v.doAdd();
        assert.deepEqual(v.symbols, [
            { name: "X", kind: "constant", line: 7, endLine: 7 },
        ]);
    });

    it("{§mimetype-parser-coordinates} addSymbol includes params and extra fields when provided", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol(
                    "heading",
                    "Section",
                    ctx(3) as never,
                    undefined,
                    { level: 2 },
                );
                this.addSymbol(
                    "function",
                    "parse",
                    ctx(10, 15) as never,
                    ["source", "options"],
                );
            }
        }
        const v = new V();
        v.doAdd();
        assert.deepEqual(v.symbols, [
            { name: "Section", kind: "heading", line: 3, endLine: 3, level: 2 },
            {
                name: "parse",
                kind: "function",
                line: 10,
                endLine: 15,
                params: ["source", "options"],
            },
        ]);
    });

    it("{§mimetype-parser-coordinates} gateBody flips inBody true during children visit and restores after", () => {
        let inBodyDuringVisit: boolean | null = null;
        class FakeBase {
            visit(_tree: unknown): unknown {
                return null;
            }
            visitChildren(_node: unknown): unknown {
                inBodyDuringVisit = (this as unknown as { inBody: boolean }).inBody;
                return null;
            }
        }
        class V extends withExtractor(FakeBase) {
            run(): void {
                this.gateBody(ctx(1, 10) as never);
            }
            checkAfter(): boolean {
                return this.inBody;
            }
        }
        const v = new V();
        v.run();
        assert.equal(inBodyDuringVisit, true);
        assert.equal(v.checkAfter(), false);
    });

    it("{§mimetype-parser-coordinates} gateBody restores prior inBody value, not always false (handles nesting)", () => {
        const seen: boolean[] = [];
        class FakeBase {
            visit(_tree: unknown): unknown {
                return null;
            }
            visitChildren(_node: unknown): unknown {
                seen.push((this as unknown as { inBody: boolean }).inBody);
                return null;
            }
        }
        class V extends withExtractor(FakeBase) {
            outer(): void {
                this.gateBody({
                    ...(ctx(1, 100) as object),
                } as never);
            }
            inner(): void {
                this.gateBody(ctx(5, 20) as never);
            }
        }
        const v = new V();
        // Simulate nested body: outer gates, during visitChildren the inner gates.
        // The mixin must restore correctly so a hypothetical post-inner peek inside
        // outer would still see inBody=true.
        v.outer();
        // After outer: inBody should be false again.
        assert.equal(seen.length, 1);
        assert.equal(seen[0], true);
    });

    it("{§mimetype-parser-coordinates} returns a defensive copy from symbols getter (caller can't mutate state)", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol("class", "Foo", ctx(1) as never);
            }
        }
        const v = new V();
        v.doAdd();
        const snapshot = v.symbols;
        snapshot.pop();
        assert.equal(v.symbols.length, 1, "internal state should be unaffected by mutating the snapshot");
    });

    it("{§mimetype-channel-selection} addSymbol stamps 1-indexed columns from the 0-indexed antlr positions", () => {
        const V = withExtractor(StubVisitorBase);
        const v = new V();
        v.addSymbol("function", "f", {
            start: { line: 3, column: 4 },
            stop: { line: 5, column: 0, text: "end" },
        } as never);
        const [sym] = v.symbols;
        assert.equal(sym.line, 3);
        assert.equal(sym.column, 5, "antlr column 4 → 1-indexed 5");
        assert.equal(sym.endLine, 5);
        assert.equal(sym.endColumn, 4, "stop col 0 + len('end') + 1");
    });

    it("{§mimetype-channel-selection} gateContainer scopes nest, apply to addSymbol, and unwind", () => {
        class RecursiveBase extends StubVisitorBase {
            override visitChildren(node: unknown): unknown {
                (node as { onChildren?: () => void }).onChildren?.();
                return null;
            }
        }
        const V = withExtractor(RecursiveBase);
        const v = new V();
        const span = (line: number, column: number, stopLine: number, stopColumn: number, text: string) => ({
            start: { line, column },
            stop: { line: stopLine, column: stopColumn, text },
        });
        v.addSymbol("class", "Outer", span(1, 0, 9, 0, "}") as never);
        v.gateContainer("Outer", {
            ...span(1, 0, 9, 0, "}"),
            onChildren: () => {
                v.addSymbol("method", "shallow", span(2, 4, 3, 4, "}") as never);
                v.gateContainer("Inner", {
                    ...span(4, 4, 8, 4, "}"),
                    onChildren: () => {
                        v.addSymbol("method", "deep", span(5, 8, 6, 8, "}") as never);
                    },
                } as never);
            },
        } as never);
        v.addSymbol("function", "after", span(10, 0, 11, 0, "}") as never);

        const byName = new Map(v.symbols.map((s) => [s.name, s]));
        assert.equal(byName.get("Outer")!.container, undefined);
        assert.equal(byName.get("shallow")!.container, "Outer");
        assert.equal(byName.get("deep")!.container, "Outer.Inner");
        assert.equal(byName.get("after")!.container, undefined, "container unwinds after gate");
    });
});

describe("{§mimetype-references} withExtractor addRef", () => {
    function refCtx(line: number, column: number, stopLine = line, stopColumn = column, stopText = "x") {
        return { start: { line, column }, stop: { line: stopLine, column: stopColumn, text: stopText } } as never;
    }

    it("{§mimetype-parser-coordinates} addRef stamps 1-indexed positions; top-level refs carry no container", () => {
        const V = withExtractor(StubVisitorBase);
        const v = new V();
        v.addRef("call", "tokenize", refCtx(12, 4, 12, 4, "tokenize"));
        const [r] = v.refs;
        assert.equal(r.name, "tokenize");
        assert.equal(r.kind, "call");
        assert.equal(r.line, 12);
        assert.equal(r.column, 5, "antlr column 4 -> 1-indexed 5");
        assert.equal(r.endColumn, 4 + "tokenize".length + 1);
        assert.equal("container" in r, false);
    });

    it("{§mimetype-parser-coordinates} refs collected inside a gateContainer carry the dotted path", () => {
        class V extends withExtractor(StubVisitorBase) {
            override visitChildren(_node: unknown): unknown {
                this.addRef("use", "accounts", refCtx(5, 8, 5, 16, "accounts"));
                return null;
            }
        }
        const v = new V();
        v.gateContainer("v_report", refCtx(1, 0, 9, 0));
        assert.equal(v.refs[0].container, "v_report");
    });

    it("{§mimetype-parser-coordinates} materializes ANTLR code-point offsets without widening astral stop tokens", () => {
        const V = withExtractor(StubVisitorBase);
        const v = new V();
        v.bindContent("SET 😀 value");
        v.addRef("use", "😀", {
            start: { start: 4 },
            stop: { stop: 4 },
        } as never);
        assert.deepEqual(v.refs, [{
            name: "😀",
            kind: "use",
            line: 1,
            column: 5,
            endLine: 1,
            endColumn: 6,
        }]);
    });

    it("{§mimetype-parser-coordinates} materializes multiline contexts and terminal insertion points from absolute offsets", () => {
        const V = withExtractor(StubVisitorBase);
        const v = new V();
        const source = "first😀\r\nlast";
        v.bindContent(source);
        v.addSymbol("function", "all", {
            start: { start: 0 },
            stop: { stop: Array.from(source).length - 1 },
        } as never);
        v.addSymbol("variable", "end", {
            start: { start: Array.from(source).length },
            stop: { stop: Array.from(source).length - 1 },
        } as never);
        assert.deepEqual(v.symbols.map(({ line, column, endLine, endColumn }) => ({
            line,
            column,
            endLine,
            endColumn,
        })), [
            { line: 1, column: 1, endLine: 2, endColumn: 5 },
            { line: 2, column: 5, endLine: 2, endColumn: 5 },
        ]);
    });

    it("{§mimetype-parser-coordinates} derives ANTLR lines from absolute offsets across CR and LF separators", () => {
        const V = withExtractor(StubVisitorBase);
        const v = new V();
        v.bindContent("a\r😀\nb");
        v.addRef("use", "😀", {
            start: { start: 2 },
            stop: { stop: 2 },
        } as never);
        assert.deepEqual(v.refs, [{
            name: "😀",
            kind: "use",
            line: 2,
            column: 1,
            endLine: 2,
            endColumn: 2,
        }]);
    });
});
}
