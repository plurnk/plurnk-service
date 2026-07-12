import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Ini.ts";

// #41: BOTH dialects carry real source lines (the dual-dialect methodology fix).
const h = new Handler({"mimetype":"text/x-ini","glyph":"⚙️","extensions":[".ini",".cfg","setup.cfg","tox.ini","pytest.ini",".editorconfig",".flake8",".pylintrc"]});
const src = "[server]\nhost = x\nport = 5\n";

describe("#41 query-line conformance (both dialects)", () => {
    it("jsonpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "jsonpath", pattern: "$..*" }]);
    });
    it("xpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "xpath", pattern: "//*" }]);
    });
});
