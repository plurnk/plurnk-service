import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { queryXpathString } from "./query.ts";
import { DOMParser, type Node as XmlNode } from "@xmldom/xmldom";
import type { TextRegion } from "@plurnk/plurnk-contracts";
import { projectDomToJson } from "./projectDomToJson.ts";

// ─── projectJsonToXml.test.ts ───
{
// Contract: {§mimetype-channel-architecture}.




const NS = ' xmlns:pk="https://plurnk.xyz/deep-xml/1"';

describe("{§mimetype-channel-architecture} projectJsonToXml: convention parity with jsonpath shape", () => {
    it("{§mimetype-channel-architecture} function_definition with pk:line/pk:endLine attributes, name as child, params as repeated siblings", () => {
        const json = {
            type: "function_definition",
            line: 5,
            endLine: 10,
            name: "greet",
            params: ["x", "y"],
        };
        const xml = projectJsonToXml(json);
        assert.equal(
            xml,
            `<function_definition${NS} pk:line="5" pk:endLine="10"><name>greet</name><params>x</params><params>y</params></function_definition>`,
        );
    });

    it("{§mimetype-channel-architecture} leaf node with text content renders text inside its tag", () => {
        const json = { type: "identifier", line: 5, endLine: 5, text: "greet" };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<identifier${NS} pk:line="5" pk:endLine="5">greet</identifier>`);
    });

    it("{§mimetype-channel-architecture} nested children render as nested elements named by their own type; bookkeeping stays in pk: namespace", () => {
        const json = {
            type: "function_definition",
            line: 1,
            endLine: 3,
            children: [
                { type: "identifier", line: 1, endLine: 1, text: "foo" },
                { type: "block", line: 2, endLine: 3 },
            ],
        };
        const xml = projectJsonToXml(json);
        // Root has the namespace decl; nested elements use pk: bookkeeping
        // without redeclaring (it's scoped from the root).
        assert.ok(xml.includes(NS), "root must declare xmlns:pk");
        assert.ok(xml.includes('<identifier pk:line="1" pk:endLine="1">foo</identifier>'));
        assert.ok(xml.includes('<block pk:line="2" pk:endLine="3"/>'));
    });

    it("{§mimetype-channel-architecture} array root wraps in <root> with <item> children", () => {
        const xml = projectJsonToXml(["a", "b", "c"]);
        assert.equal(xml, `<root${NS}><item>a</item><item>b</item><item>c</item></root>`);
    });

    it("{§mimetype-channel-architecture} primitive root wraps in <root>", () => {
        assert.equal(projectJsonToXml("hello"), `<root${NS}>hello</root>`);
        assert.equal(projectJsonToXml(42), `<root${NS}>42</root>`);
    });

    it("{§mimetype-channel-architecture} custom root name applied when no type field", () => {
        const xml = projectJsonToXml({ host: "localhost", port: 8080 }, "server");
        assert.equal(xml, `<server${NS}><host>localhost</host><port>8080</port></server>`);
    });

    it("{§mimetype-channel-architecture} type field wins over rootName", () => {
        const xml = projectJsonToXml({ type: "custom", x: 1 }, "ignored");
        assert.equal(xml, `<custom${NS}><x>1</x></custom>`);
    });

    it("{§mimetype-channel-architecture} escapes XML special characters in text content", () => {
        const json = { type: "literal", text: "a < b && c > d" };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<literal${NS}>a &lt; b &amp;&amp; c &gt; d</literal>`);
    });

    it("{§mimetype-channel-architecture} escapes XML special characters in attribute values", () => {
        const json = { type: "n", line: 'a"b' as unknown as number, x: 1 };
        const xml = projectJsonToXml(json);
        assert.ok(xml.includes('pk:line="a&quot;b"'));
    });

    it("{§mimetype-channel-architecture} null and undefined values are skipped, not serialized as empty elements", () => {
        const json = { type: "n", line: 5, missing: null, present: "x" };
        const xml = projectJsonToXml(json);
        assert.ok(!xml.includes("missing"));
        assert.ok(xml.includes("<present>x</present>"));
    });

    it("{§mimetype-channel-architecture} sanitizes element names with invalid characters", () => {
        const json = { type: "weird/name", x: 1 };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<weird_name${NS}><x>1</x></weird_name>`);
    });

    it("{§mimetype-channel-architecture} array of objects uses each object's own type for element name", () => {
        const json = {
            type: "block",
            children: [
                { type: "stmt", line: 1, endLine: 1 },
                { type: "expr", line: 2, endLine: 2 },
            ],
        };
        const xml = projectJsonToXml(json);
        assert.equal(
            xml,
            `<block${NS}><stmt pk:line="1" pk:endLine="1"/><expr pk:line="2" pk:endLine="2"/></block>`,
        );
    });

    it("{§mimetype-channel-architecture} empty objects render as self-closing element with namespace decl", () => {
        assert.equal(projectJsonToXml({ type: "empty" }), `<empty${NS}/>`);
    });

    it("{§mimetype-channel-architecture} text + children both render: text first, then children", () => {
        const json = { type: "mixed", text: "hello", child: { type: "x" } };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<mixed${NS}>hello<x/></mixed>`);
    });

    it("{§mimetype-channel-architecture} boolean and number primitives in array of primitives render as text", () => {
        const json = { type: "items", flags: [true, false, 42] };
        const xml = projectJsonToXml(json);
        assert.equal(
            xml,
            `<items${NS}><flags>true</flags><flags>false</flags><flags>42</flags></items>`,
        );
    });
});

