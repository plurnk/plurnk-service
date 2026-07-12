// Bidirectional SPEC ↔ test coverage (Charter §5, AGENTS.md §9). Extracts squiggle anchors
// from SPEC.md's markdown links (`[§key](#slug)`) and from `[§key]` tokens in test names,
// and reports any mismatch in either direction. Asserted by test/intg/spec-coverage.test.ts.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const specAnchors = (): Set<string> => {
    const spec = readFileSync(join(root, "SPEC.md"), "utf8");
    const keys = new Set<string>();
    for (const m of spec.matchAll(/\[§(\w+)\]\(#[\w-]+\)/g)) keys.add(m[1]);
    return keys;
};

const testAnchors = (): Set<string> => {
    const dir = join(root, "test");
    const keys = new Set<string>();
    for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        if (!rel.endsWith(".test.ts")) continue;
        for (const m of readFileSync(join(dir, rel), "utf8").matchAll(/\[§(\w+)\]/g)) keys.add(m[1]);
    }
    return keys;
};

export const checkSpecCoverage = (): { specOnly: string[]; testOnly: string[] } => {
    const spec = specAnchors();
    const tests = testAnchors();
    return {
        specOnly: [...spec].filter((k) => !tests.has(k)).sort(), // contract with no test
        testOnly: [...tests].filter((k) => !spec.has(k)).sort(), // test claims a missing contract
    };
};
