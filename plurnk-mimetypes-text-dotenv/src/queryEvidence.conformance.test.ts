import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Dotenv.ts";

// A structural value maps to its honest enclosing assignment line.
const h = new Handler({"mimetype":"text/x-dotenv","glyph":"🔑","extensions":[".env",".env.local",".env.development",".env.production",".env.test",".env.example"]});
const src = "A=1\nB=2\nC=3\n";

describe("query-evidence conformance (both dialects)", () => {
    it("jsonpath reports the enclosing assignment line", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "jsonpath",
            pattern: "$.B",
            verdict: "enclosing",
            expectRegions: [[{
                startLine: 2, startColumn: 1, endLine: 2, endColumn: 4,
            }]],
        }]);
    });
    it("xpath reports the enclosing assignment line", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "xpath",
            pattern: "//B",
            verdict: "enclosing",
            expectRegions: [[{
                startLine: 2, startColumn: 1, endLine: 2, endColumn: 4,
            }]],
        }]);
    });
});
