import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// SPEC ↔ test coverage tie (the lockstep ligament). SPEC.md declares contract-bearing
// clauses with {§kebab-anchor} tags; tests cite the anchors they lock as §kebab-anchor
// (comment or title). Two invariants, both directions:
//   1. every declared anchor has ≥1 citing test — an untested contract claim fails the gate;
//   2. every citation resolves to a declared anchor — a stale citation fails the gate.
// This is what keeps SPEC.md from rotting the way it did pre-0.76.8 (a busy contract week,
// zero spec movement): a contract change that touches an anchored clause breaks its citing
// tests, and deleting/renaming an anchor breaks the citations. §-names are also the commit
// doctrine's SPEC citation surface, so resolution here guards commit references too.

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "..");
const SELF = "spec-coverage.test.ts";
const ANCHOR = /\{§([a-z0-9-]+)\}/g;
const CITE = new RegExp("§([a-z0-9-]+)", "g"); // § built via escape: no literal self-citation

const spec = readFileSync(join(pkgRoot, "SPEC.md"), "utf8");
const declared = new Set([...spec.matchAll(ANCHOR)].map((m) => m[1]));

const testFiles = ["integration", "demo", "unit"]
    .flatMap((d) => {
        try { return readdirSync(join(pkgRoot, "test", d)).map((f) => join(pkgRoot, "test", d, f)); }
        catch { return []; }
    })
    .filter((f) => f.endsWith(".test.ts") && !f.endsWith(SELF));

const citations = new Map<string, string[]>(); // anchor -> citing files
for (const file of testFiles) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CITE)) {
        const name = m[1];
        if (!citations.has(name)) citations.set(name, []);
        citations.get(name)!.push(file);
    }
}

test("SPEC.md declares at least one {§anchor} (the tie exists)", () => {
    assert.ok(declared.size > 0, "SPEC.md has no {§anchor} tags - the coverage tie is dead");
});

test("every SPEC {§anchor} has at least one citing test", () => {
    const uncovered = [...declared].filter((a) => !citations.has(a));
    assert.deepEqual(uncovered, [], `SPEC anchors with no citing test: ${uncovered.join(", ")}`);
});

test("every test §citation resolves to a declared SPEC anchor", () => {
    const stale = [...citations.keys()].filter((c) => !declared.has(c));
    assert.deepEqual(stale, [], `test citations with no SPEC anchor: ${stale.join(", ")}`);
});
