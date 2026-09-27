// INI JSONPath match evidence maps parser positions into honest enclosing
// whole-line regions in the text the model can READ.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ini from "./Ini.ts";

const h = new Ini({ mimetype: "text/x-ini", glyph: "⚙", extensions: [".ini"] as const });
const src = "[server]\nhost = db.internal\nport = 5432\n\n[log]\nlevel = info\n";

describe("INI JSONPath match regions", () => {
    it("a key resolves to its source line", async () => {
        const out = await h.query(src, "jsonpath", "$.server.port");
        assert.equal(out[0].matched, "5432");
        assert.deepEqual(out[0].regions, [{
            startLine: 3, startColumn: 1, endLine: 3, endColumn: 12,
        }]);
    });
    it("a section resolves to its complete enclosing source span", async () => {
        const out = await h.query(src, "jsonpath", "$.log");
        assert.deepEqual(out[0].regions, [{
            startLine: 5, startColumn: 1, endLine: 6, endColumn: 13,
        }]);
    });
    it("a key in a later section resolves correctly", async () => {
        const out = await h.query(src, "jsonpath", "$.log.level");
        assert.equal(out[0].matched, "info");
        assert.deepEqual(out[0].regions, [{
            startLine: 6, startColumn: 1, endLine: 6, endColumn: 13,
        }]);
    });
});
