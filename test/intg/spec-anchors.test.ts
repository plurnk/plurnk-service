// Spec-test alignment via per-promise anchors.
//
// PURPOSE: enforce spec<->test alignment in BOTH directions. The test name
// carries the anchor of the promise it verifies; this file fails if a test
// cites an anchor that no longer exists in SPEC.md (orphan — typo or stale
// reference), AND fails if a SPEC promise has no test citing its anchor
// (uncovered — the contract isn't pinned by any test, the failure mode that
// let the §membership contract ship as a façade). A red test for an unbuilt
// contract still counts as cited; the anchor must simply exist in a test name.
//
// Conventions:
//   In SPEC.md:  trailing `{§<tag>}` at the end of each promise bullet.
//   In tests:    `test("[§<tag>] <description>", ...)`.
//
// Tags are terse, kebab-cased, section-independent: the prefix names the section
// (`§discovery`), the postfix the promise (`§discovery-discover`). No digits —
// renumbering SPEC never orphans a citation; the tag travels with the promise.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const SPEC_ANCHOR_RE = /\{§([\w.-]+)\}/g;
const TEST_ANCHOR_RE = /test\(\s*["'`]\[§([\w.-]+)\]/g;

const extractSpecAnchors = (content: string): Set<string> => {
    const set = new Set<string>();
    for (const m of content.matchAll(SPEC_ANCHOR_RE)) set.add(`§${m[1]}`);
    return set;
};

const extractTestAnchors = (content: string): Set<string> => {
    const set = new Set<string>();
    for (const m of content.matchAll(TEST_ANCHOR_RE)) set.add(`§${m[1]}`);
    return set;
};

const collectTestAnchorsFromDir = async (dir: string): Promise<Set<string>> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const all = new Set<string>();
    for (const entry of entries) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await collectTestAnchorsFromDir(path);
            for (const a of nested) all.add(a);
        } else if (entry.name.endsWith(".test.ts")) {
            const content = await readFile(path, "utf8");
            for (const a of extractTestAnchors(content)) all.add(a);
        }
    }
    return all;
};

test("spec anchors: no orphan test references (test cites anchor not in SPEC.md)", async () => {
    const spec = await readFile(resolve(REPO_ROOT, "SPEC.md"), "utf8");
    const specAnchors = extractSpecAnchors(spec);
    const testAnchors = await collectTestAnchorsFromDir(resolve(REPO_ROOT, "test"));

    const orphans = [...testAnchors].filter((a) => !specAnchors.has(a)).toSorted();
    if (orphans.length > 0) {
        const list = orphans.map((a) => `  ${a}`).join("\n");
        assert.fail(`orphan test anchors (referenced but not present in SPEC.md):\n${list}\n\nFix: either correct the typo in the test name or add the anchor to the corresponding spec promise.`);
    }
});

test("spec anchors: every SPEC promise is cited by a test (coverage enforced)", async () => {
    const spec = await readFile(resolve(REPO_ROOT, "SPEC.md"), "utf8");
    const specAnchors = extractSpecAnchors(spec);
    const testAnchors = await collectTestAnchorsFromDir(resolve(REPO_ROOT, "test"));

    const gaps = [...specAnchors].filter((a) => !testAnchors.has(a)).toSorted();
    const covered = specAnchors.size - gaps.length;
    const pct = specAnchors.size === 0 ? 100 : Math.round((covered / specAnchors.size) * 100);
    process.stdout.write(`\n  spec-anchor coverage: ${covered}/${specAnchors.size} (${pct}%)\n`);

    if (gaps.length > 0) {
        const list = gaps.map((a) => `  ${a}`).join("\n");
        assert.fail(`${gaps.length} SPEC promise(s) cited by NO test — coverage regressed:\n${list}\n\nFix: add a test named "[§<id>] …" that exercises the contract. A red test for an unbuilt contract is acceptable — the anchor must simply be cited.`);
    }
});
