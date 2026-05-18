// Spec-test alignment via per-promise anchors.
//
// PURPOSE: signal against drift. NOT a forcing function or development driver.
// When a test verifies a spec promise, the test name carries the anchor; this
// file fails if a test cites an anchor that no longer exists in SPEC.md
// (orphan — typo or stale reference). Anchors with no tests are gaps; we
// surface them informationally without blocking.
//
// Conventions:
//   In SPEC.md:  trailing `{§<id>}` at the end of each promise bullet.
//   In tests:    `test("[§<id>] <description>", ...)`.
//
// IDs are `<section>-<semantic>` kebab-cased.

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

test("spec anchors: gap report (informational; does not fail)", async () => {
    const spec = await readFile(resolve(REPO_ROOT, "SPEC.md"), "utf8");
    const specAnchors = extractSpecAnchors(spec);
    const testAnchors = await collectTestAnchorsFromDir(resolve(REPO_ROOT, "test"));

    const gaps = [...specAnchors].filter((a) => !testAnchors.has(a)).toSorted();
    const covered = specAnchors.size - gaps.length;
    const pct = specAnchors.size === 0 ? 0 : Math.round((covered / specAnchors.size) * 100);

    process.stdout.write(`\n  spec-anchor coverage: ${covered}/${specAnchors.size} (${pct}%)\n`);
    if (gaps.length > 0) {
        process.stdout.write(`  uncovered (gap) anchors:\n`);
        for (const a of gaps) process.stdout.write(`    ${a}\n`);
    }
});
