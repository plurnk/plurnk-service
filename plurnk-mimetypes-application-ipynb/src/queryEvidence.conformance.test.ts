import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Ipynb.ts";

// The rendered notebook projection cannot reuse raw JSON coordinates.
const h = new Handler({"mimetype":"application/x-ipynb+json","glyph":"📓","extensions":[".ipynb"]});
const src = "{\n \"cells\": [\n  {\n   \"cell_type\": \"code\",\n   \"source\": [\n    \"x=1\"\n   ]\n  }\n ],\n \"metadata\": {},\n \"nbformat\": 4,\n \"nbformat_minor\": 5\n}";

describe("query-evidence conformance (both dialects)", () => {
    it("jsonpath: every match retains a locator without fake markdown coordinates", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src, dialect: "jsonpath", pattern: "$..*", verdict: "locator-only",
        }]);
    });
    it("xpath: every match retains a locator without fake markdown coordinates", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src, dialect: "xpath", pattern: "//*", verdict: "locator-only",
        }]);
    });
});
