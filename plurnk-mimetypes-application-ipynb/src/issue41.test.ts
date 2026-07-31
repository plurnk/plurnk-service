// A notebook's readable body is projected Markdown. Structural matches retain
// canonical JSONPath locators without leaking raw-JSON coordinates into it.
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
    it("every cell match retains a locator and no fabricated Markdown region", async () => {
        const out = await h.query(nb, "jsonpath", "$.cells[*]");
        assert.equal(out.length, 2);
        assert.ok(out.every((match) =>
            typeof match.matching === "string" && match.regions === undefined));
    });
    it("a leaf retains its canonical locator", async () => {
        const out = await h.query(nb, "jsonpath", "$.nbformat");
        assert.equal(out[0].matched, 4);
        assert.equal(out[0].matching, "$['nbformat']");
        assert.equal(out[0].regions, undefined);
    });
});
