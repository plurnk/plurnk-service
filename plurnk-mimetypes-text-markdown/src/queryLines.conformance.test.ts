import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextMarkdown.ts";

const h = new Handler({"mimetype":"text/markdown","glyph":"📝","extensions":[".md",".markdown"]});

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: "# Alpha\n\nintro text\n\n## Beta\n\nbody\n", dialect: "jsonpath", pattern: "$..*" }]);
    });
});
