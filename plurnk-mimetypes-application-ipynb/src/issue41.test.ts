// {§mimetype-content-query}: queries address notebook JSON, not its readable sibling.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ipynb from "./Ipynb.ts";

const h = new Ipynb({ mimetype: "application/x-ipynb+json", glyph: "📓", extensions: [".ipynb"] as const });
const nb = JSON.stringify(
    { cells: [{ cell_type: "markdown", source: ["# T"] }, { cell_type: "code", source: ["x=1"] }], metadata: {}, nbformat: 4, nbformat_minor: 5 },
    null,
    1,
);

describe("ipynb structural match evidence", () => {
    it("every cell match retains its locator and actual JSON source region", async () => {
        const out = await h.query(nb, "jsonpath", "$.cells[*]");
        assert.equal(out.length, 2);
        assert.deepEqual(out.map(({ matching }) => matching), ["$['cells'][0]", "$['cells'][1]"]);
        assert.deepEqual(out.map(({ regions }) => regions), [
            [{ startLine: 3, startColumn: 3, endLine: 8, endColumn: 4 }],
            [{ startLine: 9, startColumn: 3, endLine: 14, endColumn: 4 }],
        ]);
    });
    it("a leaf retains its canonical locator", async () => {
        const out = await h.query(nb, "jsonpath", "$.nbformat");
        assert.equal(out[0].matched, 4);
        assert.equal(out[0].matching, "$['nbformat']");
        assert.deepEqual(out[0].regions, [{ startLine: 17, startColumn: 2, endLine: 17, endColumn: 15 }]);
    });
});

// {§mimetype-content} — the readable projection is a channel the consumer stores; regex over the
// source channel sees the notebook JSON itself, in the JSON's own coordinates.
it("regex runs over the notebook source, never the Markdown projection", async () => {
    const heading = await h.query(nb, "regex", "# T");
    assert.equal(heading.length, 1);
    const key = await h.query(nb, "regex", "cell_type");
    assert.equal(key.length, 2, "a JSON key is source text, once per cell");
});
