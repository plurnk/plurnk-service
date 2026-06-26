// Issue #41: structural-query matches report the SOURCE-LINE footprint.
// https://github.com/plurnk/plurnk-mimetypes/issues/41
//
// Contracts:
//   C1. jsonpath match on a node with explicit line/endLine → that span.
//   C2. jsonpath match on a PRIMITIVE resolves to the nearest enclosing
//       line-annotated node (walk-up via the JSON pointer).
//   C3. a handler-supplied lineFor (source-position fidelity) wins, by pointer.
//   C4. xpath node match → [pk:line .. pk:endLine] span.
//   C5. xpath computed scalar (count/string/…) → no lines (node-less).
//   C6. the value is always reported, regardless of line resolution.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { queryJsonpathObject, queryXpathString } from "../query.ts";

// A synthesized deepJson document model (PDF-shaped): line-annotated nodes,
// metadata as document-level primitives.
const model = {
    type: "document",
    line: 1,
    endLine: 10,
    metadata: { title: "Quarterly Report", pageCount: 10 },
    children: [
        { type: "heading", name: "Introduction", line: 3, endLine: 5 },
        { type: "heading", name: "Method", line: 6, endLine: 9 },
    ],
};

describe("issue #41 — structural matches report source-line spans", () => {
    it("C1: a node with explicit line/endLine reports that span", () => {
        const out = queryJsonpathObject(model, "$.children[0]");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].lines, [{ line: 3, endLine: 5 }]);
    });

    it("C2: a primitive resolves to the nearest enclosing annotated node", () => {
        const heading = queryJsonpathObject(model, "$.children[1].name");
        assert.equal(heading[0].matched, "Method");
        assert.deepEqual(heading[0].lines, [{ line: 6, endLine: 9 }], "walks up to children[1]");

        // metadata has no line of its own → walks up to the document span.
        const title = queryJsonpathObject(model, "$.metadata.title");
        assert.equal(title[0].matched, "Quarterly Report");
        assert.deepEqual(title[0].lines, [{ line: 1, endLine: 10 }]);
    });

    it("C3: a handler-supplied lineFor (by pointer) wins for source fidelity", () => {
        const out = queryJsonpathObject(
            { host: "db.internal", pool: 5 },
            "$.host",
            (pointer) => (pointer === "/host" ? [{ line: 2, endLine: 2 }] : undefined),
        );
        assert.equal(out[0].matched, "db.internal");
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 2 }]);
    });

    it("C4: xpath node match spans pk:line..pk:endLine", () => {
        const xml = '<root xmlns:pk="https://plurnk.dev/deep-xml/1">'
            + '<function pk:line="5" pk:endLine="12">body</function></root>';
        const out = queryXpathString(xml, "//function", "application/x-test");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].lines, [{ line: 5, endLine: 12 }]);
    });

    it("C5: xpath computed scalar carries no lines", () => {
        const xml = '<root xmlns:pk="https://plurnk.dev/deep-xml/1">'
            + '<a pk:line="1"/><a pk:line="2"/></root>';
        const out = queryXpathString(xml, "count(//a)", "application/x-test");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "2");
        assert.equal(out[0].lines, undefined);
    });

    it("C6: value is always present even when lines can't be resolved", () => {
        // Raw JSON, no annotations and no lineFor → lines absent, value intact.
        const out = queryJsonpathObject({ a: { b: "deep" } }, "$.a.b");
        assert.equal(out[0].matched, "deep");
        assert.equal(out[0].lines, undefined);
    });
});
