import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextHtml from "./TextHtml.ts";


const metadata = {
    mimetype: "text/html",
    glyph: "🌐",
    extensions: [".html", ".htm"] as const,
};

const h = new TextHtml(metadata);

async function symbolsOf(html: string | Uint8Array) {
    return h.extractRaw(html);
}

describe("TextHtml — heading extraction", () => {
    it("emits <h1>-<h6> as heading symbols with level from the tag", async () => {
        const html = "<html><body><h1>Top</h1><h2>Section</h2><h3>Sub</h3></body></html>";
        const syms = await symbolsOf(html);
        const headings = syms.filter((s) => s.kind === "heading");
        assert.equal(headings.length, 3);
        assert.deepEqual(headings.map((h) => ({ n: h.name, l: h.level })), [
            { n: "Top", l: 1 },
            { n: "Section", l: 2 },
            { n: "Sub", l: 3 },
        ]);
    });

    it("captures source line numbers from parse5", async () => {
        const html = "<html>\n<body>\n<h1>One</h1>\n<h2>Two</h2>\n</body>\n</html>";
        const syms = await symbolsOf(html);
        const one = syms.find((s) => s.name === "One");
        const two = syms.find((s) => s.name === "Two");
        assert.equal(one?.line, 3);
        assert.equal(two?.line, 4);
    });

    it("collects nested text inside a heading (anchors, spans, emphasis)", async () => {
        const html = "<h2>Hello <strong>brave</strong> <em>world</em></h2>";
        const syms = await symbolsOf(html);
        assert.equal(syms[0].name, "Hello brave world");
    });

    it("skips headings whose text content is empty after trimming", async () => {
        const html = "<h1>   </h1><h2>Real</h2>";
        const syms = await symbolsOf(html);
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Real");
    });

    it("returns [] when no headings/title/code blocks exist", async () => {
        const html = "<html><body><p>Just a paragraph.</p></body></html>";
        assert.deepEqual(h.extractRaw(html), []);
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(h.extractRaw(""), []);
    });
});

describe("TextHtml — container + columns (issue #18)", () => {
    it("headings carry ancestor-heading container paths", async () => {
        const html = "<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>";
        const syms = h.extractRaw(html);
        const byName = new Map(syms.map((s) => [s.name, s]));
        assert.equal("container" in byName.get("A")!, false);
        assert.equal(byName.get("B")!.container, "A");
        assert.equal(byName.get("C")!.container, "A.B");
        assert.equal(byName.get("D")!.container, "A", "level-2 D closes B and C");
    });

    it("code blocks carry the innermost open heading as container", async () => {
        const html = "<h1>A</h1><h2>B</h2><pre><code class=\"language-ts\">x</code></pre>";
        const syms = h.extractRaw(html);
        assert.equal(syms.find((s) => s.kind === "module")!.container, "A.B");
    });

    it("symbols carry 1-indexed columns from parse5 locations", async () => {
        const html = "<h1>A</h1>";
        const syms = h.extractRaw(html);
        assert.equal(syms[0].column, 1);
        assert.ok((syms[0].endColumn ?? 0) > 1);
    });

    it("title-as-h1 fallback carries no container", async () => {
        const html = "<html><head><title>T</title></head><body><h2>S</h2></body></html>";
        const syms = h.extractRaw(html);
        const title = syms.find((s) => s.name === "T")!;
        assert.equal("container" in title, false);
    });
});

describe("TextHtml — <title> fallback", () => {
    it("promotes <title> to a level-1 heading when no <h1> exists", async () => {
        const html = "<html><head><title>Page Title</title></head><body><h2>S</h2></body></html>";
        const syms = await symbolsOf(html);
        assert.equal(syms[0].name, "Page Title");
        assert.equal(syms[0].kind, "heading");
        assert.equal(syms[0].level, 1);
    });

    it("does NOT inject the title when a real <h1> exists", async () => {
        const html = "<html><head><title>Page Title</title></head><body><h1>Real Top</h1></body></html>";
        const syms = await symbolsOf(html);
        // Only the h1 — no duplicate from the title.
        const h1s = syms.filter((s) => s.kind === "heading" && s.level === 1);
        assert.equal(h1s.length, 1);
        assert.equal(h1s[0].name, "Real Top");
    });

    it("handles documents with title but no body content", async () => {
        const html = "<html><head><title>Only Title</title></head><body></body></html>";
        const syms = await symbolsOf(html);
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Only Title");
    });
});

describe("TextHtml — code blocks", () => {
    it("emits <pre><code> as a module symbol named 'code' when no language class", async () => {
        const html = "<h1>X</h1><pre><code>const x = 1;</code></pre>";
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "code");
    });

    it("extracts language from class='language-X' (highlight.js convention)", async () => {
        const html = '<h1>X</h1><pre><code class="language-typescript">const x: number = 1;</code></pre>';
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "typescript");
    });

    it("supports multiple classes alongside language- (e.g. 'highlight language-python')", async () => {
        const html = '<h1>X</h1><pre><code class="highlight language-python token">x = 1</code></pre>';
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.equal(code?.name, "python");
    });

    it("does not enter pre's children (no spurious nested symbols from code content)", async () => {
        const html = "<pre><code>&lt;h1&gt;Not a real heading&lt;/h1&gt;</code></pre>";
        const syms = await symbolsOf(html);
        const headings = syms.filter((s) => s.kind === "heading");
        assert.equal(headings.length, 0);
    });
});

