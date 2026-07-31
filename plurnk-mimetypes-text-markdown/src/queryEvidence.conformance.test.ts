import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextMarkdown.ts";

// A block node maps exactly to its source lines; a scalar field maps to the
// nearest honest enclosing block.
const h = new Handler({"mimetype":"text/markdown","glyph":"📝","extensions":[".md",".markdown"]});
const src = "# Alpha\n\nintro\n\n## Beta\n";

describe("query-evidence conformance (both dialects)", () => {
    it("jsonpath distinguishes exact block and enclosing scalar evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.children[0]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 8,
                }]],
            },
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.children[0].text",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 8,
                }]],
            },
        ]);
    });
    it("xpath distinguishes exact block and enclosing scalar evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "xpath",
                pattern: "(//heading)[1]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 8,
                }]],
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "(//heading)[1]/text",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 8,
                }]],
            },
        ]);
    });
});
