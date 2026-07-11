// Spec-anchor conformance (the family convention, mirroring plurnk-service's
// spec-anchors intg test). SPEC.md carries named `{§kebab-case}` anchors; code
// cites them as `SPEC §name`. Two directions, both fail-hard:
//   1. Every local citation resolves to an existing anchor (no dangling refs —
//      the rot class this replaced: positional `§N` citations survived spec
//      renumbering/extraction as silent lies, e.g. a `§16.9` cite against a
//      six-section spec).
//   2. Every anchor is cited from src at least once (anchors are citation-born;
//      an uncited anchor is a dead tag — retire it or cite it).
// Cross-doc citations ("service SPEC …", "schemes SPEC …") are prose, not
// checkable here, and are excluded by the lookbehind. Numeric local citations
// (`SPEC §5`) are rejected outright: positional refs are the drift vector.

import test from "node:test";
import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";

const SPEC_URL = new URL("../SPEC.md", import.meta.url);
const SRC_URL = new URL("./", import.meta.url);

// Local citations only: a "service SPEC"/"schemes SPEC" prefix marks a
// cross-doc reference this repo cannot validate.
const CITATION = /(?<!service )(?<!schemes )SPEC(?:\.md)? ?§([a-z0-9-]+)/g;
const ANCHOR = /\{§([a-z0-9-]+)\}/g;

const spec = await readFile(SPEC_URL, "utf-8");
const anchors = new Set([...spec.matchAll(ANCHOR)].map((m) => m[1]));

// The checker's own comments legitimately discuss citation syntax — exclude it.
const SELF = "spec-anchors.test.ts";
const srcFiles = (await readdir(SRC_URL)).filter((f) => f.endsWith(".ts") && f !== SELF);
const citations: Array<{ file: string; name: string }> = [];
for (const file of srcFiles) {
    const text = await readFile(new URL(file, SRC_URL), "utf-8");
    for (const m of text.matchAll(CITATION)) citations.push({ file, name: m[1] });
}

test("SPEC.md declares at least one named anchor", () => {
    assert.ok(anchors.size > 0, "SPEC.md has no {§name} anchors");
});

test("every local SPEC citation in src resolves to an existing anchor", () => {
    for (const { file, name } of citations) {
        assert.ok(!/^[0-9]/.test(name), `${file}: positional citation "SPEC §${name}" — cite a named {§anchor} instead`);
        assert.ok(anchors.has(name), `${file}: dangling citation "SPEC §${name}" — no {§${name}} anchor in SPEC.md`);
    }
});

test("every SPEC anchor is cited from src (anchors are citation-born)", () => {
    const cited = new Set(citations.map((c) => c.name));
    for (const anchor of anchors) {
        assert.ok(cited.has(anchor), `SPEC.md anchor {§${anchor}} is cited nowhere in src — retire it or cite it`);
    }
});
