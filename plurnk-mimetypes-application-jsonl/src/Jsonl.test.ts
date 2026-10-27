import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Jsonl from "./Jsonl.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";

// ─── Jsonl.test.ts ───
{
const META = { mimetype: "application/jsonl", glyph: "🧾", extensions: [".jsonl"] };
const h = () => new Jsonl(META);

const DATA = [
    `{"prompt":"hi","completion":"hello"}`,
    `{"prompt":"bye","completion":"goodbye","score":0.9}`,
    ``, // blank line tolerated
    `{"prompt":"x","completion":"y"}`,
].join("\n") + "\n";

describe("{§jsonl-records} record schema as symbols", () => {
    it("{§jsonl-records} emits one field per distinct top-level key, at first occurrence", () => {
        const syms = h().extractRaw(DATA);
        assert.deepEqual(syms.map((s) => s.name), ["prompt", "completion", "score"]);
        assert.ok(syms.every((s) => s.kind === "field"));
        // score first appears on line 2
        assert.equal(syms.find((s) => s.name === "score")?.line, 2);
    });
});

describe("{§jsonl-records} deepJson is the records array", () => {
    it("{§jsonl-records} parsed records, jsonpath-addressable", () => {
        const records = h().deepJson(DATA) as Array<Record<string, unknown>>;
        assert.equal(records.length, 3);
        assert.equal(records[1].score, 0.9);
    });

    it("{§jsonl-records} malformed lines are skipped, not fatal", () => {
        const messy = `{"a":1}\nnot json\n{"b":2}\n`;
        const records = h().deepJson(messy) as unknown[];
        assert.equal(records.length, 2);
    });

    it("{§jsonl-records} non-object records (primitives/arrays) contribute no schema", () => {
        const prims = `"just a string"\n[1,2,3]\n42\n`;
        assert.deepEqual(h().extractRaw(prims), []);
        assert.equal((h().deepJson(prims) as unknown[]).length, 3);
    });
});
}

// ─── queryEvidence.conformance.test.ts ───
{
// {§mimetype-query}: records and their nested values have distinct exact spans.
const h = new Jsonl({"mimetype":"application/jsonl","glyph":"🧾","extensions":[".jsonl",".ndjson"]});
const src = "{\"name\":\"a\",\"v\":1}\n{\"name\":\"b\",\"v\":2}\n";

describe("{§jsonl-records} query evidence distinguishes exact records from exact field evidence", () => {
    it("{§jsonl-records} jsonpath distinguishes exact records from exact field evidence", async () => {
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
    it("{§jsonl-records} xpath distinguishes exact records from exact field evidence", async () => {
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
}
