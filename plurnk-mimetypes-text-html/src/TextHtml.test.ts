import test, { describe, it } from "node:test";
import { htmlToMarkdown } from "./htmlToMarkdown.ts";
import assert from "node:assert/strict";
import TextHtml from "./TextHtml.ts";
import { parseHTML } from "linkedom";
import { domToMarkdown } from "./domToMarkdown.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { markdownWrapColumns, wrapMarkdown } from "./wrapMarkdown.ts";

// ─── TextHtml.test.ts ───
{
const metadata = {
    mimetype: "text/html",
    glyph: "🌐",
    extensions: [".html", ".htm"] as const,
};

const h = new TextHtml(metadata);

async function symbolsOf(html: string | Uint8Array) {
    return h.extractRaw(html);
}

describe("{§html-readable-text} headings are symbols with their level and flattened text", () => {
    it("{§html-readable-text} emits <h1>-<h6> as heading symbols with level from the tag", async () => {
        const html = "<html><body><h1>Top</h1><h2>Section</h2><h3>Sub</h3></body></html>";
        const syms = await symbolsOf(html);
        const headings = syms.filter((s) => s.kind === "heading");
        assert.equal(headings.length, 3);
        assert.deepEqual(headings.map((heading) => ({ n: heading.name, l: heading.level })), [
            { n: "Top", l: 1 },
            { n: "Section", l: 2 },
            { n: "Sub", l: 3 },
        ]);
    });

    it("{§html-readable-text} captures source line numbers from parse5", async () => {
        const html = "<html>\n<body>\n<h1>One</h1>\n<h2>Two</h2>\n</body>\n</html>";
        const syms = await symbolsOf(html);
        const one = syms.find((s) => s.name === "One");
        const two = syms.find((s) => s.name === "Two");
        assert.equal(one?.line, 3);
        assert.equal(two?.line, 4);
    });

    it("{§html-readable-text} collects nested text inside a heading (anchors, spans, emphasis)", async () => {
        const html = "<h2>Hello <strong>brave</strong> <em>world</em></h2>";
        const syms = await symbolsOf(html);
        assert.equal(syms[0].name, "Hello brave world");
    });

    it("{§html-readable-text} skips headings whose text content is empty after trimming", async () => {
        const html = "<h1>   </h1><h2>Real</h2>";
        const syms = await symbolsOf(html);
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Real");
    });

    it("{§html-readable-text} returns [] when no headings/title/code blocks exist", async () => {
        const html = "<html><body><p>Just a paragraph.</p></body></html>";
        assert.deepEqual(h.extractRaw(html), []);
    });

    it("{§html-readable-text} returns [] for empty input", async () => {
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("{§html-readable-text} accepts Uint8Array content (decoded as utf-8)", async () => {
        const html = "<h1>From Bytes</h1>";
        const bytes = new TextEncoder().encode(html);
        const syms = await symbolsOf(bytes);
        assert.equal(syms[0].name, "From Bytes");
    });
});

describe("{§mimetype-symbol} container + columns", () => {
    it("{§html-readable-text} headings carry ancestor-heading container paths", async () => {
        const html = "<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>";
        const syms = h.extractRaw(html);
        const byName = new Map(syms.map((s) => [s.name, s]));
        assert.equal("container" in byName.get("A")!, false);
        assert.equal(byName.get("B")!.container, "A");
        assert.equal(byName.get("C")!.container, "A.B");
        assert.equal(byName.get("D")!.container, "A", "level-2 D closes B and C");
    });

    it("{§html-readable-text} code blocks carry the innermost open heading as container", async () => {
        const html = "<h1>A</h1><h2>B</h2><pre><code class=\"language-ts\">x</code></pre>";
        const syms = h.extractRaw(html);
        assert.equal(syms.find((s) => s.kind === "module")!.container, "A.B");
    });

    it("{§html-readable-text} symbols carry 1-indexed columns from parse5 locations", async () => {
        const html = "<h1>A</h1>";
        const syms = h.extractRaw(html);
        assert.equal(syms[0].column, 1);
        assert.ok((syms[0].endColumn ?? 0) > 1);
    });

    it("{§html-readable-text} title-as-h1 fallback carries no container", async () => {
        const html = "<html><head><title>T</title></head><body><h2>S</h2></body></html>";
        const syms = h.extractRaw(html);
        const title = syms.find((s) => s.name === "T")!;
        assert.equal("container" in title, false);
    });
});

describe("{§html-readable-text} <title> stands in for a missing <h1>", () => {
    it("{§html-readable-text} promotes <title> to a level-1 heading when no <h1> exists", async () => {
        const html = "<html><head><title>Page Title</title></head><body><h2>S</h2></body></html>";
        const syms = await symbolsOf(html);
        assert.equal(syms[0].name, "Page Title");
        assert.equal(syms[0].kind, "heading");
        assert.equal(syms[0].level, 1);
    });

    it("{§html-readable-text} does NOT inject the title when a real <h1> exists", async () => {
        const html = "<html><head><title>Page Title</title></head><body><h1>Real Top</h1></body></html>";
        const syms = await symbolsOf(html);
        // Only the h1 — no duplicate from the title.
        const h1s = syms.filter((s) => s.kind === "heading" && s.level === 1);
        assert.equal(h1s.length, 1);
        assert.equal(h1s[0].name, "Real Top");
    });

    it("{§html-readable-text} handles documents with title but no body content", async () => {
        const html = "<html><head><title>Only Title</title></head><body></body></html>";
        const syms = await symbolsOf(html);
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Only Title");
    });
});

describe("{§html-readable-text} <pre> blocks are modules named by their language class", () => {
    it("{§html-readable-text} emits <pre><code> as a module symbol named 'code' when no language class", async () => {
        const html = "<h1>X</h1><pre><code>const x = 1;</code></pre>";
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "code");
    });

    it("{§html-readable-text} extracts language from class='language-X' (highlight.js convention)", async () => {
        const html = '<h1>X</h1><pre><code class="language-typescript">const x: number = 1;</code></pre>';
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.ok(code);
        assert.equal(code.name, "typescript");
    });

    it("{§html-readable-text} supports multiple classes alongside language- (e.g. 'highlight language-python')", async () => {
        const html = '<h1>X</h1><pre><code class="highlight language-python token">x = 1</code></pre>';
        const syms = await symbolsOf(html);
        const code = syms.find((s) => s.kind === "module");
        assert.equal(code?.name, "python");
    });

    it("{§html-readable-text} does not enter pre's children (no spurious nested symbols from code content)", async () => {
        const html = "<pre><code>&lt;h1&gt;Not a real heading&lt;/h1&gt;</code></pre>";
        const syms = await symbolsOf(html);
        const headings = syms.filter((s) => s.kind === "heading");
        assert.equal(headings.length, 0);
    });
});

describe("{§mimetype-channel-selection} validate is the no-op default", () => {
    it("{§html-readable-text} validate is a no-op (HTML is forgiving by spec)", () => {
        assert.doesNotThrow(() => h.validate("<not really><valid html>"));
        assert.doesNotThrow(() => h.validate(""));
    });
});

describe("{§html-readable-text} xpath addresses the parse5 tree with its source spans", () => {
    it("{§mimetype-content} synthetic HTML containers have no invented source coordinates", async () => {
        const out = await h.query("<p>Content</p>", "jsonpath", "$..children[?(@.type == 'head')]");
        assert.equal(out.length, 1);
        assert.equal(out[0].regions, undefined);
        assert.deepEqual(out[0].matched, { type: "head" });
    });

    it("{§html-readable-text} matches elements and returns serialized XML as `matched`", async () => {
        const html = "<html><body><p>One</p><p>Two</p></body></html>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 2);
        const first = out[0].matched as string;
        assert.ok(first.includes("One"));
        assert.ok(first.includes("<p"));
    });

    it("{§mimetype-content} retains XPath locators and source markup coordinates", async () => {
        const html = "<root>\n  <p>a</p>\n  <p>b</p>\n</root>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].regions, [{ startLine: 2, startColumn: 3, endLine: 2, endColumn: 11 }]);
        assert.deepEqual(out[1].regions, [{ startLine: 3, startColumn: 3, endLine: 3, endColumn: 11 }]);
        assert.equal(out[0].matching, "(//p)[1]");
        assert.equal(out[1].matching, "(//p)[2]");
    });

    it("{§html-readable-text} a computed scalar (count) retains its expression without a text region", async () => {
        const html = "<root>\n  <p>a</p>\n  <p>b</p>\n</root>";
        const out = await h.query(html, "xpath", "count(//p)");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "2");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//p)");
    });

    it("{§html-readable-text} emits `matching` with indexed xpath form when there are multiple results", async () => {
        const html = "<html><body><p>A</p><p>B</p><p>C</p></body></html>";
        const out = await h.query(html, "xpath", "//p");
        assert.equal(out.length, 3);
        assert.equal(out[0].matching, "(//p)[1]");
        assert.equal(out[1].matching, "(//p)[2]");
        assert.equal(out[2].matching, "(//p)[3]");
    });

    it("{§html-readable-text} retains the canonical XPath locator for a single result", async () => {
        const html = "<html><body><h1>Only</h1></body></html>";
        const out = await h.query(html, "xpath", "//h1");
        assert.equal(out.length, 1);
        assert.equal(out[0].matching, "//h1");
    });

    it("{§html-readable-text} returns string for attribute-axis queries", async () => {
        const html = '<html><body><a href="x">a</a><a href="y">b</a></body></html>';
        const out = await h.query(html, "xpath", "//a/@href");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "x");
        assert.equal(out[1].matched, "y");
    });

    it("{§html-readable-text} returns string for text() node queries", async () => {
        const html = "<html><body><p>Hello world</p></body></html>";
        const out = await h.query(html, "xpath", "//p/text()");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Hello world");
    });

    it("{§html-readable-text} returns a single primitive for string() function expressions", async () => {
        const html = "<html><body><h1>Top</h1></body></html>";
        const out = await h.query(html, "xpath", "string(//h1)");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "Top");
    });

    it("{§html-readable-text} returns [] when xpath matches nothing", async () => {
        const html = "<html><body><h1>Top</h1></body></html>";
        const out = await h.query(html, "xpath", "//nonexistent");
        assert.deepEqual(out, []);
    });

    it("{§mimetype-query} source spans survive multiline markup, entities, and Unicode", async () => {
        const html = '<html>\n<body>😀<p title="a&amp;b">\nhello &amp; goodbye\n</p></body>\n</html>';
        const elements = await h.query(html, "xpath", "//p");
        assert.deepEqual(elements[0].regions, [{ startLine: 2, startColumn: 8, endLine: 4, endColumn: 5 }]);
        const attributes = await h.query(html, "xpath", "//p/@title");
        assert.deepEqual(attributes[0].regions, [{ startLine: 2, startColumn: 11, endLine: 2, endColumn: 26 }], "the selected attribute keeps its own lexical source");
        assert.equal(attributes[0].matched, "a&b");
    });
});

