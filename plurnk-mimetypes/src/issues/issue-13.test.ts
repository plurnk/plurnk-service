// Issue #13: deep-xml channel: three contract refinements — service-side
// input requested.
// https://github.com/plurnk/mimetypes/issues/13
//
// Three questions; service answered A/A/A. Test file enforces the answers as
// contracts so future refactors can't drift from them.
//
//   Q1 (A). xpath dispatch returns QueryMatch.line from the matched element's
//           pk:line attribute (the framework's projected source-line
//           bookkeeping). Symmetric to jsonpath, which already returns the
//           correct source line.
//   Q2 (A). Trivial/empty deepXml stays as-is (covered indirectly by
//           issue-10 tests; no incremental claim here).
//   Q3 (A). application-xml's deepXml stays as a projection — pk:line on
//           every element is load-bearing for the find→EDIT flow. The
//           handler does not override deepXml() to expose raw source.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "../BaseHandler.ts";
import type { MimeSymbol } from "../types.ts";

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

describe("Issue #13 — Q1: xpath QueryMatch.line reflects pk:line on element", () => {
    it("element match returns the source line from pk:line", async () => {
        const h = new FakeTreeHandler(meta);
        const matches = await h.query("anything", "xpath", "//function");
        assert.equal(matches.length, 2);
        // The two function elements have pk:line="42" and pk:line="73".
        const lines = matches.map((m) => m.line).sort((a, b) => a - b);
        assert.deepEqual(lines, [42, 73]);
    });

    it("single match returns the right line", async () => {
        const h = new FakeTreeHandler(meta);
        const matches = await h.query(
            "anything",
            "xpath",
            "//function[name='fn_b']",
        );
        assert.equal(matches.length, 1);
        assert.equal(matches[0].line, 73);
    });

    it("primitive results (string/number/boolean) fall back to line 1", async () => {
        const h = new FakeTreeHandler(meta);
        const matches = await h.query("anything", "xpath", "count(//function)");
        assert.equal(matches.length, 1);
        // count(...) returns a number — no node to read pk:line from.
        assert.equal(matches[0].line, 1);
        assert.equal(matches[0].matched, "2");
    });

    it("symmetry with jsonpath: same logical query returns the same source line", async () => {
        const h = new FakeTreeHandler(meta);
        const viaJsonpath = await h.query(
            "anything",
            "jsonpath",
            "$..children[?(@.type=='function' && @.name=='fn_a')]",
        );
        const viaXpath = await h.query(
            "anything",
            "xpath",
            "//function[name='fn_a']",
        );
        assert.equal(viaJsonpath.length, 1);
        assert.equal(viaXpath.length, 1);
        // Both should report line 42 — jsonpath via deepMinLine on the
        // matched subtree, xpath via pk:line on the element.
        assert.equal(viaJsonpath[0].line, 42);
        assert.equal(viaXpath[0].line, 42);
    });
});
