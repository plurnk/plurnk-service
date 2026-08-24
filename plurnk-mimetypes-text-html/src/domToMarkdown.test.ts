// The owned serializer's contract (#344): turndown-parity escaping, structure
// for the Readability tag set, and the table upgrade turndown never had.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { domToMarkdown } from "./domToMarkdown.ts";

const md = (html: string): string => {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    return domToMarkdown(document.documentElement!);
};

test("prose escaping never fabricates markdown structure", () => {
    assert.equal(
        md("<p>with *stars*, _unders_, [brackets] and <code>a `tick`</code></p>"),
        "with \\*stars\\*, \\_unders\\_, \\[brackets\\] and `` a `tick` ``",
    );
    assert.equal(md("<p># not a heading</p>"), "\\# not a heading");
});

test("nested lists, blockquotes, and fenced code hold structure", () => {
    assert.equal(
        md("<blockquote><ul><li>one<ul><li>two</li></ul></li></ul></blockquote>"),
        "> - one\n>   \n>   - two",
    );
    assert.equal(
        md('<pre><code class="language-js">const x = `tpl`;\n</code></pre>'),
        "```js\nconst x = `tpl`;\n```",
    );
});

test("tables serialize as pipe tables — the upgrade over GFM-less turndown", () => {
    assert.equal(
        md("<table><tr><th>K</th><th>V|p</th></tr><tr><td><strong>b</strong></td><td>2</td></tr></table>"),
        "| K | V\\|p |\n| --- | --- |\n| **b** | 2 |",
    );
});

test("links carry titles; images carry alt; hr and headings are conventional", () => {
    assert.equal(md('<p><a href="https://x.example/" title="T">go</a></p>'), '[go](https://x.example/ "T")');
    assert.equal(md('<p><img src="/i.png" alt="a [b]"></p>'), "![a \\[b\\]](/i.png)");
    assert.equal(md("<hr>"), "---");
    assert.equal(md("<h3>Three</h3>"), "### Three");
});
