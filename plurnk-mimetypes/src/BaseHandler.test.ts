import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import type { MimeSymbol } from "./types.ts";
import { UnsupportedDialectError } from "./QueryError.ts";

// ─── BaseHandler.test.ts ───
{
// Contract: {§mimetype-handler-contract}.




const metadata = {
    mimetype: "text/plain",
    glyph: "📄",
    extensions: [".txt"] as const,
};

describe("{§mimetype-handler-contract} BaseHandler", () => {
    it("{§mimetype-content} structural evidence addresses its text source even when a readable sibling exists", async () => {
        class Projected extends BaseHandler {
            override content(): string { return "a different readable projection"; }
            override deepJson(): unknown { return { type: "node", line: 2, endLine: 2, name: "source" }; }
        }
        const h = new Projected(metadata);
        const expected = [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 7 }];
        for (const [dialect, pattern] of [["xpath", "//node"], ["jsonpath", "$"]] as const) {
            const matches = await h.query("before\nsource\nafter", dialect, pattern);
            assert.equal(matches.length, 1);
            assert.equal(matches[0].regions, undefined, "line-only provenance is enclosing context");
            assert.deepEqual(matches[0].enclosingRegions, expected);
            const binary = await h.query(new TextEncoder().encode("before\nsource\nafter"), dialect, pattern);
            assert.equal(binary[0].regions, undefined, "bytes do not imply a text source map");
        }
        const computed = await h.query("before\nsource\nafter", "xpath", "count(//node)");
        assert.equal(computed[0].regions, undefined, "a computed scalar has no source node");
    });
    it("{§mimetype-handler-contract} exposes metadata on the instance", () => {
        const h = new BaseHandler(metadata);
        assert.equal(h.mimetype, "text/plain");
        assert.equal(h.glyph, "📄");
        assert.deepEqual([...h.extensions], [".txt"]);
    });

    it("{§mimetype-handler-contract} freezes the extensions array", () => {
        const h = new BaseHandler(metadata);
        assert.ok(Object.isFrozen(h.extensions));
    });

    it("{§mimetype-handler-contract} returns an empty array from extractRaw by default", () => {
        const h = new BaseHandler(metadata);
        assert.deepEqual(h.extractRaw("anything"), []);
    });

    it("{§mimetype-handler-contract} returns an empty string from symbolsRaw when extractRaw is empty", async () => {
        const h = new BaseHandler(metadata);
        assert.equal(await h.symbolsRaw("anything"), "");
    });

    it("{§mimetype-handler-contract} treats validate as a no-op by default", () => {
        const h = new BaseHandler(metadata);
        assert.doesNotThrow(() => h.validate("anything"));
    });

    it("{§mimetype-handler-contract} reports no parser recovery evidence by default", () => {
        const h = new BaseHandler(metadata);
        assert.equal(h.parseIssues("anything"), 0);
    });

    it("{§mimetype-handler-contract} declares no effective projection configuration by default", () => {
        const h = new BaseHandler(metadata);
        assert.equal(h.projectionConfiguration(), "");
    });

    it("{§mimetype-references} returns an empty references list by default", async () => {
        const h = new BaseHandler(metadata);
        assert.deepEqual(await h.references("anything"), []);
    });

    it("{§mimetype-handler-contract} renders symbolsRaw from a subclass's extractRaw via format", async () => {
        class TestHandler extends BaseHandler {
            override extractRaw(_content: string): MimeSymbol[] {
                return [{ name: "Foo", kind: "class", line: 1, endLine: 10 }];
            }
        }
        const h = new TestHandler(metadata);
        assert.equal(await h.symbolsRaw("anything"), "class Foo [1-10]");
    });

    it("{§mimetype-handler-contract} exposes extractRaw output as the structured symbols surface", async () => {
        class TestHandler extends BaseHandler {
            override extractRaw(_content: string): MimeSymbol[] {
                return [
                    { name: "A", kind: "class", line: 1, endLine: 5 },
                    { name: "B", kind: "class", line: 10, endLine: 15 },
                ];
            }
        }
        const h = new TestHandler(metadata);
        assert.deepEqual(
            h.extractRaw("anything"),
            [
                { name: "A", kind: "class", line: 1, endLine: 5 },
                { name: "B", kind: "class", line: 10, endLine: 15 },
            ],
        );
    });
});
}

