import assert from "node:assert/strict";
import test from "node:test";
import { unresolvedSpecReferences } from "./spec-references.mjs";

const cite = (tag) => `{${"§"}${tag}}`;

test("spec references resolve against declarations in any owning SPEC.md", () => {
    const files = [
        { name: "alpha/SPEC.md", text: `${cite("one-owner")}\n### §heading-contract` },
        { name: "alpha/code.ts", text: `// ${cite("one-owner")}\n// ${cite("heading-contract")}` },
    ];
    assert.deepEqual(unresolvedSpecReferences(files), []);
});

test("spec references report each unresolved outside-SPEC citation with its line", () => {
    const files = [
        { name: "SPEC.md", text: cite("known") },
        { name: "code.ts", text: `// ${cite("known")}\n// ${cite("typo")}\n// {§…}` },
    ];
    assert.deepEqual(unresolvedSpecReferences(files), [
        { name: "code.ts", line: 2, tag: "typo" },
    ]);
});
