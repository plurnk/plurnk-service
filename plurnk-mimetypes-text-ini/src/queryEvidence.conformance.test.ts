import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Ini.ts";

// A structural value maps to its honest enclosing assignment line.
const h = new Handler({"mimetype":"text/x-ini","glyph":"⚙️","extensions":[".ini",".cfg","setup.cfg","tox.ini","pytest.ini",".editorconfig",".flake8",".pylintrc"]});
const src = "[server]\nhost = x\nport = 5\n";

describe("query-evidence conformance (both dialects)", () => {
    it("jsonpath reports the enclosing assignment line", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "jsonpath",
            pattern: "$.server.host",
            verdict: "enclosing",
            expectRegions: [[{
                startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
            }]],
        }]);
    });
    it("xpath reports the enclosing assignment line", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "xpath",
            pattern: "//host",
            verdict: "enclosing",
            expectRegions: [[{
                startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
            }]],
        }]);
    });
    it("both dialects report the complete enclosing section span", async () => {
        const expected = [[{
            startLine: 1, startColumn: 1, endLine: 3, endColumn: 9,
        }]];
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.server",
                verdict: "enclosing",
                expectRegions: expected,
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "//server",
                verdict: "enclosing",
                expectRegions: expected,
            },
        ]);
    });
});