// ─── BaseHandler.channels.test.ts ───
{
// Contracts: {§mimetype-channel-architecture}, {§mimetype-channel-selection}.





// A canonical structural-tree-emitting handler to exercise the universal
// dispatch paths. Stands in for any handler whose deepJson() returns a
// {type, line, endLine, children} tree (tree-sitter handlers, ANTLR handlers,
// markdown handler, etc.).
class FakeTreeHandler extends BaseHandler {
    override extractRaw(_content: string | Uint8Array): MimeSymbol[] {
        return [
            { name: "Root", kind: "module", line: 1, endLine: 10 },
            { name: "method_a", kind: "method", line: 2, endLine: 4 },
            { name: "method_b", kind: "method", line: 6, endLine: 8 },
        ];
    }
    override deepJson(_content: string | Uint8Array): unknown {
        return {
            type: "module",
            line: 1,
            endLine: 10,
            name: "Root",
            children: [
                { type: "method", line: 2, endLine: 4, name: "method_a" },
                { type: "method", line: 6, endLine: 8, name: "method_b" },
            ],
        };
    }
}

// A canonical JSON-shaped handler — its deepJson() returns the parsed value
// directly. Stands in for application-json, YAML, TOML, CSV.
class FakeJsonHandler extends BaseHandler {
    override deepJson(_content: string | Uint8Array): unknown {
        return {
            server: { host: "localhost", port: 8080 },
            users: [
                { name: "Alice", role: "admin" },
                { name: "Bob", role: "user" },
            ],
        };
    }
}

const meta = { mimetype: "text/x-test", glyph: "🧪", extensions: [".test"] as const };

describe("{§mimetype-channel-architecture} BaseHandler supplies deep projections", () => {
    // Mimetypes.test.ts covers ProcessResult. This suite enforces the
    // per-handler contract: BaseHandler.deepJson() and BaseHandler.deepXml()
    // provide defaults, so handlers participate without special-casing.
    it("{§mimetype-handler-contract} BaseHandler exposes deepJson() returning null by default", () => {
        const h = new BaseHandler(meta);
        const result = h.deepJson("anything");
        assert.equal(result, null);
    });

    it("{§mimetype-handler-contract} BaseHandler exposes deepXml() returning empty string when deepJson is null", async () => {
        const h = new BaseHandler(meta);
        assert.equal(await h.deepXml("anything"), "");
    });

    it("{§mimetype-handler-contract} Handler-supplied deepJson() automatically yields a non-empty deepXml() via the framework projection", async () => {
        const h = new FakeTreeHandler(meta);
        const xml = await h.deepXml("anything");
        assert.ok(xml.includes("<module"), "deep-xml should contain the projected root element");
        assert.ok(xml.includes("<method"), "deep-xml should contain the projected child elements");
    });
});

describe("{§mimetype-channel-architecture} cross-dispatch matrix", () => {
    // The cross-dispatch path most prone to silent omission: queries on the
    // "wrong" dialect for the source mimetype. xpath on JSON, jsonpath on XML,
    // and both on code must follow the universal dispatch contract.

    it("{§mimetype-handler-contract} xpath on a tree-shaped entry returns matches via the projected deep-xml", async () => {
        const h = new FakeTreeHandler(meta);
        const r = await h.query("anything", "xpath", "//method");
        assert.equal(r.length, 2, `expected 2 method nodes, got ${r.length}`);
        const texts = r.map((m) => String(m.matched));
        assert.ok(texts.some((t) => t.includes("method_a")), "method_a should appear in xpath results");
        assert.ok(texts.some((t) => t.includes("method_b")), "method_b should appear in xpath results");
    });

    it("{§mimetype-handler-contract} xpath on a JSON-shaped entry returns matches via the projected deep-xml", async () => {
        const h = new FakeJsonHandler(meta);
        // The framework projects parsed JSON values into <root><server>...
        // structure; xpath against that finds keys as elements.
        const r = await h.query("anything", "xpath", "//host");
        assert.equal(r.length, 1, "host element should be reachable via xpath on JSON");
        assert.ok(String(r[0].matched).includes("localhost"));
    });

    it("{§mimetype-handler-contract} jsonpath on a tree-shaped entry returns matches via deep-json", async () => {
        const h = new FakeTreeHandler(meta);
        const r = await h.query("anything", "jsonpath", "$..children[?(@.type=='method')]");
        assert.equal(r.length, 2);
    });

    it("{§mimetype-handler-contract} jsonpath on a JSON-shaped entry returns matches via deep-json", async () => {
        const h = new FakeJsonHandler(meta);
        const r = await h.query("anything", "jsonpath", "$.server.host");
        assert.equal(r.length, 1);
        assert.equal(r[0].matched, "localhost");
    });

    it("{§mimetype-handler-contract} xpath throws UnsupportedDialectError on handlers with no deepJson", async () => {
        const h = new BaseHandler(meta);
        await assert.rejects(
            () => h.query("anything", "xpath", "//foo"),
            (err: unknown) => (err as Error).name === "UnsupportedDialectError",
        );
    });
});

describe("{§mimetype-channel-architecture} deep-xml is congruent with deep-json", () => {
    // The two views describe the same tree. A jsonpath query for X should
    // be answerable by an equivalent xpath query against the same entry.

    it("{§mimetype-handler-contract} filtering by type yields the same number of matches on either dialect", async () => {
        const h = new FakeTreeHandler(meta);
        const viaJson = await h.query("anything", "jsonpath", "$..children[?(@.type=='method')]");
        const viaXml = await h.query("anything", "xpath", "//method");
        assert.equal(
            viaJson.length, viaXml.length,
            "deep-json and deep-xml views must surface the same nodes",
        );
    });

    it("{§mimetype-handler-contract} navigating by name yields the same content on either dialect", async () => {
        const h = new FakeJsonHandler(meta);
        const viaJson = await h.query("anything", "jsonpath", "$.server.host");
        const viaXml = await h.query("anything", "xpath", "//server/host");
        assert.equal(viaJson.length, 1);
        assert.equal(viaXml.length, 1);
        assert.equal(viaJson[0].matched, "localhost");
        assert.equal(String(viaXml[0].matched), "<host>localhost</host>");
    });
});
}