describe("{§mimetype-channel-architecture} projectJsonToXml: attrs convention for HTML/XML", () => {
    it("{§mimetype-channel-architecture} renders attrs object entries as XML attributes in the default namespace", () => {
        const json = {
            type: "a",
            attrs: { href: "https://example.com", class: "external" },
            text: "click",
        };
        const xml = projectJsonToXml(json);
        assert.ok(xml.includes('href="https://example.com"'));
        assert.ok(xml.includes('class="external"'));
        assert.ok(xml.includes(">click</a>"));
    });

    it("{§mimetype-channel-architecture} combines pk:-bookkeeping + attrs entries on the same element", () => {
        const json = {
            type: "div",
            line: 5,
            attrs: { id: "main" },
            text: "x",
        };
        const xml = projectJsonToXml(json);
        assert.ok(xml.includes('pk:line="5"'));
        assert.ok(xml.includes('id="main"'));
    });

    it("{§mimetype-channel-architecture} skips non-primitive attr values", () => {
        const json = {
            type: "n",
            attrs: { good: "ok", bad: { nested: 1 } },
            text: "x",
        };
        const xml = projectJsonToXml(json);
        assert.ok(xml.includes('good="ok"'));
        assert.ok(!xml.includes("bad"));
    });
});

describe("{§mimetype-channel-architecture} projectJsonToXml: element names from arbitrary keys are sanitized (valid XML)", () => {
    it("{§mimetype-channel-architecture} a key with spaces/punctuation becomes a valid element name", () => {
        // Outline labels are symbol names — arbitrary text. They must not emit
        // invalid XML like <Given x> (parsed as element 'Given' + attr 'x').
        const xml = projectJsonToXml({ "Given a paid invoice": 3 }, "root", () => ({ line: 3, endLine: 3 }));
        assert.ok(xml.includes("<Given_a_paid_invoice"), xml);
        assert.ok(!xml.includes("<Given a"), xml);
        // Round-trips through a strict XML parser without error.
        const readable = ["one", "two", "three"].join("\n");
        const out = queryXpathString(xml, "//Given_a_paid_invoice", "text/test", readable);
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 3,
            startColumn: 1,
            endLine: 3,
            endColumn: 6,
        }]);
    });
});
}

// ─── projectDomToJson.test.ts ───
{
test("{§mimetype-query}: DOM projection locations belong only to the selected source nodes", () => {
    const document = new DOMParser().parseFromString('<item id="old">A<b>B</b>C</item>', "application/xml");
    const item = document.documentElement!;
    const first = item.firstChild!;
    const region: TextRegion = { startLine: 1, startColumn: 16, endLine: 1, endColumn: 17 };
    const projected = projectDomToJson(document, (node) => node === first ? region : undefined);
    assert.deepEqual([...projected.regions], [
        ["/children/0/children/0", [region]],
        ["/children/0/children/0/text", [region]],
    ]);
    assert.deepEqual(projected.value, { type: "document", children: [{ type: "item", attrs: Object.assign(Object.create(null), { id: "old" }), children: [
        { type: "#text", text: "A", line: 1, column: 16, endLine: 1, endColumn: 17 },
        { type: "b", text: "B" },
        { type: "#text", text: "C" },
    ] }] });
});

test("{§mimetype-query}: an attribute and a sole text child retain distinct source locations", () => {
    const document = new DOMParser().parseFromString('<item id="old">text</item>', "application/xml");
    const item = document.documentElement!;
    const attribute = item.attributes.item(0)!;
    const regions = new Map<XmlNode, TextRegion>([
        [attribute, { startLine: 1, startColumn: 7, endLine: 1, endColumn: 15 }],
        [item.firstChild!, { startLine: 1, startColumn: 16, endLine: 1, endColumn: 20 }],
    ]);
    const projected = projectDomToJson(document, (node) => regions.get(node));
    assert.deepEqual([...projected.regions], [
        ["/children/0/attrs/id", [regions.get(attribute)]],
        ["/children/0/text", [regions.get(item.firstChild!)]],
    ]);
    for (const synthetic of ["", "/children/0", "/children/0/type", "/children/0/attrs"]) {
        assert.equal(projected.regions.has(synthetic), false, synthetic);
    }
});
}

