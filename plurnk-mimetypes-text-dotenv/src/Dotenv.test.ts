import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Dotenv from "./Dotenv.ts";

const META = { mimetype: "text/x-dotenv", glyph: "🔑", extensions: [".env"] };
const h = () => new Dotenv(META);

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
