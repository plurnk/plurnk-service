import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import TextCsv, { parseAll } from "./TextCsv.ts";

const { fixtures } = JSON.parse(await readFile(new URL("../test/fixtures/csv-spectrum.json", import.meta.url), "utf8")) as {
    fixtures: Array<{ name: string; csvBase64: string; expectedJson: string }>;
};
const handler = new TextCsv({ mimetype: "text/csv", glyph: "📊", extensions: [".csv"] });

describe("csv-spectrum 2.0.0", () => {
    for (const { name, csvBase64, expectedJson } of fixtures) {
        const source = Buffer.from(csvBase64, "base64").toString("utf8");
        const csv = name.endsWith("_crlf") ? source.replaceAll("\n", "\r\n") : source;
        const expected = JSON.parse(expectedJson);
        if (name === "location_coordinates") {
            it("identifies the upstream inconsistent oracle, not a passing parser case", () => {
                assert.equal(Array.isArray(expected), false, "the other corpus expectations are arrays");
                assert.equal(expected["Contact Phone Number"], "1234567890");
                assert.equal(csv.split("\n")[1].split(",")[0], "2095257564");
                assert.notEqual(parseAll(csv)[1][0], expected["Contact Phone Number"]);
            });
            continue;
        }
        it(name, () => {
            assert.doesNotThrow(() => handler.validate(csv));
            assert.deepEqual(handler.deepJson(csv), expected);
            assert.deepEqual(parseAll(csv).slice(1), expected.map((row: Record<string, string>) => Object.values(row)));
        });
    }
});
