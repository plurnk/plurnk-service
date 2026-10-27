import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ini from "./Ini.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";

// ─── Ini.test.ts ───
{
const META = { mimetype: "text/x-ini", glyph: "⚙️", extensions: [".ini"] };
const h = () => new Ini(META);

const CFG = [
    `root = true`,
    ``,
    `[metadata]`,
    `name = my-pkg`,
    `; a comment`,
    `version = 1.2.0`,
    ``,
    `[options]`,
    `python_requires = >=3.10`,
].join("\n");

describe("{§ini-tree} sections are modules and keys are fields", () => {
    it("{§ini-tree} sections are modules, keys are fields contained by their section", () => {
        const syms = h().extractRaw(CFG);
        const meta = syms.find((s) => s.name === "metadata");
        assert.equal(meta?.kind, "module");
        const version = syms.find((s) => s.name === "version");
        assert.equal(version?.kind, "field");
        assert.equal(version?.container, "metadata");
    });

    it("{§ini-tree} top-level keys before any section have no container", () => {
        const root = h().extractRaw(CFG).find((s) => s.name === "root");
        assert.equal(root?.kind, "field");
        assert.equal(root?.container, undefined);
    });
});

describe("{§ini-tree} deepJson is the nested section object", () => {
    it("{§ini-tree} builds { section: { key: value } } with top-level keys at root", () => {
        const tree = h().deepJson(CFG) as Record<string, unknown>;
        assert.equal(tree.root, "true");
        assert.deepEqual(tree.metadata, { name: "my-pkg", version: "1.2.0" });
        assert.deepEqual(tree.options, { python_requires: ">=3.10" });
    });

    it("{§ini-tree} colon-delimited entries parse too", () => {
        const tree = h().deepJson(`[s]\nkey: value\n`) as Record<string, Record<string, string>>;
        assert.equal(tree.s.key, "value");
    });
});
}

// ─── queryEvidence.conformance.test.ts ───
{
// A structural value maps to its honest exact value span.
const h = new Ini({"mimetype":"text/x-ini","glyph":"⚙️","extensions":[".ini",".cfg","setup.cfg","tox.ini","pytest.ini",".editorconfig",".flake8",".pylintrc"]});
const src = "[server]\nhost = x\nport = 5\n";

describe("{§mimetype-query} both structural dialects report exact INI spans", () => {
    it("{§ini-tree} jsonpath reports the exact value span", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "jsonpath",
            pattern: "$.server.host",
            verdict: "exact",
            expectRegions: [[{
                startLine: 2, startColumn: 8, endLine: 2, endColumn: 9,
            }]],
        }]);
    });
    it("{§ini-tree} xpath reports the exact value span", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "xpath",
            pattern: "//host",
            verdict: "exact",
            expectRegions: [[{
                startLine: 2, startColumn: 8, endLine: 2, endColumn: 9,
            }]],
        }]);
    });
    it("{§ini-tree} both dialects report the complete section span", async () => {
        const expected = [[{
            startLine: 1, startColumn: 1, endLine: 3, endColumn: 9,
        }]];
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$.server",
                verdict: "exact",
                expectRegions: expected,
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "//server",
                verdict: "exact",
                expectRegions: expected,
            },
        ]);
    });
});
}

// ─── queryRegions.test.ts ───
{
const h = new Ini({ mimetype: "text/x-ini", glyph: "⚙", extensions: [".ini"] as const });
const src = "[server]\nhost = db.internal\nport = 5432\n\n[log]\nlevel = info\n";

describe("{§ini-tree} values and sections resolve to their own lexical source spans", () => {
    it("{§ini-tree} a section replacing a global key retains only the section's source", async () => {
        const source = "group = old\n[group]\nkey = value";
        assert.deepEqual(h.deepJson(source), { group: { key: "value" } });
        for (const [dialect, expression] of [["jsonpath", "$.group"], ["xpath", "//group"]] as const) {
            const matches = await h.query(source, dialect, expression);
            assert.equal(matches.length, 1);
            assert.deepEqual(matches[0].regions, [{ startLine: 2, startColumn: 1, endLine: 3, endColumn: 12 }]);
        }
    });
    it("{§ini-tree} repeated sections preserve disjoint source regions in both structural dialects", async () => {
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
    it("{§ini-tree} a key resolves to its source line", async () => {
        const out = await h.query(src, "jsonpath", "$.server.port");
        assert.equal(out[0].matched, "5432");
        assert.deepEqual(out[0].regions, [{
            startLine: 3, startColumn: 8, endLine: 3, endColumn: 12,
        }]);
    });
    it("{§ini-tree} a section resolves to its complete enclosing source span", async () => {
        const out = await h.query(src, "jsonpath", "$.log");
        assert.deepEqual(out[0].regions, [{
            startLine: 5, startColumn: 1, endLine: 6, endColumn: 13,
        }]);
    });
    it("{§ini-tree} a key in a later section resolves correctly", async () => {
        const out = await h.query(src, "jsonpath", "$.log.level");
        assert.equal(out[0].matched, "info");
        assert.deepEqual(out[0].regions, [{
            startLine: 6, startColumn: 9, endLine: 6, endColumn: 13,
        }]);
    });
});
}
