import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Ipynb.ts";

// #41: BOTH dialects carry real source lines (the dual-dialect methodology fix).
const h = new Handler({"mimetype":"application/x-ipynb+json","glyph":"📓","extensions":[".ipynb"]});
const src = "{\n \"cells\": [\n  {\n   \"cell_type\": \"code\",\n   \"source\": [\n    \"x=1\"\n   ]\n  }\n ],\n \"metadata\": {},\n \"nbformat\": 4,\n \"nbformat_minor\": 5\n}";

describe("#41 query-line conformance (both dialects)", () => {
    it("jsonpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "jsonpath", pattern: "$..*" }]);
    });
    it("xpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "xpath", pattern: "//*" }]);
    });
});