describe("{§mimetype-content} regex sees the source markup; jsonpath sees the DOM tree", () => {
    it("{§html-readable-text} inherits regex query over the source markup", async () => {
        // {§mimetype-content}: the readable projection is a channel of its own; the source
        // channel matches as the text it is, comments included.
        const article = "<!DOCTYPE html><html><body><article><h1>FindableArticleHeading</h1>"
            + `<p>${"Readable article prose with enough density for extraction. ".repeat(15)}</p>`
            + "</article></body></html>";
        const out = await h.query(article, "regex", "FindableArticleHeading");
        assert.equal(out.length, 1);
        const shell = await h.query("<html><body><!-- TODO: cleanup --></body></html>", "regex", "cleanup");
        assert.equal(shell.length, 1, "a comment is source text and matches in the source channel");
    });

    it("{§mimetype-channel-architecture}: jsonpath queries the deep-json DOM tree", async () => {
        const html = "<html><body><h1>Top</h1><h2>Section</h2><h3>Sub</h3></body></html>";
        const headings = await h.query(html, "jsonpath", "$..children[?(@.type=='h1' || @.type=='h2' || @.type=='h3')]");
        assert.equal(headings.length, 3);
        const types = headings.map((m) => (m.matched as { type: string }).type);
        assert.deepEqual(types, ["h1", "h2", "h3"]);
    });
});

