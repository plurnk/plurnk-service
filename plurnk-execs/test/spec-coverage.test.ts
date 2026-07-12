import test from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The spec↔test traceability gate: every SPEC.md section must be pinned by at
// least one test whose TITLE carries its tag ("§2.2 probe: …"), and no title
// may cite a section that doesn't exist. This turns the code→spec comment
// convention into an enforced, bidirectional invariant: add a section and this
// gate demands a test; remove one and it flags the orphaned citations.
//
// Exemptions are prose-only sections with no framework-testable contract —
// each must justify itself here:
const EXEMPT: Readonly<Record<string, string>> = Object.freeze({
    "§1": "Role — positioning prose, no testable contract",
    "§5": "Consumer surface — plurnk-service's obligations, tested in its repo",
    "§6": "Forbidden (for siblings) — review policy, not executable contract",
});

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const specSections = (): string[] => {
    const spec = readFileSync(path.join(root, "SPEC.md"), "utf-8");
    return [...spec.matchAll(/^#{2,3} (§[0-9.]+)/gm)].map((m) => m[1]);
};

const testTitles = (): string[] => {
    const files = ["src", "test"].flatMap((d) =>
        readdirSync(path.join(root, d)).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(root, d, f)));
    return files.flatMap((f) => [...readFileSync(f, "utf-8").matchAll(/^\s*test\(\s*"([^"]+)"/gm)].map((m) => m[1]));
};

test("spec coverage: every non-exempt SPEC section is pinned by at least one §-tagged test title", () => {
    const sections = specSections();
    assert.ok(sections.length >= 10, "SPEC.md section parse sanity");
    const titles = testTitles();
    const unpinned = sections.filter((s) =>
        !(s in EXEMPT) && !titles.some((t) => t.startsWith(`${s} `) || t.includes(` ${s} `)));
    assert.deepEqual(unpinned, [], `SPEC sections with no pinning test: ${unpinned.join(", ")} — add a "§X.Y …"-titled test or justify an exemption`);
});

test("spec coverage: no test title cites a section that SPEC.md doesn't define (orphan guard)", () => {
    const sections = new Set(specSections());
    const orphans = testTitles()
        .map((t) => t.match(/^(§[0-9.]+) /)?.[1])
        .filter((s): s is string => s !== undefined && !sections.has(s));
    assert.deepEqual([...new Set(orphans)], [], "test titles citing nonexistent SPEC sections");
});

test("spec coverage: exemptions stay honest — an exempt section must still exist in SPEC.md", () => {
    const sections = new Set(specSections());
    const stale = Object.keys(EXEMPT).filter((s) => !sections.has(s));
    assert.deepEqual(stale, [], "EXEMPT lists sections SPEC.md no longer defines");
});
