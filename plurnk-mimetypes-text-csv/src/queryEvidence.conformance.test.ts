import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextCsv.ts";

// A record maps exactly to its source row; a field maps to that honest
// enclosing row when CSV has no embedded physical newlines.
const h = new Handler({"mimetype":"text/csv","glyph":"📊","extensions":[".csv"]});
const src = "name,age\nalice,30\nbob,25\n";

describe("query-evidence conformance (both dialects)", () => {
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
