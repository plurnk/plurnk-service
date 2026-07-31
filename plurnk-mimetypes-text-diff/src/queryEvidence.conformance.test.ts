import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextDiff.ts";

// Structural matches carry honest regions in the readable text.
const h = new Handler({ mimetype: "text/x-diff", glyph: "🔀", extensions: [".diff", ".patch"] });

const src = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n";

describe("query-evidence conformance (both dialects)", () => {
    it("jsonpath distinguishes an exact file section from an enclosing scalar region", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.files[0]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.files[0].newPath",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
        ]);
    });
    it("xpath distinguishes an exact file section from an enclosing scalar region", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "xpath",
                pattern: "//file",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "//newPath",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 6, endColumn: 5,
                }]],
            },
        ]);
    });
});
