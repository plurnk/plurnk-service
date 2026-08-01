import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Jsonplurnk } from "../../src/index.ts";

// The magnum-opus assertion on real data (grammar#437). The corpus is the renderer's ACTUAL
// output - run52 packet011's Log, 184 entries, 20 open bodies - and the stripper is built
// independently from the spec, so agreement here is a true cross-check (two implementations
// converging on real data), not self-graded homework.
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const corpus = readFileSync(join(fixtureDir, "packet011.jsonplurnk.md"), "utf8");
const fence = (() => {
    const m = /^```jsonplurnk\n([\s\S]*?)^```/m.exec(corpus);
    assert.ok(m, "packet011 fixture is missing its ```jsonplurnk fence");
    return m[1];
})();

test("jsonplurnk corpus: the renderer's 184-entry Log strips to valid JSON (magnum-opus)", () => {
    const entries = Jsonplurnk.parse(fence) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(entries), "must strip to a JSON array");
    assert.equal(entries.length, 184, "all 184 rendered entries survive the strip");
});

test("jsonplurnk corpus: every open body recovers as a string, none left as a raw heredoc", () => {
    const entries = Jsonplurnk.parse(fence) as Array<Record<string, unknown>>;
    const open = entries.filter((e) => e.display === "open");
    assert.equal(open.length, 20, "20 open bodies in packet011");
    assert.ok(open.every((e) => typeof e.body === "string"), "every recovered body is a JSON string");
});

test("jsonplurnk corpus: every display is one of the ratified states", () => {
    const entries = Jsonplurnk.parse(fence) as Array<Record<string, unknown>>;
    const allowed = new Set(["none", "folded", "open"]);
    const bad = entries.filter((e) => !allowed.has(e.display as string));
    assert.equal(bad.length, 0, `every display in {none,folded,open}; offenders: ${JSON.stringify(bad.map((e) => e.display))}`);
});

test("jsonplurnk corpus: body shape agrees with display state (honesty invariant)", () => {
    const entries = Jsonplurnk.parse(fence) as Array<Record<string, unknown>>;
    const mismatches = entries.filter((e) =>
        e.display === "none" ? e.body !== ""
            : e.display === "folded" ? "body" in e
                : typeof e.body !== "string");
    assert.equal(mismatches.length, 0, `none must carry body:"", folded must withhold body, and open must carry a string; ${mismatches.length} offenders`);
});
