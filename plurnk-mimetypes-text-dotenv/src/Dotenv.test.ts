import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import Dotenv from "./Dotenv.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";

// ─── Dotenv.test.ts ───
{
const META = { mimetype: "text/x-dotenv", glyph: "🔑", extensions: [".env"] };
const h = () => new Dotenv(META);

describe("{§mimetype-query}: value queries preserve lexical dotenv spans", () => {
    for (const [source, selected] of [
        ["VALUE = old # comment", "old"],
        ["export VALUE = 'a # b' # comment", "'a # b'"],
        ['VALUE="first\nlast" # comment', '"first\nlast"'],
        ["VALUE=", ""],
        ["VALUE=old\nVALUE=new", "new"],
    ]) for (const dialect of ["jsonpath", "xpath"] as const) {
        it(`{§dotenv-values} ${dialect} selects ${JSON.stringify(selected)} from ${JSON.stringify(source)}`, async () => {
            const [match] = await h().query(source, dialect, dialect === "jsonpath" ? "$.VALUE" : "//VALUE");
            assert.equal(match.regions?.length, 1, JSON.stringify(match));
            const region = match.regions[0];
            const coordinates = new TextCoordinates(source);
            assert.equal(source.slice(coordinates.offsetAtPosition(region.startLine, region.startColumn), coordinates.offsetAtPosition(region.endLine, region.endColumn)), selected);
        });
    }
});

const { fixtures } = JSON.parse(await readFile(new URL("../test/fixtures/node-dotenv.json", import.meta.url), "utf8")) as {
    fixtures: Array<{ name: string; text: string }>;
};

describe("{§dotenv-values}: Node's complete dotenv fixture set", () => {
    for (const fixture of fixtures) for (const eol of ["\n", "\r\n"]) {
        it(`{§dotenv-values} ${fixture.name}, ${JSON.stringify(eol)}`, () => {
            const text = fixture.text.replaceAll("\n", eol);
            const expected = { ...parseEnv(text) };
            assert.deepEqual(h().deepJson(text), expected);
            assert.deepEqual(new Set(h().extractRaw(text).map(({ name }) => name)), new Set(Object.keys(expected)));
        });
    }
    it("{§dotenv-values} uses the same alias and JSON-string values as the configuration cascade, without expansion", () => {
        const text = [
            "PLURNK_MODEL=fast # selected alias",
            "PLURNK_MODEL_fast=provider/model",
            'PLURNK_MCP_forge_TOOLS=["issue_read"]',
            'PLURNK_MCP_forge=\'{"type":"streamable-http","url":"https://example.com/mcp","authorization":{"type":"client-credentials","clientId":"session","clientSecret":"${SESSION_SECRET}"}}\'',
            "PLURNK_MODEL=careful",
        ].join("\n");
        assert.deepEqual(h().deepJson(text), { ...parseEnv(text) });
    });
});

const ENV = [
    `# project config`,
    `MODEL=gpt-4`,
    `export OPENAI_BASE_URL="https://api.example.com"`,
    `TEMPERATURE=0.7`,
    ``,
    `EMPTY=`,
    `not a var line`,
].join("\n");

describe("{§dotenv-values} Dotenv variables as symbols", () => {
    it("{§dotenv-values} a multiline value does not introduce false assignments", () => {
        const source = 'MULTI="first\nDECOY=inside the value\nlast" # outside\nAFTER=ok';
        assert.deepEqual(h().extractRaw(source), [
            { name: "MULTI", kind: "constant", line: 1, endLine: 3 },
            { name: "AFTER", kind: "constant", line: 4, endLine: 4 },
        ]);
    });
    it("{§dotenv-values} each KEY is a constant symbol at its line", () => {
        const syms = h().extractRaw(ENV);
        assert.deepEqual(syms.map((s) => s.name), ["MODEL", "OPENAI_BASE_URL", "TEMPERATURE", "EMPTY"]);
        assert.ok(syms.every((s) => s.kind === "constant"));
        assert.equal(syms.find((s) => s.name === "MODEL")?.line, 2);
    });
});

describe("{§dotenv-values} Dotenv deepJson value map", () => {
    it("{§dotenv-values} exposes values (no redaction), strips export + surrounding quotes", () => {
        const map = h().deepJson(ENV) as Record<string, string>;
        assert.equal(map.MODEL, "gpt-4");
        assert.equal(map.OPENAI_BASE_URL, "https://api.example.com");
        assert.equal(map.TEMPERATURE, "0.7");
        assert.equal(map.EMPTY, "");
    });

    it("{§dotenv-values} comments and non-variable lines are ignored", () => {
        const map = h().deepJson(ENV) as Record<string, string>;
        assert.equal(Object.keys(map).length, 4);
        assert.equal("not a var line" in map, false);
    });
});
}

// ─── queryEvidence.conformance.test.ts ───
{
// A structural value maps to its honest exact value span.
const h = new Dotenv({"mimetype":"text/x-dotenv","glyph":"🔑","extensions":[".env",".env.local",".env.development",".env.production",".env.test",".env.example"]});
const src = "A=1\nB=2\nC=3\n";

describe("{§mimetype-query} query-evidence conformance (both dialects)", () => {
    for (const eol of ["\n", "\r\n"]) for (const dialect of ["jsonpath", "xpath"] as const) {
        it(`{§dotenv-values} ${dialect} locates the complete multiline assignment and the last duplicate, ${JSON.stringify(eol)}`, async () => {
            await assertQueryEvidenceConformance(h, [{
                source: ["MULTI=old", 'MULTI="first', "DECOY=inside the value", 'last" # outside', "AFTER=ok"].join(eol),
                dialect,
                pattern: dialect === "jsonpath" ? "$.MULTI" : "//MULTI",
                verdict: "exact",
                expectRegions: [[{ startLine: 2, startColumn: 7, endLine: 4, endColumn: 6 }]],
            }]);
        });
    }
    it("{§dotenv-values} jsonpath reports the exact value span", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "jsonpath",
            pattern: "$.B",
            verdict: "exact",
            expectRegions: [[{
                startLine: 2, startColumn: 3, endLine: 2, endColumn: 4,
            }]],
        }]);
    });
    it("{§dotenv-values} xpath reports the exact value span", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src,
            dialect: "xpath",
            pattern: "//B",
            verdict: "exact",
            expectRegions: [[{
                startLine: 2, startColumn: 3, endLine: 2, endColumn: 4,
            }]],
        }]);
    });
});
}
