// Issue #41: ini jsonpath matches carry source-line spans (from parseIni
// positions) — deepJson is line-less raw values, so a lineFor supplies them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ini from "./Ini.ts";

const h = new Ini({ mimetype: "text/x-ini", glyph: "⚙", extensions: [".ini"] as const });
const src = "[server]\nhost = db.internal\nport = 5432\n\n[log]\nlevel = info\n";

describe("issue #41 — ini jsonpath source-line spans", () => {
    it("a key resolves to its source line", async () => {
        const out = await h.query(src, "jsonpath", "$.server.port");
        assert.equal(out[0].matched, "5432");
        assert.deepEqual(out[0].lines, [{ line: 3, endLine: 3 }]);
    });
    it("a section resolves to its header line", async () => {
        const out = await h.query(src, "jsonpath", "$.log");
        assert.deepEqual(out[0].lines, [{ line: 5, endLine: 5 }]);
    });
    it("a key in a later section resolves correctly", async () => {
        const out = await h.query(src, "jsonpath", "$.log.level");
        assert.equal(out[0].matched, "info");
        assert.deepEqual(out[0].lines, [{ line: 6, endLine: 6 }]);
    });
});
