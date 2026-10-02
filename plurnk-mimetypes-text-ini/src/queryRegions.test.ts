// {§mimetype-query}: assignment values retain their own lexical source spans.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ini from "./Ini.ts";

const h = new Ini({ mimetype: "text/x-ini", glyph: "⚙", extensions: [".ini"] as const });
const src = "[server]\nhost = db.internal\nport = 5432\n\n[log]\nlevel = info\n";

describe("INI JSONPath match regions", () => {
    it("a section replacing a global key retains only the section's source", async () => {
        const source = "group = old\n[group]\nkey = value";
        assert.deepEqual(h.deepJson(source), { group: { key: "value" } });
        for (const [dialect, expression] of [["jsonpath", "$.group"], ["xpath", "//group"]] as const) {
            const matches = await h.query(source, dialect, expression);
            assert.equal(matches.length, 1);
            assert.deepEqual(matches[0].regions, [{ startLine: 2, startColumn: 1, endLine: 3, endColumn: 12 }]);
        }
    });
    it("repeated sections preserve disjoint source regions in both structural dialects", async () => {
        const source = "[group]\na = first\n[other]\nx = keep\n[group]\nb = second";
        const [json] = await h.query(source, "jsonpath", "$.group");
        const [xml] = await h.query(source, "xpath", "//group");
        const regions = [
            { startLine: 1, startColumn: 1, endLine: 2, endColumn: 10 },
            { startLine: 5, startColumn: 1, endLine: 6, endColumn: 11 },
        ];
        assert.deepEqual(json.regions, regions);
        assert.deepEqual(xml.regions, regions);
    });
    it("a key resolves to its source line", async () => {
        const out = await h.query(src, "jsonpath", "$.server.port");
        assert.equal(out[0].matched, "5432");
        assert.deepEqual(out[0].regions, [{
            startLine: 3, startColumn: 8, endLine: 3, endColumn: 12,
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
            startLine: 6, startColumn: 9, endLine: 6, endColumn: 13,
        }]);
    });
});
