import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Jsonl from "./Jsonl.ts";

const META = { mimetype: "application/jsonl", glyph: "🧾", extensions: [".jsonl"] };
const h = () => new Jsonl(META);

const DATA = [
    `{"prompt":"hi","completion":"hello"}`,
    `{"prompt":"bye","completion":"goodbye","score":0.9}`,
    ``, // blank line tolerated
    `{"prompt":"x","completion":"y"}`,
].join("\n") + "\n";

describe("Jsonl — record schema as symbols", () => {
    it("emits one field per distinct top-level key, at first occurrence", () => {
        const syms = h().extractRaw(DATA);
        assert.deepEqual(syms.map((s) => s.name), ["prompt", "completion", "score"]);
        assert.ok(syms.every((s) => s.kind === "field"));
        // score first appears on line 2
        assert.equal(syms.find((s) => s.name === "score")?.line, 2);
    });
});

describe("Jsonl — deepJson is the records array", () => {
    it("parsed records, jsonpath-addressable", () => {
        const records = h().deepJson(DATA) as Array<Record<string, unknown>>;
        assert.equal(records.length, 3);
        assert.equal(records[1].score, 0.9);
    });

    it("malformed lines are skipped, not fatal", () => {
        const messy = `{"a":1}\nnot json\n{"b":2}\n`;
        const records = h().deepJson(messy) as unknown[];
        assert.equal(records.length, 2);
    });

    it("non-object records (primitives/arrays) contribute no schema", () => {
        const prims = `"just a string"\n[1,2,3]\n42\n`;
        assert.deepEqual(h().extractRaw(prims), []);
        assert.equal((h().deepJson(prims) as unknown[]).length, 3);
    });
});
