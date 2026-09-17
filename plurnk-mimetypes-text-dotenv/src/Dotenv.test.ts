import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import Dotenv, { parseDotenv } from "./Dotenv.ts";

const META = { mimetype: "text/x-dotenv", glyph: "🔑", extensions: [".env"] };
const h = () => new Dotenv(META);

const { fixtures } = JSON.parse(await readFile(new URL("../test/fixtures/node-dotenv.json", import.meta.url), "utf8")) as {
    fixtures: Array<{ name: string; text: string }>;
};

describe("{§dotenv-values}: Node's complete dotenv fixture set", () => {
    for (const fixture of fixtures) for (const eol of ["\n", "\r\n"]) {
        it(`${fixture.name}, ${JSON.stringify(eol)}`, () => {
            const text = fixture.text.replaceAll("\n", eol);
            const expected = { ...parseEnv(text) };
            assert.deepEqual(h().deepJson(text), expected);
            assert.deepEqual(Object.fromEntries(parseDotenv(text).map(({ key, value }) => [key, value])), expected);
        });
    }
    it("uses the same alias and JSON-string values as the configuration cascade, without expansion", () => {
        const text = [
            "PLURNK_MODEL=fast # selected alias",
            "PLURNK_MODEL_fast=provider/model",
            'PLURNK_MCP_ENABLED=["forge"]',
            'PLURNK_MCP_forge_ENV=\'{"TOKEN":"${FORGE_TOKEN}"}\'',
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

describe("Dotenv — variables as symbols", () => {
    it("a multiline value does not introduce false assignments", () => {
        const source = 'MULTI="first\nDECOY=inside the value\nlast" # outside\nAFTER=ok';
        assert.deepEqual(h().extractRaw(source), [
            { name: "MULTI", kind: "constant", line: 1, endLine: 3 },
            { name: "AFTER", kind: "constant", line: 4, endLine: 4 },
        ]);
    });
    it("each KEY is a constant symbol at its line", () => {
        const syms = h().extractRaw(ENV);
        assert.deepEqual(syms.map((s) => s.name), ["MODEL", "OPENAI_BASE_URL", "TEMPERATURE", "EMPTY"]);
        assert.ok(syms.every((s) => s.kind === "constant"));
        assert.equal(syms.find((s) => s.name === "MODEL")?.line, 2);
    });
});

describe("Dotenv — deepJson value map", () => {
    it("exposes values (no redaction), strips export + surrounding quotes", () => {
        const map = h().deepJson(ENV) as Record<string, string>;
        assert.equal(map.MODEL, "gpt-4");
        assert.equal(map.OPENAI_BASE_URL, "https://api.example.com");
        assert.equal(map.TEMPERATURE, "0.7");
        assert.equal(map.EMPTY, "");
    });

    it("comments and non-variable lines are ignored", () => {
        const map = h().deepJson(ENV) as Record<string, string>;
        assert.equal(Object.keys(map).length, 4);
        assert.equal("not a var line" in map, false);
    });
});