// ─── projectJsonToXml.namespace.test.ts ───
{
// Contract: {§mimetype-channel-architecture}.





describe("{§mimetype-channel-architecture} deep-xml is valid XML even with colliding content attrs", () => {
    it("{§mimetype-channel-architecture} source content with line attribute produces parseable XML", () => {
        // Simulates what an XML handler's deepJson would emit for content
        // <root><foo line="5" id="a">text</foo></root>: a tree where the
        // foo element has both framework bookkeeping (line: 1, endLine: 1
        // from the parser's positional info) AND a content attribute named
        // `line` (value "5") under the `attrs` channel.
        const json = {
            type: "root",
            line: 1,
            endLine: 1,
            children: [{
                type: "foo",
                line: 1,
                endLine: 1,
                attrs: { line: "5", id: "a" },
                text: "text",
            }],
        };
        const xml = projectJsonToXml(json);
        // The XML must parse without error — pre-fix this threw
        // ParseError: Attribute line redefined.
        const errors: unknown[] = [];
        new DOMParser({
            onError: (level, msg) => { if (level !== "warning") errors.push(msg); },
        }).parseFromString(xml, "text/xml");
        assert.equal(errors.length, 0, `parse errors: ${errors.join("; ")}`);
    });

    it("{§mimetype-channel-architecture} source content with endLine attribute produces parseable XML", () => {
        const json = {
            type: "config",
            attrs: { endLine: "should-not-collide", priority: "high" },
        };
        const xml = projectJsonToXml(json);
        const errors: unknown[] = [];
        new DOMParser({
            onError: (level, msg) => { if (level !== "warning") errors.push(msg); },
        }).parseFromString(xml, "text/xml");
        assert.equal(errors.length, 0);
    });

    it("{§mimetype-channel-architecture} all five potentially-colliding bookkeeping fields are safely namespaced", () => {
        const json = {
            type: "n",
            line: 1, endLine: 2, column: 3, endColumn: 4, level: 5,
            attrs: {
                line: "content-line",
                endLine: "content-endLine",
                column: "content-column",
                endColumn: "content-endColumn",
                level: "content-level",
            },
        };
        const xml = projectJsonToXml(json);
        // Parse must succeed — no duplicate-attribute errors.
        const errors: unknown[] = [];
        new DOMParser({
            onError: (level, msg) => { if (level !== "warning") errors.push(msg); },
        }).parseFromString(xml, "text/xml");
        assert.equal(errors.length, 0);
        // Both versions must be present and distinguishable.
        assert.ok(xml.includes('pk:line="1"'), "framework bookkeeping under pk:");
        assert.ok(xml.includes('line="content-line"'), "content attr in default namespace");
    });
});

describe("{§mimetype-channel-architecture} bookkeeping attrs use a reserved namespace", () => {
    it("{§mimetype-channel-architecture} the root element declares xmlns:pk", () => {
        const xml = projectJsonToXml({ type: "x", line: 1 });
        assert.ok(
            xml.includes('xmlns:pk="https://plurnk.xyz/deep-xml/1"'),
            "root must declare the pk namespace",
        );
    });

    it("{§mimetype-channel-architecture} framework attrs render as pk:line, not line", () => {
        const xml = projectJsonToXml({ type: "x", line: 5, endLine: 10, column: 3 });
        assert.ok(xml.includes('pk:line="5"'));
        assert.ok(xml.includes('pk:endLine="10"'));
        assert.ok(xml.includes('pk:column="3"'));
        // The unprefixed form must NOT appear (would collide with content
        // attrs of the same name).
        assert.ok(!/[\s]line="5"/.test(xml), "unprefixed line attr must not appear");
        assert.ok(!/[\s]endLine="10"/.test(xml), "unprefixed endLine attr must not appear");
    });

    it("{§mimetype-channel-architecture} content attrs (the `attrs` field) render in the default namespace", () => {
        const xml = projectJsonToXml({
            type: "a",
            attrs: { href: "x", class: "y" },
        });
        assert.ok(xml.includes('href="x"'));
        assert.ok(xml.includes('class="y"'));
        // Not prefixed with pk:
        assert.ok(!xml.includes('pk:href'));
        assert.ok(!xml.includes('pk:class'));
    });
});

describe("{§mimetype-channel-architecture} consumer can strip bookkeeping cleanly", () => {
    it("{§mimetype-channel-architecture} removing all pk:* attrs leaves content attrs intact", () => {
        const xml = projectJsonToXml({
            type: "user",
            line: 5,
            endLine: 8,
            attrs: { line: "content-5", id: "u1" },
            text: "Alice",
        });
        // A consumer's simple regex strip — exactly the pattern
        // a stripper could use:
        const cleaned = xml.replace(/\s+pk:[a-zA-Z]+="[^"]*"/g, "");
        // The root might still have xmlns:pk — that's fine, separate strip.
        const fullClean = cleaned.replace(/\s+xmlns:pk="[^"]*"/g, "");
        // Content attrs survive.
        assert.ok(fullClean.includes('line="content-5"'), "content line attr survives strip");
        assert.ok(fullClean.includes('id="u1"'), "content id attr survives strip");
        // No bookkeeping left.
        assert.ok(!fullClean.includes("pk:"), "no pk:* remains after strip");
        assert.ok(!/[\s]line="5"/.test(fullClean), "framework line=5 is gone");
        assert.ok(!/[\s]endLine="8"/.test(fullClean), "framework endLine=8 is gone");
    });
});
}

