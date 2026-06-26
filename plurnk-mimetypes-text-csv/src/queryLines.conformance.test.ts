import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextCsv.ts";

// #41: BOTH dialects carry real source lines (the dual-dialect methodology fix).
const h = new Handler({"mimetype":"text/csv","glyph":"📊","extensions":[".csv"]});
const src = "name,age\nalice,30\nbob,25\n";

describe("#41 query-line conformance (both dialects)", () => {
    it("jsonpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "jsonpath", pattern: "$..*" }]);
    });
    it("xpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "xpath", pattern: "//*" }]);
    });
});
