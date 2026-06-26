// Issue #41: a .ipynb is JSON, so jsonpath matches carry the notebook-file
// source line (jsonc-parser offsets), like application/json.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ipynb from "./Ipynb.ts";

const h = new Ipynb({ mimetype: "application/x-ipynb+json", glyph: "📓", extensions: [".ipynb"] as const });
const nb = JSON.stringify(
    { cells: [{ cell_type: "markdown", source: ["# T"] }, { cell_type: "code", source: ["x=1"] }], metadata: {}, nbformat: 4, nbformat_minor: 5 },
    null,
    1,
);

describe("issue #41 — ipynb jsonpath source-line spans", () => {
    it("every cell match carries a source line", async () => {
        const out = await h.query(nb, "jsonpath", "$.cells[*]");
        assert.equal(out.length, 2);
        assert.ok(out.every((m) => Array.isArray(m.lines) && m.lines.length === 1 && m.lines[0].line >= 1));
    });
    it("a leaf resolves to its notebook-file line", async () => {
        const out = await h.query(nb, "jsonpath", "$.nbformat");
        assert.equal(out[0].matched, 4);
        assert.ok(out[0].lines && out[0].lines[0].line >= 1);
    });
});
