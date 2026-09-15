import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Ipynb.ts";

// {§mimetype-content-query}: the queried source is notebook JSON, not its readable sibling.
const h = new Handler({"mimetype":"application/x-ipynb+json","glyph":"📓","extensions":[".ipynb"]});
const src = "{\n \"cells\": [\n  {\n   \"cell_type\": \"code\",\n   \"source\": [\n    \"x=1\"\n   ]\n  }\n ],\n \"metadata\": {},\n \"nbformat\": 4,\n \"nbformat_minor\": 5\n}";

describe("query-evidence conformance (both dialects)", () => {
    it("jsonpath: a cell property carries its source region", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src, dialect: "jsonpath", pattern: "$.cells[0].cell_type", verdict: "enclosing",
            expectRegions: [[{ startLine: 4, startColumn: 4, endLine: 4, endColumn: 23 }]],
        }]);
    });
    it("xpath: the same property carries the same source region", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src, dialect: "xpath", pattern: "//cell_type", verdict: "enclosing",
            expectRegions: [[{ startLine: 4, startColumn: 4, endLine: 4, endColumn: 23 }]],
        }]);
    });
});
