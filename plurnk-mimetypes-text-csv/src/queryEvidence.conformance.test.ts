import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextCsv.ts";

// {§mimetype-query}: records and fields retain actual physical source spans.
const h = new Handler({"mimetype":"text/csv","glyph":"📊","extensions":[".csv"]});
const src = "name,age\nalice,30\nbob,25\n";

describe("query-evidence conformance (both dialects)", () => {
    for (const eol of ["\n", "\r\n", "\r"]) for (const dialect of ["jsonpath", "xpath"] as const) {
        it(`${dialect} locates a multiline record and the record after it, ${JSON.stringify(eol)}`, async () => {
            const source = ['name,note', 'alice,"first', 'second"', 'bob,ok'].join(eol);
            await assertQueryEvidenceConformance(h, [
                {
                    source, dialect,
                    pattern: dialect === "jsonpath" ? "$[0].note" : "//item[1]/note",
                    verdict: "enclosing",
                    expectRegions: [[{ startLine: 2, startColumn: 1, endLine: 3, endColumn: 8 }]],
                },
                {
                    source, dialect,
                    pattern: dialect === "jsonpath" ? "$[1].name" : "//item[2]/name",
                    verdict: "enclosing",
                    expectRegions: [[{ startLine: 4, startColumn: 1, endLine: 4, endColumn: 7 }]],
                },
            ]);
        });
    }

    it("jsonpath distinguishes exact rows from enclosing field evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$[0]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
                }]],
            },
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$[0].name",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
                }]],
            },
        ]);
    });
    it("xpath distinguishes exact rows from enclosing field evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "xpath",
                pattern: "//item[1]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
                }]],
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "//item[1]/name",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
                }]],
            },
        ]);
    });
});
