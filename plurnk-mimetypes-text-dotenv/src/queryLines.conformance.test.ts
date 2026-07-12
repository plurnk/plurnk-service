import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Dotenv.ts";

// #41: BOTH dialects carry real source lines (the dual-dialect methodology fix).
const h = new Handler({"mimetype":"text/x-dotenv","glyph":"🔑","extensions":[".env",".env.local",".env.development",".env.production",".env.test",".env.example"]});
const src = "A=1\nB=2\nC=3\n";

describe("#41 query-line conformance (both dialects)", () => {
    it("jsonpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "jsonpath", pattern: "$..*" }]);
    });
    it("xpath: every match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: src, dialect: "xpath", pattern: "//*" }]);
    });
});
