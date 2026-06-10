// Issue #18: 0.15 P2 — MimeSymbol v2: container (qualified path) + column
// positions. https://github.com/plurnk/plurnk-mimetypes/issues/18
//
// Load-bearing claims, restated as testable contracts:
//
//   C1. MimeSymbol carries 1-indexed column/endColumn and a `container`
//       qualified path; container is ABSENT (not "") on top-level symbols.
//       The fields flow through process()'s symbols channel untouched.
//   C2. Containers nest by dotted path of enclosing emitted symbols —
//       grounded here on the python reference mapping (per-language
//       assertions live in each mapping's own test file).
//   C3. The ANTLR mixin (withExtractor) supports the same contract:
//       addSymbol stamps 1-indexed columns and the active gateContainer
//       path; gateContainer scopes nest and unwind.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import TreeSitterLanguageHandler from "../treesitter/handler.ts";
import { lookupTreeSitterLanguage } from "../treesitter/registry.ts";
import { withExtractor } from "../withExtractor.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Registry } from "../types.ts";

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) {
            if (ext.startsWith(".")) byExtension.set(ext.toLowerCase(), info.mimetype);
        }
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap };
}

describe("Issue #18 — C1: container + columns flow through the symbols channel", () => {
    it("process() returns symbols with container and 1-indexed columns verbatim", async () => {
        class V2Handler extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [
                    { name: "Outer", kind: "class", line: 1, endLine: 9, column: 1, endColumn: 2 },
                    { name: "run", kind: "method", line: 2, endLine: 4, column: 5, endColumn: 6, container: "Outer" },
                ];
            }
        }
        const info: HandlerInfo = {
            mimetype: "text/x-v2",
            glyph: "🧪",
            packageName: "@plurnk/x",
            extensions: [".v2"],
            binary: false,
            source: "package",
        };
        const m = new Mimetypes({
            discovery: makeDiscovery([info]),
            loader: async () => ({ default: V2Handler }),
        });
        const r = await m.process({ path: "a.v2", content: "x" }, { channels: ["symbols"] });
        assert.equal(r.symbols![0].container, undefined, "top-level symbol has NO container key semantics");
        assert.equal(r.symbols![1].container, "Outer");
        assert.equal(r.symbols![1].column, 5);
        assert.equal(r.symbols![1].endColumn, 6);
    });
});

describe("Issue #18 — C2: reference mapping nests containers by dotted path", () => {
    it("python: Outer.Inner.deep chain with absent container at top level", async () => {
        const entry = lookupTreeSitterLanguage("text/x-python")!;
        const h = new TreeSitterLanguageHandler(
            { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions },
            entry,
        );
        const src = "class Outer:\n    class Inner:\n        def deep(self):\n            pass\n";
        const syms = await h.extractRaw(src);
        const outer = syms.find((s) => s.name === "Outer")!;
        const inner = syms.find((s) => s.name === "Inner")!;
        const deep = syms.find((s) => s.name === "deep")!;
        assert.equal("container" in outer, false, "container key absent, not empty");
        assert.equal(inner.container, "Outer");
        assert.equal(deep.container, "Outer.Inner");
        assert.equal(outer.column, 1);
        assert.equal(deep.line, 3);
        assert.equal(deep.column, 9);
    });
});

describe("Issue #18 — C3: withExtractor mixin supports container + columns", () => {
    class FakeVisitorBase {
        visit(_tree: unknown): unknown { return null; }
        visitChildren(node: unknown): unknown {
            // Minimal antlr-shaped recursion: the fake "tree" carries a
            // children-visitor callback the test drives.
            const n = node as { onChildren?: () => void };
            n.onChildren?.();
            return null;
        }
    }

    interface FakeCtx {
        start: { line: number; column: number };
        stop: { line: number; column: number; text: string };
        onChildren?: () => void;
    }

    function fakeCtx(line: number, column: number, stopLine: number, stopColumn: number, stopText: string): FakeCtx {
        return {
            start: { line, column },
            stop: { line: stopLine, column: stopColumn, text: stopText },
        };
    }

    it("addSymbol stamps 1-indexed columns from the 0-indexed antlr positions", () => {
        const V = withExtractor(FakeVisitorBase);
        const v = new V();
        v.addSymbol("function", "f", fakeCtx(3, 4, 5, 0, "end") as never);
        const [sym] = v.symbols;
        assert.equal(sym.line, 3);
        assert.equal(sym.column, 5, "antlr column 4 → 1-indexed 5");
        assert.equal(sym.endLine, 5);
        assert.equal(sym.endColumn, 4, "stop col 0 + len('end') + 1");
    });

    it("gateContainer scopes nest, apply to addSymbol, and unwind", () => {
        const V = withExtractor(FakeVisitorBase);
        const v = new V();
        v.addSymbol("class", "Outer", fakeCtx(1, 0, 9, 0, "}") as never);
        v.gateContainer("Outer", {
            ...fakeCtx(1, 0, 9, 0, "}"),
            onChildren: () => {
                v.addSymbol("method", "shallow", fakeCtx(2, 4, 3, 4, "}") as never);
                v.gateContainer("Inner", {
                    ...fakeCtx(4, 4, 8, 4, "}"),
                    onChildren: () => {
                        v.addSymbol("method", "deep", fakeCtx(5, 8, 6, 8, "}") as never);
                    },
                } as never);
            },
        } as never);
        v.addSymbol("function", "after", fakeCtx(10, 0, 11, 0, "}") as never);

        const byName = new Map(v.symbols.map((s) => [s.name, s]));
        assert.equal(byName.get("Outer")!.container, undefined);
        assert.equal(byName.get("shallow")!.container, "Outer");
        assert.equal(byName.get("deep")!.container, "Outer.Inner");
        assert.equal(byName.get("after")!.container, undefined, "container unwinds after gate");
    });
});
