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
// (`§transport`), the postfix the promise (`§op-look`). No digits —
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

// Both tiers cite: intg under test/, unit alongside its file under src/ (the testing policy).
const collectAllTestAnchors = async (): Promise<Set<string>> => {
    const all = new Set<string>();
    for (const dir of ["test", "src"]) {
        for (const a of await collectTestAnchorsFromDir(resolve(REPO_ROOT, dir))) all.add(a);
    }
    return all;
};

test("spec anchors: no orphan test references (test cites anchor not in SPEC.md)", async () => {
    const spec = await readFile(resolve(REPO_ROOT, "SPEC.md"), "utf8");
    const specAnchors = extractSpecAnchors(spec);
    const testAnchors = await collectAllTestAnchors();

    const orphans = [...testAnchors].filter((a) => !specAnchors.has(a)).toSorted();
    if (orphans.length > 0) {
        const list = orphans.map((a) => `  ${a}`).join("\n");
        assert.fail(`orphan test anchors (referenced but not present in SPEC.md):\n${list}\n\nFix: either correct the typo in the test name or add the anchor to the corresponding spec promise.`);
    }
});

test("spec anchors: every SPEC promise is cited by a test (coverage enforced)", async () => {
    const spec = await readFile(resolve(REPO_ROOT, "SPEC.md"), "utf8");
    const specAnchors = extractSpecAnchors(spec);
    const testAnchors = await collectAllTestAnchors();

    const gaps = [...specAnchors].filter((a) => !testAnchors.has(a)).toSorted();
    const covered = specAnchors.size - gaps.length;
    const pct = specAnchors.size === 0 ? 100 : Math.round((covered / specAnchors.size) * 100);
    process.stdout.write(`\n  spec-anchor coverage: ${covered}/${specAnchors.size} (${pct}%)\n`);

    if (gaps.length > 0) {
        const list = gaps.map((a) => `  ${a}`).join("\n");
        assert.fail(`${gaps.length} SPEC promise(s) cited by NO test — coverage regressed:\n${list}\n\nFix: add a test named "[§<id>] …" that exercises the contract. A red test for an unbuilt contract is acceptable — the anchor must simply be cited.`);
    }
});

test("every §-reference in code comments resolves to a live SPEC anchor or section — comment refs never rot", async () => {
    // The THIRD leg of the lockstep (the first two: every {§} cited by a [§] test, every [§]
    // resolving to a {§}). Code comments citing §-anchors are how implementation maps back to
    // the SPEC; a renamed anchor silently orphans them. Rule: any hyphenated kebab-style ref in
    // src/**/*.{ts,sql} or test/ must exist as a {§...} anchor or a `## §...` section heading.
    // (Single-word/numeric §refs are external-spec or issue refs and are exempt — write issue
    // refs as #N and qualify external specs by name.)
    const { readFile: rf, readdir: rd, stat: st } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const spec = await rf(resolve(REPO_ROOT, "SPEC.md"), "utf8");
    const live = new Set([
        ...[...spec.matchAll(/\{§([a-z0-9-]+)\}/g)].map((m) => m[1]),
        ...[...spec.matchAll(/^#{2,4} §([a-z0-9-]+)/gm)].map((m) => m[1]),
    ]);
    const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
        for (const f of await rd(dir)) {
            const p = join(dir, f);
            if ((await st(p)).isDirectory()) { if (!/node_modules|\.tmp|\.git|digest/.test(p)) await walk(p, out); }
            else if (/\.(ts|sql)$/.test(f)) out.push(p);
        }
        return out;
    };
    const stale: string[] = [];
    for (const file of [...await walk(resolve(REPO_ROOT, "src")), ...await walk(resolve(REPO_ROOT, "test"))]) {
        const text = await rf(file, "utf8");
        for (const [i, line] of text.split("\n").entries()) {
            for (const m of line.matchAll(/§([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g)) {
                if (!live.has(m[1])) stale.push(`${file.replace(String(REPO_ROOT) + "/", "")}:${i + 1} §${m[1]}`);
            }
        }
    }
    assert.deepEqual(stale, [], `stale §-references in comments (the anchor was renamed or removed — update the ref):\n${stale.join("\n")}`);
});
