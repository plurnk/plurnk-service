import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Jsonl.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({ mimetype: "application/jsonl", glyph: "📑", extensions: [".jsonl", ".ndjson"] });

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [
            { source: '{"name":"a","v":1}\n{"name":"b","v":2}\n', dialect: "jsonpath", pattern: "$..*" },
        ]);
    });
    it("record 2's field resolves to line 2", async () => {
        await assertQueryLineConformance(h, [
            { source: '{"name":"a"}\n{"name":"b"}\n', dialect: "jsonpath", pattern: "$[1].name", expectStartLines: [2] },
        ]);
    });
});