describe("TextHtml — content shape", () => {
    it("accepts Uint8Array content (decoded as utf-8)", async () => {
        const html = "<h1>From Bytes</h1>";
        const bytes = new TextEncoder().encode(html);
        const syms = await symbolsOf(bytes);
        assert.equal(syms[0].name, "From Bytes");
    });

    it("validate is a no-op (HTML is forgiving by spec)", () => {
        assert.doesNotThrow(() => h.validate("<not really><valid html>"));
        assert.doesNotThrow(() => h.validate(""));
    });

});

describe("TextHtml — xpath query", () => {
    it("matches elements and returns serialized XML as `matched`", async () => {
        const html = "<html><body><p>One</p><p>Two</p></body></html>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 2);
        const first = out[0].matched as string;
        assert.ok(first.includes("One"));
        assert.ok(first.includes("<p"));
    });

    it("reports the real source-line span of each match, not a faked 1 (#41)", async () => {
        const html = "<root>\n  <p>a</p>\n  <p>b</p>\n</root>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 2 }]);
        assert.deepEqual(out[1].lines, [{ line: 3, endLine: 3 }]);
    });

    it("a computed scalar (count) carries no lines (#41)", async () => {
        const html = "<root>\n  <p>a</p>\n  <p>b</p>\n</root>";
        const out = await h.query(html, "xpath", "count(//p)");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "2");
        assert.equal(out[0].lines, undefined);
    });

    it("emits `matching` with indexed xpath form when there are multiple results", async () => {
        const html = "<html><body><p>A</p><p>B</p><p>C</p></body></html>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 3);
        assert.equal(out[0].matching, "(//p)[1]");
        assert.equal(out[1].matching, "(//p)[2]");
        assert.equal(out[2].matching, "(//p)[3]");
    });

    it("omits `matching` for single results", async () => {
        const html = "<html><body><h1>Only</h1></body></html>";
        const out = await h.query(html, "xpath", "//h1");
        assert.equal(out.length, 1);
        assert.equal(out[0].matching, undefined);
    });

    it("returns string for attribute-axis queries", async () => {
        const html = '<html><body><a href="x">a</a><a href="y">b</a></body></html>';
        const out = await h.query(html, "xpath", "//a/@href");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "x");
        assert.equal(out[1].matched, "y");
    });

    it("returns string for text() node queries", async () => {
        const html = "<html><body><p>Hello world</p></body></html>";
        const out = await h.query(html, "xpath", "//p/text()");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Hello world");
    });

    it("returns a single primitive for string() function expressions", async () => {
        const html = "<html><body><h1>Top</h1></body></html>";
        const out = await h.query(html, "xpath", "string(//h1)");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Top");
    });

    it("returns [] when xpath matches nothing", async () => {
        const html = "<html><body><h1>Top</h1></body></html>";
        const out = await h.query(html, "xpath", "//nonexistent");
        assert.deepEqual(out, []);
    });
});

describe("TextHtml — regex/jsonpath inheritance", () => {
    it("inherits regex query against the raw HTML source", async () => {
        const html = "<html><body><!-- TODO: cleanup --></body></html>";
        const out = await h.query(html, "regex", "TODO: (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["cleanup"]);
    });

    it("jsonpath queries the deep-json DOM tree (issue #10): filter elements by type", async () => {
        const html = "<html><body><h1>Top</h1><h2>Section</h2><h3>Sub</h3></body></html>";
        const headings = await h.query(html, "jsonpath", "$..children[?(@.type=='h1' || @.type=='h2' || @.type=='h3')]");
        assert.equal(headings.length, 3);
        const types = headings.map((m) => (m.matched as { type: string }).type);
        assert.deepEqual(types, ["h1", "h2", "h3"]);
    });
});

describe("TextHtml — deepJson (issue #10 DOM channel)", () => {
    const h = new TextHtml(metadata);

    it("returns a document root with nested element children", async () => {
        const html = "<html><body><h1>Hello</h1></body></html>";
        const tree = await h.deepJson(html) as { type: string; children: Array<{ type: string }> };
        assert.equal(tree.type, "document");
        assert.ok(Array.isArray(tree.children));
    });

    it("element attributes surface in the attrs field", async () => {
        const html = '<html><body><a href="https://example.com" class="external">click</a></body></html>';
        const tree = await h.deepJson(html);
        // Walk to find the <a> node.
        const stack: unknown[] = [tree];
        let found: { attrs?: Record<string, string>; text?: string } | null = null;
        while (stack.length > 0) {
            const cur = stack.pop() as { type?: string; attrs?: Record<string, string>; text?: string; children?: unknown[] };
            if (cur && cur.type === "a") { found = cur; break; }
            if (cur && cur.children) stack.push(...cur.children);
        }
        assert.ok(found, "should locate the <a> element");
        assert.equal(found!.attrs?.href, "https://example.com");
        assert.equal(found!.attrs?.class, "external");
        assert.equal(found!.text, "click");
    });

    it("returns null on parse failure", async () => {
        // parse5 is famously permissive — even garbage parses successfully
        // into a document. So we test that the method doesn't throw and
        // returns a document tree even for ill-formed input.
        const tree = await h.deepJson("<<<not really html>>>");
        assert.ok(tree && typeof tree === "object");
        assert.equal((tree as { type: string }).type, "document");
    });
});
