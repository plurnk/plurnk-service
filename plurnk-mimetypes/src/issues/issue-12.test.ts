// Issue #12: deep-xml: line/endLine source-position attrs collide with content
// attributes → invalid XML.
// https://github.com/plurnk/plurnk-mimetypes/issues/12
//
// Issue #12's load-bearing claims, restated as testable contracts:
//
//   C1. deep-xml is ALWAYS valid XML — even when content has attributes
//       named line, endLine, column, endColumn, or level.
//   C2. Framework-emitted source-position attributes live in a reserved
//       namespace (xmlns:pk="https://plurnk.dev/deep-xml/1") so they are
//       structurally distinguishable from content attributes.
//   C3. A consumer can strip framework bookkeeping from a matched node
//       (for clean model-facing serialization) without affecting
//       legitimate content attributes of the same name.
//
// Reproduction from the issue:
//   process({ content: '<root><foo line="5" id="a">text</foo></root>',
//             hint: "application/xml" })
// pre-fix: deep-xml had `<foo line="1" endLine="1" line="5" id="a">` —
// duplicate `line` attr → @xmldom/xmldom throws on parse.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import { projectJsonToXml } from "../projectJsonToXml.ts";

describe("Issue #12 — C1: deep-xml is valid XML even with colliding content attrs", () => {
    it("source content with line attribute produces parseable XML", () => {
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
            errorHandler: (level, msg) => { if (level !== "warning") errors.push(msg); },
        }).parseFromString(xml, "text/xml");
        assert.equal(errors.length, 0, `parse errors: ${errors.join("; ")}`);
    });

    it("source content with endLine attribute produces parseable XML", () => {
        const json = {
            type: "config",
            attrs: { endLine: "should-not-collide", priority: "high" },
        };
        const xml = projectJsonToXml(json);
        const errors: unknown[] = [];
        new DOMParser({
            errorHandler: (level, msg) => { if (level !== "warning") errors.push(msg); },
        }).parseFromString(xml, "text/xml");
        assert.equal(errors.length, 0);
    });

    it("all five potentially-colliding bookkeeping fields are safely namespaced", () => {
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
            errorHandler: (level, msg) => { if (level !== "warning") errors.push(msg); },
        }).parseFromString(xml, "text/xml");
        assert.equal(errors.length, 0);
        // Both versions must be present and distinguishable.
        assert.ok(xml.includes('pk:line="1"'), "framework bookkeeping under pk:");
        assert.ok(xml.includes('line="content-line"'), "content attr in default namespace");
    });
});

describe("Issue #12 — C2: bookkeeping attrs use a reserved namespace", () => {
    it("the root element declares xmlns:pk", () => {
        const xml = projectJsonToXml({ type: "x", line: 1 });
        assert.ok(
            xml.includes('xmlns:pk="https://plurnk.dev/deep-xml/1"'),
            "root must declare the pk namespace",
        );
    });

    it("framework attrs render as pk:line, not line", () => {
        const xml = projectJsonToXml({ type: "x", line: 5, endLine: 10, column: 3 });
        assert.ok(xml.includes('pk:line="5"'));
        assert.ok(xml.includes('pk:endLine="10"'));
        assert.ok(xml.includes('pk:column="3"'));
        // The unprefixed form must NOT appear (would collide with content
        // attrs of the same name).
        assert.ok(!/[\s]line="5"/.test(xml), "unprefixed line attr must not appear");
        assert.ok(!/[\s]endLine="10"/.test(xml), "unprefixed endLine attr must not appear");
    });

    it("content attrs (the `attrs` field) render in the default namespace", () => {
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

describe("Issue #12 — C3: consumer can strip bookkeeping cleanly", () => {
    it("removing all pk:* attrs leaves content attrs intact", () => {
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