describe("{§html-readable-text} deepJson is the parsed DOM as nested nodes", () => {
    const handler = new TextHtml(metadata);

    it("{§html-readable-text} returns a document root with nested element children", async () => {
        const html = "<html><body><h1>Hello</h1></body></html>";
        const tree = await handler.deepJson(html) as { type: string; children: Array<{ type: string }> };
        assert.equal(tree.type, "document");
        assert.ok(Array.isArray(tree.children));
    });

    it("{§html-readable-text} element attributes surface in the attrs field", async () => {
        const html = '<html><body><a href="https://example.com" class="external">click</a></body></html>';
        const tree = await handler.deepJson(html);
        // Walk to find the <a> node.
        const stack: unknown[] = [tree];
        let found: { attrs?: Record<string, string>; text?: string } | null = null;
        while (stack.length > 0) {
            const cur = stack.pop() as { type?: string; attrs?: Record<string, string>; text?: string; children?: unknown[] };
            if (cur && cur.type === "a") { found = cur; break; }
            if (cur && cur.children) stack.push(...cur.children);
        }
        assert.ok(found, "should locate the <a> element");
        assert.equal(found.attrs?.href, "https://example.com");
        assert.equal(found.attrs?.class, "external");
        assert.equal(found.text, "click");
    });

    it("{§html-readable-text} recovers ill-formed HTML into a document tree", async () => {
        // parse5 is famously permissive — even garbage parses successfully
        // into a document. So we test that the method doesn't throw and
        // returns a document tree even for ill-formed input.
        const tree = await handler.deepJson("<<<not really html>>>");
        assert.ok(tree && typeof tree === "object");
        assert.equal((tree as { type: string }).type, "document");
    });
});