// ─── BaseHandler.query.lines.test.ts ───
{
// Contract: {§mimetype-query}.





// Stand-in for any handler whose deepJson() returns a tree with source-line
// metadata — covers tree-sitter, ANTLR, markdown, code handlers.
class FakeTreeHandler extends BaseHandler {
    override extractRaw(): MimeSymbol[] {
        return [
            { name: "Root", kind: "module", line: 1, endLine: 100 },
            { name: "fn_a", kind: "function", line: 42, endLine: 50 },
            { name: "fn_b", kind: "function", line: 73, endLine: 88 },
        ];
    }
    override deepJson(): unknown {
        return {
            type: "module",
            line: 1,
            endLine: 100,
            name: "Root",
            children: [
                { type: "function", line: 42, endLine: 50, name: "fn_a" },
                { type: "function", line: 73, endLine: 88, name: "fn_b" },
            ],
        };
    }
}

const meta = { mimetype: "text/x-test", glyph: "🧪", extensions: [".test"] as const };
const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");

describe("{§mimetype-query} Q1: xpath QueryMatch.line reflects pk:line on element", () => {
    it("{§mimetype-handler-contract} element match returns the source line from pk:line", async () => {
        const h = new FakeTreeHandler(meta);
        const matches = await h.query(source, "xpath", "//function");
        assert.equal(matches.length, 2);
        // The two function elements have pk:line="42" and pk:line="73".
        const lines = matches.map((m) => m.enclosingRegions![0].startLine).toSorted((a, b) => a - b);
        assert.deepEqual(lines, [42, 73]);
    });

    it("{§mimetype-handler-contract} single match returns the right line", async () => {
        const h = new FakeTreeHandler(meta);
        const matches = await h.query(
            source,
            "xpath",
            "//function[name='fn_b']",
        );
        assert.equal(matches.length, 1);
        assert.equal(matches[0].enclosingRegions![0].startLine, 73);
    });

    it("{§mimetype-query} computed scalars (count/string/…) carry no lines — no source node", async () => {
        const h = new FakeTreeHandler(meta);
        const matches = await h.query(source, "xpath", "count(//function)");
        assert.equal(matches.length, 1);
        // count(...) synthesizes a number from many nodes — it lives nowhere in
        // the source, so `lines` is absent (not a faked line 1). The value is
        // still reported faithfully.
        assert.equal(matches[0].regions, undefined);
        assert.equal(matches[0].matched, "2");
    });

    it("{§mimetype-handler-contract} symmetry with jsonpath: same logical query returns the same source line", async () => {
        const h = new FakeTreeHandler(meta);
        const viaJsonpath = await h.query(
            source,
            "jsonpath",
            "$..children[?(@.type=='function' && @.name=='fn_a')]",
        );
        const viaXpath = await h.query(
            source,
            "xpath",
            "//function[name='fn_a']",
        );
        assert.equal(viaJsonpath.length, 1);
        assert.equal(viaXpath.length, 1);
        // Both should report line 42 — jsonpath via the matched subtree's line
        // annotations, xpath via pk:line on the element.
        assert.equal(viaJsonpath[0].enclosingRegions![0].startLine, 42);
        assert.equal(viaXpath[0].enclosingRegions![0].startLine, 42);
    });
});
}

