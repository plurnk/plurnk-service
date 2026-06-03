import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectJsonToXml } from "./projectJsonToXml.ts";

describe("projectJsonToXml — convention parity with jsonpath shape", () => {
    it("function_definition with line/endLine attributes, name as child, params as repeated siblings", () => {
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
            '<function_definition line="5" endLine="10"><name>greet</name><params>x</params><params>y</params></function_definition>',
        );
    });

    it("leaf node with text content renders text inside its tag", () => {
        const json = { type: "identifier", line: 5, endLine: 5, text: "greet" };
        const xml = projectJsonToXml(json);
        assert.equal(xml, '<identifier line="5" endLine="5">greet</identifier>');
    });

    it("nested children render as nested elements named by their own type", () => {
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
        assert.ok(xml.includes('<identifier line="1" endLine="1">foo</identifier>'));
        assert.ok(xml.includes('<block line="2" endLine="3"/>'));
    });

    it("array root wraps in <root> with <item> children", () => {
        const xml = projectJsonToXml(["a", "b", "c"]);
        assert.equal(xml, "<root><item>a</item><item>b</item><item>c</item></root>");
    });

    it("primitive root wraps in <root>", () => {
        assert.equal(projectJsonToXml("hello"), "<root>hello</root>");
        assert.equal(projectJsonToXml(42), "<root>42</root>");
    });

    it("custom root name applied when no type field", () => {
        const xml = projectJsonToXml({ host: "localhost", port: 8080 }, "server");
        assert.equal(xml, "<server><host>localhost</host><port>8080</port></server>");
    });

    it("type field wins over rootName", () => {
        const xml = projectJsonToXml({ type: "custom", x: 1 }, "ignored");
        assert.equal(xml, "<custom><x>1</x></custom>");
    });

    it("escapes XML special characters in text content", () => {
        const json = { type: "literal", text: "a < b && c > d" };
        const xml = projectJsonToXml(json);
        assert.equal(xml, "<literal>a &lt; b &amp;&amp; c &gt; d</literal>");
    });

    it("escapes XML special characters in attribute values", () => {
        const json = { type: "n", line: 'a"b' as unknown as number, x: 1 };
        const xml = projectJsonToXml(json);
        assert.ok(xml.includes('line="a&quot;b"'));
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
        assert.equal(xml, "<weird_name><x>1</x></weird_name>");
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
            '<block><stmt line="1" endLine="1"/><expr line="2" endLine="2"/></block>',
        );
    });

    it("empty objects render as self-closing element", () => {
        assert.equal(projectJsonToXml({ type: "empty" }), "<empty/>");
    });

    it("text + children both render: text first, then children", () => {
        // Unusual but possible; doc the rule via test.
        const json = { type: "mixed", text: "hello", child: { type: "x" } };
        const xml = projectJsonToXml(json);
        assert.equal(xml, "<mixed>hello<x/></mixed>");
    });

    it("boolean and number primitives in array of primitives render as text", () => {
        const json = { type: "items", flags: [true, false, 42] };
        const xml = projectJsonToXml(json);
        assert.equal(
            xml,
            "<items><flags>true</flags><flags>false</flags><flags>42</flags></items>",
        );
    });
});