it("{§html-readable-text} an unbalanced template partial that crashes Readability still projects readable text", () => {
    // Verbatim member content from the corpus (scriggo test/compare header partial):
    // stray closers and template actions walk Readability into a null tagName.
    const partial = "\n<header>\n\n  <div class=\"centered\">\n    <div class=\"search\">\n      <div id=\"search-panel\" class=\"panel\">\n        <div>\n          <input type=\"text\" name=\"keywords\" class=\"design-search-keywords\" placeholder=\"{Search...}\" size=\"15\">\n          <div class=\"search-button icon-search main-button\">\n          </div>\n          </form>\n        </div>\n      </div>\n    </div>\n\n    <div class=\"logo\">\n    </div>\n\n    <div class=\"cart\">\n      </a>\n      {{ render \"/partials/mini-cart.html\" }}\n    </div>\n  </div>\n\n</header>\n";
    const markdown = htmlToMarkdown(partial);
    assert.notEqual(markdown, undefined, "the noise-stripped body still reads");
    assert.match(markdown!, /mini-cart/, "template content survives the fallback");
});
}

// ─── content.test.ts ───
{
const metadata = {
    mimetype: "text/html",
    glyph: "🌐",
    extensions: [".html", ".htm"] as const,
};

const h = new TextHtml(metadata);

// An article-shaped page: header/nav chrome, an <article> body, footer chrome.
// Readability should keep the article and drop the chrome.
const ARTICLE = `<!DOCTYPE html>
<html>
<head><title>My Great Article</title></head>
<body>
<header><nav>
<a href="/home">HomeNavLink</a>
<a href="/about">AboutNavLink</a>
</nav></header>
<article>
<h1>The Great Heading</h1>
<p>This is the opening paragraph with a <a href="https://example.com">ExampleLink</a> inside it.</p>
<h2>A Subsection Heading</h2>
<ul><li>First list item</li><li>Second list item</li></ul>
<p>${"Substantial article body text that gives Readability enough signal. ".repeat(15)}</p>
</article>
<footer><p>FooterChromeCopyright 2026</p></footer>
</body>
</html>`;

describe("{§html-readable-text} content is the page's reading Markdown, never raw HTML", () => {
    it("{§html-readable-text} returns markdown containing the article text", () => {
        const md = h.content(ARTICLE);
        assert.equal(typeof md, "string");
        assert.ok(md!.includes("The Great Heading"), "article heading text present");
        assert.ok(md!.includes("opening paragraph"), "article body present");
    });

    it("{§html-readable-text} excludes nav and footer chrome", () => {
        const md = h.content(ARTICLE) as string;
        assert.ok(!md.includes("HomeNavLink"), "nav link stripped");
        assert.ok(!md.includes("AboutNavLink"), "nav link stripped");
        assert.ok(!md.includes("FooterChromeCopyright"), "footer stripped");
    });

    it("{§html-readable-text} strips all HTML tags (no '<' in the output)", () => {
        const md = h.content(ARTICLE) as string;
        assert.ok(!md.includes("<"), "no markup angle brackets remain");
    });

    it("{§html-readable-text} preserves headings, lists, and links as markdown", () => {
        const md = h.content(ARTICLE) as string;
        assert.ok(/(^|\n)#{1,6} /.test(md), "ATX heading marker present");
        assert.ok(md.includes("First list item"), "list content present");
        assert.ok(/(^|\n)-\s+/.test(md), "markdown bullet marker present");
        assert.ok(md.includes("[ExampleLink](https://example.com)"), "markdown link present");
    });

    it("{§html-readable-text} wraps projected prose at the configured default", () => {
        const prose = ("readable prose ".repeat(30)).trim();
        const md = h.content(`<article><p>${prose}</p></article>`) as string;
        assert.ok(md.split("\n").length > 1, "the dense source paragraph gained line boundaries");
        assert.ok(md.split("\n").every((line) => line.length <= 100), "ordinary prose respects the 100-column floor");
        assert.equal(md.replaceAll("\n", " "), prose);
    });

    it("{§html-readable-text} falls back to body markdown for a non-article fragment (<form>)", () => {
        const md = h.content("<form><h2>Sign up</h2><p>Enter your details below.</p></form>");
        assert.equal(typeof md, "string");
        assert.ok(md!.length > 0, "non-empty");
        assert.ok(!md!.includes("<"), "tag-free");
        assert.ok(md!.includes("Sign up"), "fragment heading present");
        assert.ok(md!.includes("Enter your details"), "fragment body present");
    });

    it("{§html-readable-text} falls back to body markdown for a bare <div> of text", () => {
        const md = h.content("<div>Just some plain text in a div, no article structure.</div>");
        assert.equal(md, "Just some plain text in a div, no article structure.");
    });

    it("{§html-readable-text} returns undefined for empty input", () => {
        assert.equal(h.content(""), undefined);
    });

    it("{§html-readable-text} returns undefined for whitespace-only input", () => {
        assert.equal(h.content("   \n\t  "), undefined);
    });

    it("{§html-readable-text} decodes Uint8Array content as utf-8", () => {
        const bytes = new TextEncoder().encode("<div>Bytes become markdown.</div>");
        const md = h.content(bytes);
        assert.equal(md, "Bytes become markdown.");
    });
});

describe("{§mimetype-content} toText is the raw markup; the projection is content()", () => {
    it("{§html-readable-text} toText() returns the source itself, never the projection", () => {
        // {§mimetype-content}: the projection is a channel the consumer stores; regex and glob
        // over the source channel see the markup.
        const toText = (h as unknown as { toText(c: string): string }).toText.bind(h);
        assert.equal(toText(ARTICLE), ARTICLE);
        assert.notEqual(h.content(ARTICLE), ARTICLE);
    });

    it("{§html-readable-text} content() is absent when there is no readable projection, and toText() is still the source", () => {
        const html = "<html><body><!-- TODO: cleanup --></body></html>";
        const toText = (h as unknown as { toText(c: string): string }).toText.bind(h);
        assert.equal(h.content(html), undefined);
        assert.equal(toText(html), html);
    });

    it("{§html-readable-text} regex matches the markup it is given, in the markup's own coordinates", async () => {
        // {§mimetype-content}: the projection is a channel of its own; a regex over the source
        // channel sees tags and attributes, and its region addresses the source.
        const html = `<article>\n<h1>FindableHeading</h1>\n<p class="prose">${"body text ".repeat(20)}</p></article>`;
        const found = await h.query(html, "regex", "FindableHeading");
        assert.equal(found.length, 1);
        assert.deepEqual(found[0].regions, [{ startLine: 2, startColumn: 5, endLine: 2, endColumn: 20 }]);
        const cls = await h.query(html, "regex", "prose");
        assert.equal(cls.length, 1, "the class attribute is source text");
        const tag = await h.query(html, "regex", "<h[1-6]");
        assert.equal(tag.length, 1, "the sweep's case: a heading tag is matchable in the source");
    });
});
}

// ─── domToMarkdown.test.ts ───
{
// {§html-readable-text}: prose escaping, structure for the Readability tag set, and pipe tables.




const md = (html: string): string => {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    return domToMarkdown(document.documentElement);
};

test("{§html-readable-text} prose escaping never fabricates markdown structure", () => {
    assert.equal(
        md("<p>with *stars*, _unders_, [brackets] and <code>a `tick`</code></p>"),
        "with \\*stars\\*, \\_unders\\_, \\[brackets\\] and `` a `tick` ``",
    );
    assert.equal(md("<p># not a heading</p>"), "\\# not a heading");
});

test("{§html-readable-text} nested lists, blockquotes, and fenced code hold structure", () => {
    assert.equal(
        md("<blockquote><ul><li>one<ul><li>two</li></ul></li></ul></blockquote>"),
        "> - one\n>   \n>   - two",
    );
    assert.equal(
        md('<pre><code class="language-js">const x = `tpl`;\n</code></pre>'),
        "```js\nconst x = `tpl`;\n```",
    );
});

test("{§html-readable-text} tables serialize as pipe tables", () => {
    assert.equal(
        md("<table><tr><th>K</th><th>V|p</th></tr><tr><td><strong>b</strong></td><td>2</td></tr></table>"),
        "| K | V\\|p |\n| --- | --- |\n| **b** | 2 |",
    );
});

test("{§html-readable-text} links carry titles; images carry alt; hr and headings are conventional", () => {
    assert.equal(md('<p><a href="https://x.example/" title="T">go</a></p>'), '[go](https://x.example/ "T")');
    assert.equal(md('<p><img src="/i.png" alt="a [b]"></p>'), "![a \\[b\\]](/i.png)");
    assert.equal(md("<hr>"), "---");
    assert.equal(md("<h3>Three</h3>"), "### Three");
});
}

// ─── queryRegions.test.ts ───
{
const h = new TextHtml({ mimetype: "text/html", glyph: "H", extensions: [".html"] as const });
const html = "<html>\n<body>\n<div>\n<p>x</p>\n</div>\n</body>\n</html>";
const regions = [{ startLine: 3, startColumn: 1, endLine: 5, endColumn: 7 }];

describe("{§html-readable-text} both structural dialects address the source markup", () => {
    it("{§mimetype-content} both structural dialects address the source markup", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: html,
                dialect: "jsonpath",
                pattern: "$..children[?(@.type==\"div\")]",
                verdict: "exact",
                expectRegions: [regions],
            },
            {
                source: html,
                dialect: "xpath",
                pattern: "//div",
                verdict: "exact",
                expectRegions: [regions],
            },
        ]);
    });

    it("{§html-readable-text} both dialects retain locators alongside source coordinates", async () => {
        const j = await h.query(html, "jsonpath", "$..children[?(@.type==\"div\")]");
        const x = await h.query(html, "xpath", "//div");
        assert.deepEqual(j[0].regions, regions);
        assert.deepEqual(x[0].regions, regions);
        assert.ok(typeof j[0].matching === "string");
        assert.equal(x[0].matching, "//div");
    });
    it("{§html-readable-text} a computed scalar retains its expression as a locator", async () => {
        const out = await h.query(html, "xpath", "count(//p)");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//p)");
    });
});

