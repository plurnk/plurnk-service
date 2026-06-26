import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./Dotenv.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({ mimetype: "text/x-dotenv", glyph: "🔑", extensions: [".env"] });

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [
            { source: "FOO=bar\nBAZ=qux\nNESTED=deep\n", dialect: "jsonpath", pattern: "$..*" },
        ]);
    });
});