// ─── BaseHandler.query.test.ts ───
{
// Contract: {§mimetype-query}.





const metadata = {
    mimetype: "text/test",
    glyph: "🧪",
    extensions: [".test"] as const,
};

describe("{§mimetype-query} BaseHandler.query: regex default", () => {
    it("{§mimetype-handler-contract} applies regex against decoded text content", async () => {
        const h = new BaseHandler(metadata);
        const out = await h.query("foo bar foo", "regex", "foo");
        assert.equal(out.length, 2);
    });

    it("{§mimetype-handler-contract} rejects regex on binary content via toText default", async () => {
        const h = new BaseHandler(metadata);
        await assert.rejects(
            async () => { await h.query(new Uint8Array([0x01]), "regex", "."); },
            (err: unknown) => err instanceof UnsupportedDialectError,
        );
    });
});

describe("{§mimetype-query} BaseHandler.query: glob default", () => {
    it("{§mimetype-handler-contract} applies glob line-anchored against text", async () => {
        const h = new BaseHandler(metadata);
        const out = await h.query("error: foo\nwarn: bar\nerror: baz", "glob", "error: *");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "error: foo");
    });
});

describe("{§mimetype-query} BaseHandler.query: jsonpath default (against outline)", () => {
    it("{§mimetype-handler-contract} applies jsonpath against the bare-leaves outline from extractRaw", async () => {
        class WithSymbols extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [
                    { name: "Top", kind: "heading", level: 1, line: 1, endLine: 1 },
                    { name: "Section", kind: "heading", level: 2, line: 3, endLine: 3 },
                    { name: "Sub", kind: "heading", level: 3, line: 5, endLine: 5 },
                ];
            }
        }
        const h = new WithSymbols(metadata);
        const out = await h.query("top\nx\nsection\nx\nsub", "jsonpath", "$.Top.Section.Sub");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, 5);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 5, startColumn: 1, endLine: 5, endColumn: 4,
        }]);
    });

    it("{§mimetype-handler-contract} returns [] when extractRaw is empty", async () => {
        const h = new BaseHandler(metadata);
        const out = await h.query("any", "jsonpath", "$.Anything");
        assert.deepEqual(out, []);
    });
});

describe("{§mimetype-query} BaseHandler.query: xpath default", () => {
    it("{§mimetype-handler-contract} throws UnsupportedDialectError on the default handler (no xpath path)", async () => {
        const h = new BaseHandler(metadata);
        await assert.rejects(
            async () => { await h.query("any", "xpath", "//foo"); },
            (err: unknown) =>
                err instanceof UnsupportedDialectError &&
                err.dialect === "xpath" &&
                err.mimetype === "text/test",
        );
    });

    // {§mimetype-query} symmetry: a symbols-only handler answers jsonpath via the bare-number
    // outline, so xpath must reach the SAME outline with the SAME real lines.
    it("{§mimetype-handler-contract} dispatches xpath against the projected symbol outline with real lines", async () => {
        class WithSymbols extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [
                    { name: "Top", kind: "heading", level: 1, line: 1, endLine: 1 },
                    { name: "Section", kind: "heading", level: 2, line: 3, endLine: 3 },
                    { name: "Sub", kind: "heading", level: 3, line: 5, endLine: 5 },
                ];
            }
        }
        const h = new WithSymbols(metadata);
        const out = await h.query("top\nx\nsection\nx\nsub", "xpath", "//Sub");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 5, startColumn: 1, endLine: 5, endColumn: 4,
        }]);
    });
});

describe("{§mimetype-query} BaseHandler.query: subclass overrides", () => {
    it("{§mimetype-handler-contract} allows a subclass to override toText for binary content (PDF pattern)", async () => {
        class BinaryWithText extends BaseHandler {
            protected override async toText(content: string | Uint8Array): Promise<string> {
                if (content instanceof Uint8Array) return "extracted text from bytes";
                return content;
            }
        }
        const h = new BinaryWithText(metadata);
        const out = await h.query(new Uint8Array([0x01]), "regex", "extracted");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "extracted");
    });

    it("{§mimetype-handler-contract} allows a subclass to override the whole query method (handler-side dispatch)", async () => {
        class CustomXpath extends BaseHandler {
            override async query(
                content: string | Uint8Array,
                dialect: "regex" | "glob" | "xpath" | "jsonpath",
                pattern: string,
                flags?: string,
            ) {
                if (dialect === "xpath") {
                    return [{ line: 1, matched: "<x/>", matching: `(${pattern})[1]` }];
                }
                return super.query(content, dialect, pattern, flags);
            }
        }
        const h = new CustomXpath(metadata);
        const out = await h.query("any", "xpath", "//x");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "<x/>");
    });
});
}
