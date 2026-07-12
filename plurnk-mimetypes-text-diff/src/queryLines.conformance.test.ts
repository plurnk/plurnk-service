import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextDiff.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({ mimetype: "text/x-diff", glyph: "🔀", extensions: [".diff", ".patch"] });

const src = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n";

describe("#41 query-line conformance (both dialects)", () => {
    it("jsonpath: every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "jsonpath", pattern: "$..*" }]);
    });
    it("xpath: every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "xpath", pattern: "//*" }]);
    });
});
