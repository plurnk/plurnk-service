import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Jsonl.ts";

// #41: BOTH dialects carry real source lines (the dual-dialect methodology fix).
const h = new Handler({"mimetype":"application/jsonl","glyph":"🧾","extensions":[".jsonl",".ndjson"]});
const src = "{\"name\":\"a\",\"v\":1}\n{\"name\":\"b\",\"v\":2}\n";

describe("#41 query-line conformance (both dialects)", () => {
    it("jsonpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "jsonpath", pattern: "$..*" }]);
    });
    it("xpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "xpath", pattern: "//*" }]);
    });
});