for (const { source, pattern, selected } of [
    { source: '<p>first<br>second</p><p>other', pattern: '//p', selected: ['<p>first<br>second</p>', '<p>other'] },
    { source: '<ul><li>A<li>B</ul>', pattern: '//li', selected: ['<li>A', '<li>B'] },
    { source: '<a href = \'/here\'>here</a>', pattern: '//a/@href', selected: ["href = '/here'"] },
    { source: '<p>left <b>bold</b> &amp; right</p>', pattern: '//p/text()', selected: ['left ', ' &amp; right'] },
    { source: '😀\r\n<p>😀&amp;</p>', pattern: '//p/text()', selected: ['😀&amp;'] },
    { source: '<script>if (a < b) f();</script>', pattern: '//script/text()', selected: ['if (a < b) f();'] },
]) {
    it(`{§html-readable-text} XPath ${pattern} follows the HTML parser's exact source bounds`, async () => {
        const matches = await h.query(source, "xpath", pattern);
        const coordinates = new TextCoordinates(source);
        assert.deepEqual(matches.map((match) => {
            assert.equal(match.regions?.length, 1, JSON.stringify(match));
            const region = match.regions[0];
            return source.slice(coordinates.offsetAtPosition(region.startLine, region.startColumn), coordinates.offsetAtPosition(region.endLine, region.endColumn));
        }), selected);
    });
}

