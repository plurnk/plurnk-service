// {§slice-semantics-compose-pattern} — JSONPath selects the value's source text.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import ApplicationJson from "./ApplicationJson.ts";

const h = new ApplicationJson({ mimetype: "application/json", glyph: "{}", extensions: [".json"] as const });

describe("application/json structural match regions", () => {
    it("XPath data keys cannot impersonate tree metadata or disappear", async () => {
        const source = '{"type":"custom","text":"body","line":99,"endLine":100,"attrs":{"level":3},"empty":null}';
        const coordinates = new TextCoordinates(source);
        for (const [path, xml] of [["$.type", "//type"], ["$.text", "//text"], ["$.line", "//line"], ["$.endLine", "//endLine"], ["$.attrs.level", "//attrs/level"], ["$.empty", "//empty"]]) {
            const [json] = await h.query(source, "jsonpath", path);
            const matches = await h.query(source, "xpath", xml);
            assert.equal(matches.length, 1, xml);
            assert.deepEqual(matches[0].regions, json.regions, xml);
            const region = matches[0].regions![0];
            const text = source.slice(coordinates.offsetAtPosition(region.startLine, region.startColumn), coordinates.offsetAtPosition(region.endLine, region.endColumn));
            assert.notEqual(text.length, 0, xml);
        }
    });
    it("classifies exact, enclosing, and locator-only evidence explicitly", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: '{\n  "xs": [\n    "a",\n    "b"\n  ]\n}',
                dialect: "jsonpath",
                pattern: "$.xs[1]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 4, startColumn: 5, endLine: 4, endColumn: 8,
                }]],
            },
            {
                source: '{\n  "host": "db.internal",\n  "pool": 5\n}',
                dialect: "jsonpath",
                pattern: "$.host",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 11, endLine: 2, endColumn: 24,
                }]],
            },
            {
                source: '{\n  "host": "db.internal"\n}',
                dialect: "xpath",
                pattern: "count(//host)",
                verdict: "locator-only",
            },
        ]);
    });

    it("the literal example: $.host resolves to line 2, not the root", async () => {
        const src = '{\n  "host": "db.internal",\n  "pool": 5\n}';
        const out = await h.query(src, "jsonpath", "$.host");
        assert.equal(out[0].matched, "db.internal");
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 11, endLine: 2, endColumn: 24,
        }]);
    });

    it("a multi-line value excludes its member name and colon", async () => {
        const src = '{\n  "cfg": {\n    "a": 1,\n    "b": 2\n  }\n}';
        const out = await h.query(src, "jsonpath", "$.cfg");
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 10, endLine: 5, endColumn: 4,
        }]);
    });

    it("array element resolves to its own line", async () => {
        const src = '{\n  "xs": [\n    "a",\n    "b"\n  ]\n}';
        const out = await h.query(src, "jsonpath", "$.xs[1]");
        assert.equal(out[0].matched, "b");
        assert.deepEqual(out[0].regions, [{
            startLine: 4, startColumn: 5, endLine: 4, endColumn: 8,
        }]);
    });

    it("xpath and jsonpath both report honest regions in the same readable text", async () => {
        const src = '{\n  "host": "db.internal",\n  "pool": {\n    "size": 5\n  }\n}';
        const jh = await h.query(src, "jsonpath", "$.host");
        const xh = await h.query(src, "xpath", "//host");
        assert.equal(xh[0].regions?.[0].startLine, jh[0].regions?.[0].startLine);
        const js = await h.query(src, "jsonpath", "$.pool.size");
        const xs = await h.query(src, "xpath", "//size");
        // #372 — the deep-xml projection carries the parse tree's columns, so the xpath
        // row is the jsonpath row's exact region, not the enclosing line.
        assert.deepEqual(xs[0].regions, js[0].regions);
        assert.deepEqual(xs[0].regions, [{
            startLine: 4, startColumn: 13, endLine: 4, endColumn: 14,
        }]);
    });

    for (const { pattern, selected } of [
        { pattern: "$['']", selected: '"empty"' },
        { pattern: "$['0']", selected: '"zero"' },
        { pattern: "$['01']", selected: '"leading"' },
        { pattern: "$['a/b~c']", selected: '"escaped"' },
        { pattern: "$.list[0]['0']", selected: '"nested"' },
        { pattern: "$.list[1]", selected: '"array"' },
        { pattern: "$.quoted", selected: '"a\\\"b"' },
        { pattern: "$.unicode", selected: '"\\u0061"' },
    ]) {
        it(`${pattern} retains the exact value spelling at its JSON Pointer`, async () => {
            const source = '{"":"empty","0":"zero","01":"leading","a/b~c":"escaped","list":[{"0":"nested"},"array"],"quoted":"a\\\"b","unicode":"\\u0061"}';
            const [match] = await h.query(source, "jsonpath", pattern);
            assert.ok(match?.regions?.length === 1, JSON.stringify(match));
            const [region] = match.regions;
            const coordinates = new TextCoordinates(source);
            assert.equal(source.slice(
                coordinates.offsetAtPosition(region.startLine, region.startColumn),
                coordinates.offsetAtPosition(region.endLine, region.endColumn),
            ), selected);
        });
    }
});
