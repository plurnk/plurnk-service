import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance, assertQueryEvidenceConformance, type ConformanceHandler, type ConformanceFixture } from "./conformance.ts";
import type { MimeRef, MimeSymbol } from "./types.ts";
import BaseHandler from "./BaseHandler.ts";

// ─── conformance.public.test.ts ───
{
// {§mimetype-references}: the references-conformance harness is public — a third-party handler
// author imports assertHandlerConformance from @plurnk/plurnk-mimetypes/
// conformance and runs the {§mimetype-references} invariants against their OWN handler
// instance, with no registry involvement. This proves the decoupled entry
// (src/conformance.ts) drives a bare duck handler, the same invariants the
// in-registry suites run through the wrapper.






// A minimal synthetic handler: class `Helper` with method `run`, and inside
// run an instantiation of Helper. No tree-sitter, no registry — just the duck
// surface, exactly what a Tier 4 hand-roll author would pass.
const SYMBOLS: MimeSymbol[] = [
    { name: "Helper", kind: "class", line: 1, endLine: 5, column: 7, endColumn: 13 },
    { name: "run", kind: "method", line: 2, endLine: 4, column: 5, endColumn: 8, container: "Helper" },
];
const REFS: MimeRef[] = [
    { name: "Helper", kind: "instantiate", line: 3, column: 9, endLine: 3, endColumn: 15, container: "Helper.run" },
];

const SOURCE = "class Helper {\n  run() {\n    new Helper() // SECRET note\n  }\n}\n";

function handlerWith(refs: MimeRef[]): ConformanceHandler {
    return { extractRaw: () => SYMBOLS, references: () => refs };
}

const FIXTURE: ConformanceFixture = {
    source: SOURCE,
    decoyNames: ["SECRET", "note"],
    expectJoins: [{ refName: "Helper", container: "Helper.run" }],
    expectRefs: [{ name: "Helper", kind: "instantiate" }],
};

describe("{§mimetype-references} public conformance harness", () => {
    it("{§mimetype-references} a conformant handler passes and returns its symbols + references", async () => {
        const { symbols, references } = await assertHandlerConformance(handlerWith(REFS), FIXTURE);
        assert.equal(symbols.length, 2);
        assert.equal(references.length, 1);
    });

    it("{§mimetype-references} a decoy surfacing as a ref fails the invariant", async () => {
        const leaky = handlerWith([
            ...REFS,
            { name: "SECRET", kind: "call", line: 3, column: 18, endLine: 3, endColumn: 24, container: "Helper.run" },
        ]);
        await assert.rejects(
            () => assertHandlerConformance(leaky, FIXTURE),
            /decoy "SECRET" .* surfaced as a ref/,
        );
    });

    it("{§mimetype-references} a ref whose container is not an emitted def fails", async () => {
        const orphan = handlerWith([
            { name: "Helper", kind: "instantiate", line: 3, column: 9, endLine: 3, endColumn: 15, container: "Nope.gone" },
        ]);
        await assert.rejects(
            () => assertHandlerConformance(orphan, FIXTURE),
            /container "Nope.gone" must be an emitted def path/,
        );
    });

    it("{§mimetype-references} a refs-free handler is rejected — this harness is for refs-emitting handlers", async () => {
        await assert.rejects(
            () => assertHandlerConformance(handlerWith([]), FIXTURE),
            /at least one ref/,
        );
    });
});
}

// ─── conformance.queryEvidence.test.ts ───
{
// The query-evidence conformance gate requires an explicit exact, enclosing,
// locator-only, or unsupported verdict. "Defect" is a red test, not a passing
// classification.






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

describe("{§mimetype-query} query-evidence conformance gate", () => {
    it("{§mimetype-query} rejects enclosing coordinates mislabeled as an exact selected region", async () => {
        const region = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 };
        await assert.rejects(() => assertQueryEvidenceConformance({ query: async () => [{ matched: "a", regions: [region] }] }, [{
            source: "abc", dialect: "jsonpath", pattern: "$.name", verdict: "enclosing", expectRegions: [[region]],
        }]), /enclosing evidence was classified incorrectly/);
    });
    it("{§mimetype-query} passes exact text evidence with complete expected coordinates", async () => {
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

    it("{§mimetype-query} passes a declared honest enclosing structural region", async () => {
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

    it("{§mimetype-query} rejects locator-only output when an exact region is required", async () => {
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

    it("{§mimetype-query} passes honest locator-only structural output", async () => {
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

    it("{§mimetype-query} rejects fabricated regions from locator-only output", async () => {
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

    it("{§mimetype-query} accepts a computed scalar with its expression as the locator", async () => {
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

    it("{§mimetype-query} passes only an explicit UnsupportedDialectError as unsupported", async () => {
        const h = new BaseHandler(md);
        await assertQueryEvidenceConformance(h, [{
            source: "plain text",
            dialect: "xpath",
            pattern: "//*",
            verdict: "unsupported",
        }]);
    });

    it("{§mimetype-query} rejects a different failure under an unsupported verdict", async () => {
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
}