it("{§html-readable-text} an implied HTML element has no invented source region", async () => {
    const [body] = await h.query("<p>text</p>", "xpath", "//body");
    assert.equal(body.matching, "//body");
    assert.equal(body.regions, undefined);
});
}

// ─── wrapMarkdown.test.ts ───
{
describe("{§html-readable-text} wrapMarkdown breaks prose at whitespace and leaves structure whole", () => {
    it("{§html-readable-text} wraps prose at whitespace without losing text", () => {
        const source = "One two three four five six seven eight nine ten eleven twelve.";
        const wrapped = wrapMarkdown(source, 20);
        assert.ok(wrapped.split("\n").every((line) => line.length <= 20));
        assert.equal(wrapped.replaceAll("\n", " "), source);
    });

    it("{§html-readable-text} preserves fenced code, headings, tables, inline code, links, and raw tags", () => {
        const link = "[primary source](https://example.com/a_very_long_path?q=one%20two)";
        const code = "`const value = a + b`";
        const tag = "<span data-label=\"a long retained raw tag\">";
        const source = [
            "# A heading whose structure must remain a heading even when it is long",
            "",
            `Read ${link} and keep ${code} beside ${tag} safely.`,
            "",
            "| long table cell | another long table cell |",
            "| --- | --- |",
            "",
            "```js",
            "const unwrapped = \"a deliberately long source line inside a fenced code block\";",
            "```",
        ].join("\n");
        const wrapped = wrapMarkdown(source, 30);
        assert.ok(wrapped.includes(link));
        assert.ok(wrapped.includes(code));
        assert.ok(wrapped.includes(tag));
        assert.ok(wrapped.includes(source.split("\n")[0]));
        assert.ok(wrapped.includes(source.split("\n")[4]));
        assert.ok(wrapped.includes(source.split("\n")[8]));
    });

    it("{§html-readable-text} keeps list and blockquote continuation inside their structures", () => {
        assert.equal(
            wrapMarkdown("- alpha beta gamma delta epsilon", 16),
            "- alpha beta\n  gamma delta\n  epsilon",
        );
        assert.equal(
            wrapMarkdown("> alpha beta gamma delta", 14),
            "> alpha beta\n> gamma delta",
        );
    });

    it("{§html-readable-text} zero disables wrapping", () => {
        const source = "a long line that remains exactly as authored";
        assert.equal(wrapMarkdown(source, 0), source);
    });
});

describe("{§html-readable-text} markdownWrapColumns reads the knob and refuses malformed values", () => {
    it("{§html-readable-text} reads zero or a positive integer and rejects malformed configuration", () => {
        const prior = process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS;
        try {
            process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = "100";
            assert.equal(markdownWrapColumns(), 100);
            process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = "0";
            assert.equal(markdownWrapColumns(), 0);
            for (const invalid of ["-1", "1.5", "wide"]) {
                process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = invalid;
                assert.throws(markdownWrapColumns, /PLURNK_MIMETYPES_HTML_WRAP_COLUMNS must be a safe integer of at least 0/);
            }
        } finally {
            if (prior === undefined) delete process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS;
            else process.env.PLURNK_MIMETYPES_HTML_WRAP_COLUMNS = prior;
        }
    });
});
}
