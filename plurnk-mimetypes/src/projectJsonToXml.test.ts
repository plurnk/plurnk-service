// Coverage: SPEC §12 (deep-xml projection).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { queryXpathString } from "./query.ts";

const NS = ' xmlns:pk="https://plurnk.dev/deep-xml/1"';

describe("projectJsonToXml — convention parity with jsonpath shape", () => {
    it("function_definition with pk:line/pk:endLine attributes, name as child, params as repeated siblings", () => {
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

    it("leaf node with text content renders text inside its tag", () => {
        const json = { type: "identifier", line: 5, endLine: 5, text: "greet" };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<identifier${NS} pk:line="5" pk:endLine="5">greet</identifier>`);
    });

    it("nested children render as nested elements named by their own type; bookkeeping stays in pk: namespace", () => {
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

    it("array root wraps in <root> with <item> children", () => {
        const xml = projectJsonToXml(["a", "b", "c"]);
        assert.equal(xml, `<root${NS}><item>a</item><item>b</item><item>c</item></root>`);
    });

    it("primitive root wraps in <root>", () => {
        assert.equal(projectJsonToXml("hello"), `<root${NS}>hello</root>`);
        assert.equal(projectJsonToXml(42), `<root${NS}>42</root>`);
    });

    it("custom root name applied when no type field", () => {
        const xml = projectJsonToXml({ host: "localhost", port: 8080 }, "server");
        assert.equal(xml, `<server${NS}><host>localhost</host><port>8080</port></server>`);
    });

    it("type field wins over rootName", () => {
        const xml = projectJsonToXml({ type: "custom", x: 1 }, "ignored");
        assert.equal(xml, `<custom${NS}><x>1</x></custom>`);
    });

    it("escapes XML special characters in text content", () => {
        const json = { type: "literal", text: "a < b && c > d" };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<literal${NS}>a &lt; b &amp;&amp; c &gt; d</literal>`);
    });

    it("escapes XML special characters in attribute values", () => {
        const json = { type: "n", line: 'a"b' as unknown as number, x: 1 };
        const xml = projectJsonToXml(json);
        assert.ok(xml.includes('pk:line="a&quot;b"'));
    });

    it("null and undefined values are skipped, not serialized as empty elements", () => {
        const json = { type: "n", line: 5, missing: null, present: "x" };
        const xml = projectJsonToXml(json);
        assert.ok(!xml.includes("missing"));
        assert.ok(xml.includes("<present>x</present>"));
    });

    it("sanitizes element names with invalid characters", () => {
        const json = { type: "weird/name", x: 1 };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<weird_name${NS}><x>1</x></weird_name>`);
    });

    it("array of objects uses each object's own type for element name", () => {
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

    it("empty objects render as self-closing element with namespace decl", () => {
        assert.equal(projectJsonToXml({ type: "empty" }), `<empty${NS}/>`);
    });

    it("text + children both render: text first, then children", () => {
        const json = { type: "mixed", text: "hello", child: { type: "x" } };
        const xml = projectJsonToXml(json);
        assert.equal(xml, `<mixed${NS}>hello<x/></mixed>`);
    });

    it("boolean and number primitives in array of primitives render as text", () => {
        const json = { type: "items", flags: [true, false, 42] };
        const xml = projectJsonToXml(json);
        assert.equal(
            xml,
            `<items${NS}><flags>true</flags><flags>false</flags><flags>42</flags></items>`,
        );
    });
});

describe("projectJsonToXml — attrs convention for HTML/XML", () => {
    it("renders attrs object entries as XML attributes in the default namespace", () => {
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

    it("combines pk:-bookkeeping + attrs entries on the same element", () => {
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

    it("skips non-primitive attr values", () => {
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

describe("projectJsonToXml — element names from arbitrary keys are sanitized (valid XML)", () => {
    it("a key with spaces/punctuation becomes a valid element name", () => {
        // Outline labels are symbol names — arbitrary text. They must not emit
        // invalid XML like <Given x> (parsed as element 'Given' + attr 'x').
        const xml = projectJsonToXml({ "Given a paid invoice": 3 }, "root", () => ({ line: 3, endLine: 3 }));
        assert.ok(xml.includes("<Given_a_paid_invoice"), xml);
        assert.ok(!xml.includes("<Given a"), xml);
        // Round-trips through a strict XML parser without error.
        const out = queryXpathString(xml, "//Given_a_paid_invoice", "text/test");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].lines, [{ line: 3, endLine: 3 }]);
    });
});