// ─── projectLineFor.test.ts ───
{
// {§mimetype-query}: projectJsonToXml's lineFor stamps pk:line so xpath-over-deepXml gets the
// SAME real source lines as jsonpath for handlers whose deepJson is raw,
// position-less data (JSON/INI/…). And xpath omits lines (never fakes 1) when
// the projection carries no position at all.





describe("{§mimetype-query} — projectJsonToXml lineFor + xpath honesty", () => {
    it("{§mimetype-channel-architecture} stamps pk:line from the resolver, including nested pointers", () => {
        const deepJson = { host: "x", pool: { size: 5 } };
        const readable = Array.from({ length: 5 }, () => "x").join("\n");
        const lineFor = (p: string) =>
            (({ "/host": { line: 2, endLine: 2 }, "/pool": { line: 3, endLine: 5 }, "/pool/size": { line: 4, endLine: 4 } }) as Record<string, { line: number; endLine: number }>)[p];
        const xml = projectJsonToXml(deepJson, "root", lineFor);
        assert.deepEqual(queryXpathString(xml, "//host", "x", readable)[0].enclosingRegions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 2,
        }]);
        assert.deepEqual(queryXpathString(xml, "//size", "x", readable)[0].enclosingRegions, [{
            startLine: 4, startColumn: 1, endLine: 4, endColumn: 2,
        }]);
        assert.deepEqual(queryXpathString(xml, "//pool", "x", readable)[0].enclosingRegions, [{
            startLine: 3, startColumn: 1, endLine: 5, endColumn: 2,
        }]);
    });

    it("{§mimetype-channel-architecture} a source resolver owns coordinates even when source data contains a line field", () => {
        const readable = Array.from({ length: 9 }, () => "x").join("\n");
        const xml = projectJsonToXml({ type: "n", line: 9, endLine: 9, text: "v" }, "root", () => ({ line: 1, endLine: 1 }));
        assert.deepEqual(queryXpathString(xml, "//n", "x", readable)[0].enclosingRegions, [{
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 2,
        }]);
    });

    it("{§mimetype-channel-architecture} xpath retains only its locator when the projection has no position", () => {
        const xml = projectJsonToXml({ host: "x" }, "root"); // no lineFor, no line fields
        const match = queryXpathString(xml, "//host", "x")[0];
        assert.equal(match.regions, undefined);
        assert.equal(match.matching, "//host");
    });
});
}
