// The #41 query-line conformance gate must (a) pass a compliant handler and
// (b) FAIL a non-compliant one — otherwise it enforces nothing. This is the
// mechanism that keeps the source-line contract uniform across every handler:
// a structural match without `lines` is a red build, not a latent bug.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import { assertQueryLineConformance } from "./conformance.ts";
import type { MimeSymbol } from "./types.ts";

// A compliant handler: deepJson carries line/endLine, so the framework's
// default jsonpath resolver returns accurate spans with zero handler code.
class CompliantHandler extends BaseHandler {
    override deepJson(): unknown {
        return {
            type: "document",
            line: 1,
            endLine: 9,
            children: [
                { name: "Intro", line: 3, endLine: 5 },
                { name: "Method", line: 6, endLine: 9 },
            ],
        };
    }
}

// A non-compliant handler: deepJson with NO line annotations → jsonpath matches
// come back line-less. The gate must catch this.
class NonCompliantHandler extends BaseHandler {
    override deepJson(): unknown {
        return { host: "db.internal", pool: 5 };
    }
    override extractRaw(): MimeSymbol[] {
        return [];
    }
}

const md = { mimetype: "application/x-test", glyph: "?", extensions: [".t"] as const };

describe("#41 query-line conformance gate", () => {
    it("passes a handler whose structural matches carry accurate spans", async () => {
        const h = new CompliantHandler(md);
        await assertQueryLineConformance(h, [
            { source: "(unused)", dialect: "jsonpath", pattern: "$.children[*]", expectStartLines: [3, 6] },
            { source: "(unused)", dialect: "jsonpath", pattern: "$.children[0].name", expectStartLines: [3] },
        ]);
    });

    it("FAILS a handler whose structural matches lack lines (the bug it guards)", async () => {
        const h = new NonCompliantHandler(md);
        await assert.rejects(
            () => assertQueryLineConformance(h, [
                { source: "(unused)", dialect: "jsonpath", pattern: "$.host", expectStartLines: [1] },
            ]),
            /no lines \(#41\)/,
        );
    });

    it("accepts a node-less computed scalar carrying no lines", async () => {
        const h = new CompliantHandler(md);
        // jsonpath has no aggregate scalars; a $.length-style miss returns []
        // — exercise the scalar mode via a handler returning a scalar match.
        await assertQueryLineConformance(
            { query: async () => [{ matched: "2" }] },
            [{ source: "x", dialect: "xpath", pattern: "count(//a)", expectStartLines: [], scalar: true }],
        );
    });
});
