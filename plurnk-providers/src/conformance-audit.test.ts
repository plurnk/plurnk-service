// SPEC §10 traceability audit: every numbered conformance item must be claimed
// by at least one test (a "§10.N" tag in a test name or section comment), and no
// test may cite an item that no longer exists (stale renumber). This enforces
// TRACEABILITY, not semantic adequacy — that a claiming test actually proves its
// item stays on review. This file scans itself too: its §10.11/§10.12 static
// checks are genuine claims, and its traceability regexes are built dynamically
// (no literal §10.N), so it can't self-satisfy an item falsely.
import test from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const specItems = (): Map<number, string> => {
    const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const section = spec.split(/^## §10 Conformance$/m)[1]?.split(/^## §11 /m)[0];
    assert.ok(section, "SPEC.md must contain a §10 Conformance section");
    const items = new Map<number, string>();
    for (const m of section.matchAll(/^(\d+)\. (.+)$/gm)) items.set(Number(m[1]), m[2]);
    assert.ok(items.size >= 10, `parsed only ${items.size} conformance items — SPEC format drift?`);
    return items;
};

const testSources = (): string =>
    readdirSync(join(ROOT, "src"))
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => readFileSync(join(ROOT, "src", f), "utf8"))
        .join("\n");

test("every SPEC §10 conformance item is claimed by at least one test", () => {
    const items = specItems();
    const sources = testSources();
    const uncited = [...items].filter(([n]) => !new RegExp(`§10\\.${n}\\b`).test(sources));
    assert.deepEqual(
        uncited.map(([n, text]) => `§10.${n}: ${text.slice(0, 80)}`),
        [],
        "conformance items with NO claiming test — tag an existing test or write one",
    );
});

test("no test cites a §10 item that does not exist (stale renumber guard)", () => {
    const items = specItems();
    const sources = testSources();
    const stale = [...sources.matchAll(/§10\.(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => !items.has(n));
    assert.deepEqual([...new Set(stale)], [], "citations to nonexistent §10 items");
});

// §10.11: no DB access, no imports from @plurnk/plurnk-service — enforced
// statically over every shipped source (SPEC §10.11).
test("SPEC §10.11: no src module imports @plurnk/plurnk-service or node:sqlite", () => {
    for (const f of readdirSync(join(ROOT, "src")).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
        const s = readFileSync(join(ROOT, "src", f), "utf8");
        assert.ok(!/from\s+["']@plurnk\/plurnk-service/.test(s), `${f} imports @plurnk/plurnk-service`);
        assert.ok(!/from\s+["']node:sqlite/.test(s), `${f} imports node:sqlite (no DB access)`);
    }
});

// §10.12: no runtime import of @plurnk/plurnk-grammar parser entry points —
// the DSL is the consumer's to parse; the framework holds zero grammar
// dependency (SPEC §10.12, §11). (@plurnk/gbnf — the grammar-generic GBNF
// validator — is allowed and distinct.)
test("SPEC §10.12: no src module imports @plurnk/plurnk-grammar", () => {
    for (const f of readdirSync(join(ROOT, "src")).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
        const s = readFileSync(join(ROOT, "src", f), "utf8");
        assert.ok(!/from\s+["']@plurnk\/plurnk-grammar/.test(s), `${f} imports @plurnk/plurnk-grammar parser`);
    }
});
