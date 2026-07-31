// The query-evidence conformance gate requires an explicit exact, enclosing,
// locator-only, or unsupported verdict. "Defect" is a red test, not a passing
// classification.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import { assertQueryEvidenceConformance } from "./conformance.ts";
import type { MimeSymbol } from "./types.ts";

// A compliant handler: deepJson carries line/endLine, so the framework's
// default jsonpath resolver returns accurate regions with zero handler code.
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

const readable = Array.from({ length: 9 }, () => "x").join("\n");

describe("query-evidence conformance gate", () => {
    it("passes exact text evidence with complete expected coordinates", async () => {
        const h = new BaseHandler(md);
        await assertQueryEvidenceConformance(h, [{
            source: "alpha\nbeta",
            dialect: "regex",
            pattern: "beta",
            verdict: "exact",
            expectRegions: [[{
                startLine: 2,
                startColumn: 1,
                endLine: 2,
                endColumn: 5,
            }]],
        }]);
    });

    it("passes a declared honest enclosing structural region", async () => {
        const h = new CompliantHandler(md);
        await assertQueryEvidenceConformance(h, [{
            source: readable,
            dialect: "jsonpath",
            pattern: "$.children[0].name",
            verdict: "enclosing",
            expectRegions: [[{
                startLine: 3,
                startColumn: 1,
                endLine: 5,
                endColumn: 2,
            }]],
        }]);
    });

    it("rejects locator-only output when an exact region is required", async () => {
        const h = new NonCompliantHandler(md);
        await assert.rejects(
            () => assertQueryEvidenceConformance(h, [
                {
                    source: "host",
                    dialect: "jsonpath",
                    pattern: "$.host",
                    verdict: "exact",
                    expectRegions: [[{
                        startLine: 1,
                        startColumn: 1,
                        endLine: 1,
                        endColumn: 5,
                    }]],
                },
            ]),
            /exact match has no region/,
        );
    });

    it("passes honest locator-only structural output", async () => {
        const h = new NonCompliantHandler(md);
        await assertQueryEvidenceConformance(h, [
            {
                source: "host",
                dialect: "jsonpath",
                pattern: "$.host",
                verdict: "locator-only",
            },
        ]);
    });

    it("rejects fabricated regions from locator-only output", async () => {
        await assert.rejects(
            () => assertQueryEvidenceConformance(
                {
                    query: async () => [{
                        matched: "x",
                        matching: "$.host",
                        regions: [{
                            startLine: 1,
                            startColumn: 1,
                            endLine: 1,
                            endColumn: 2,
                        }],
                    }],
                },
                [{
                    source: "x",
                    dialect: "jsonpath",
                    pattern: "$.host",
                    verdict: "locator-only",
                }],
            ),
            /fabricated text regions/,
        );
    });

    it("accepts a computed scalar with its expression as the locator", async () => {
        await assertQueryEvidenceConformance(
            { query: async () => [{ matched: "2", matching: "count(//a)" }] },
            [{
                source: "x",
                dialect: "xpath",
                pattern: "count(//a)",
                verdict: "locator-only",
            }],
        );
    });

    it("passes only an explicit UnsupportedDialectError as unsupported", async () => {
        const h = new BaseHandler(md);
        await assertQueryEvidenceConformance(h, [{
            source: "plain text",
            dialect: "xpath",
            pattern: "//*",
            verdict: "unsupported",
        }]);
    });

    it("rejects a different failure under an unsupported verdict", async () => {
        await assert.rejects(
            () => assertQueryEvidenceConformance(
                {
                    query: async () => {
                        throw new Error("broken");
                    },
                },
                [{
                    source: "x",
                    dialect: "xpath",
                    pattern: "//*",
                    verdict: "unsupported",
                }],
            ),
            /unsupported verdict must throw UnsupportedDialectError/,
        );
    });
});
