import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Dotenv.ts";

// A structural value maps to its honest exact value span.
const h = new Handler({"mimetype":"text/x-dotenv","glyph":"🔑","extensions":[".env",".env.local",".env.development",".env.production",".env.test",".env.example"]});
const src = "A=1\nB=2\nC=3\n";

describe("query-evidence conformance (both dialects)", () => {
    for (const eol of ["\n", "\r\n"]) for (const dialect of ["jsonpath", "xpath"] as const) {
        it(`${dialect} locates the complete multiline assignment and the last duplicate, ${JSON.stringify(eol)}`, async () => {
            await assertQueryEvidenceConformance(h, [{
                source: ["MULTI=old", 'MULTI="first', "DECOY=inside the value", 'last" # outside', "AFTER=ok"].join(eol),
                dialect,
                pattern: dialect === "jsonpath" ? "$.MULTI" : "//MULTI",
                verdict: "exact",
                expectRegions: [[{ startLine: 2, startColumn: 7, endLine: 4, endColumn: 6 }]],
            }]);
        });
    }
    it("jsonpath reports the exact value span", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "jsonpath",
            pattern: "$.B",
            verdict: "exact",
            expectRegions: [[{
                startLine: 2, startColumn: 3, endLine: 2, endColumn: 4,
            }]],
        }]);
    });
    it("xpath reports the exact value span", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "xpath",
            pattern: "//B",
            verdict: "exact",
            expectRegions: [[{
                startLine: 2, startColumn: 3, endLine: 2, endColumn: 4,
            }]],
        }]);
    });
});
