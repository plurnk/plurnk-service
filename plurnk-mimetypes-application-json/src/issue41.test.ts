// JSONPath match evidence resolves through jsonc-parser offsets into exact or
// honest enclosing regions in the JSON text the model can READ.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import ApplicationJson from "./ApplicationJson.ts";

const h = new ApplicationJson({ mimetype: "application/json", glyph: "{}", extensions: [".json"] as const });

describe("application/json structural match regions", () => {
    it("classifies exact, enclosing, and locator-only evidence explicitly", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: '{\n  "xs": [\n    "a",\n    "b"\n  ]\n}',
                dialect: "jsonpath",
                pattern: "$.xs[1]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 4, startColumn: 5, endLine: 4, endColumn: 8,
                }]],
            },
            {
                source: '{\n  "host": "db.internal",\n  "pool": 5\n}',
                dialect: "jsonpath",
                pattern: "$.host",
                verdict: "enclosing",
                expectRegions: [[{
                    startLine: 2, startColumn: 3, endLine: 2, endColumn: 24,
                }]],
            },
            {
                source: '{\n  "host": "db.internal"\n}',
                dialect: "xpath",
                pattern: "count(//host)",
                verdict: "locator-only",
            },
        ]);
    });

    it("the literal example: $.host resolves to line 2, not the root", async () => {
        const src = '{\n  "host": "db.internal",\n  "pool": 5\n}';
        const out = await h.query(src, "jsonpath", "$.host");
        assert.equal(out[0].matched, "db.internal");
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 3, endLine: 2, endColumn: 24,
        }]);
    });

    it("a multi-line value reports its enclosing property footprint", async () => {
        const src = '{\n  "cfg": {\n    "a": 1,\n    "b": 2\n  }\n}';
        const out = await h.query(src, "jsonpath", "$.cfg");
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 3, endLine: 5, endColumn: 4,
        }]);
    });

    it("array element resolves to its own line", async () => {
        const src = '{\n  "xs": [\n    "a",\n    "b"\n  ]\n}';
        const out = await h.query(src, "jsonpath", "$.xs[1]");
        assert.equal(out[0].matched, "b");
        assert.deepEqual(out[0].regions, [{
            startLine: 4, startColumn: 5, endLine: 4, endColumn: 8,
        }]);
    });

    it("xpath and jsonpath both report honest regions in the same readable text", async () => {
        const src = '{\n  "host": "db.internal",\n  "pool": {\n    "size": 5\n  }\n}';
        const jh = await h.query(src, "jsonpath", "$.host");
        const xh = await h.query(src, "xpath", "//host");
        assert.equal(xh[0].regions?.[0].startLine, jh[0].regions?.[0].startLine);
        const js = await h.query(src, "jsonpath", "$.pool.size");
        const xs = await h.query(src, "xpath", "//size");
        assert.equal(xs[0].regions?.[0].startLine, js[0].regions?.[0].startLine);
        assert.deepEqual(xs[0].regions, [{
            startLine: 4, startColumn: 1, endLine: 4, endColumn: 14,
        }]);
    });
});
