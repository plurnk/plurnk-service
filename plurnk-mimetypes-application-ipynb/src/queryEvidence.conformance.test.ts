import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Ipynb.ts";
import { notebook } from "../test/notebook.ts";

// {§mimetype-content-query}: the queried source is notebook JSON, not its readable sibling.
const h = new Handler({"mimetype":"application/x-ipynb+json","glyph":"📓","extensions":[".ipynb"]});
const src = notebook({
    cells: [{ cell_type: "code", source: ["x=1"], id: "code", metadata: {}, outputs: [], execution_count: null }],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
}, 1);

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
