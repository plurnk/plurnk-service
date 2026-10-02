import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Jsonl.ts";

// {§mimetype-query}: records and their nested values have distinct exact spans.
const h = new Handler({"mimetype":"application/jsonl","glyph":"🧾","extensions":[".jsonl",".ndjson"]});
const src = "{\"name\":\"a\",\"v\":1}\n{\"name\":\"b\",\"v\":2}\n";

describe("query-evidence conformance (both dialects)", () => {
    it("jsonpath distinguishes exact records from exact field evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$[0]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 19,
                }]],
            },
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$[0].name",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 9, endLine: 1, endColumn: 12,
                }]],
            },
        ]);
    });
    it("xpath distinguishes exact records from exact field evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "xpath",
                pattern: "//item[1]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 1, endLine: 1, endColumn: 19,
                }]],
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "//item[1]/name",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 1, startColumn: 9, endLine: 1, endColumn: 12,
                }]],
            },
        ]);
    });
});
