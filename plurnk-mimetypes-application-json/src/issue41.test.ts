// Issue #41 (service-side): jsonpath matches carry the exact SOURCE-LINE span,
// resolved from jsonc-parser offsets — including the issue's literal example.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationJson from "./ApplicationJson.ts";

const h = new ApplicationJson({ mimetype: "application/json", glyph: "{}", extensions: [".json"] as const });

describe("issue #41 — jsonpath source-line spans (application/json)", () => {
    it("the literal example: $.host resolves to line 2, not the root", async () => {
        const src = '{\n  "host": "db.internal",\n  "pool": 5\n}';
        const out = await h.query(src, "jsonpath", "$.host");
        assert.equal(out[0].matched, "db.internal");
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 2 }]);
    });

    it("a multi-line value spans key..close (the property's definition footprint)", async () => {
        const src = '{\n  "cfg": {\n    "a": 1,\n    "b": 2\n  }\n}';
        const out = await h.query(src, "jsonpath", "$.cfg");
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 5 }]);
    });

    it("array element resolves to its own line", async () => {
        const src = '{\n  "xs": [\n    "a",\n    "b"\n  ]\n}';
        const out = await h.query(src, "jsonpath", "$.xs[1]");
        assert.equal(out[0].matched, "b");
        assert.deepEqual(out[0].lines, [{ line: 4, endLine: 4 }]);
    });

    it("xpath carries the SAME real lines as jsonpath (#41 dual-dialect)", async () => {
        const src = '{\n  "host": "db.internal",\n  "pool": {\n    "size": 5\n  }\n}';
        const jh = await h.query(src, "jsonpath", "$.host");
        const xh = await h.query(src, "xpath", "//host");
        assert.deepEqual(xh[0].lines, jh[0].lines, "host: jsonpath and xpath agree");
        const js = await h.query(src, "jsonpath", "$.pool.size");
        const xs = await h.query(src, "xpath", "//size");
        assert.deepEqual(xs[0].lines, js[0].lines, "nested size: jsonpath and xpath agree");
        assert.deepEqual(xs[0].lines, [{ line: 4, endLine: 4 }]);
    });
});
