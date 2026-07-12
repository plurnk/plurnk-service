#!/usr/bin/env node
// Spec-coverage gate: every top-level SPEC.md section must be cited (`§N`)
// from at least one TEST file, so a section whose tests vanish turns the suite
// red instead of silently becoming prose. Sections that are policy/meta (no
// testable behavior) declare it IN THE SPEC with an explicit marker on the
// heading line — `<!-- coverage: policy -->` — never inferred here (the
// exemption table is legible spec content, not script heuristics).
//
// Implementation citations are reported informationally; the GATE is test
// citations. Sub-section citations (§16.2) count toward their top-level (§16).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = readFileSync(path.join(root, "SPEC.md"), "utf-8");

const sections = [...spec.matchAll(/^## (\d+)\.? ([^\n]+)$/gm)].map((m) => ({
    id: m[1],
    title: m[2].replace(/<!--.*-->/, "").trim(),
    policy: /<!--\s*coverage:\s*policy\s*-->/.test(m[2]),
}));

const testCites = new Map();
const implCites = new Map();
function scan(dir, inTestDir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!/node_modules|dist|generated/.test(e.name)) scan(p, inTestDir || e.name === "test");
            continue;
        }
        if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
        const isTest = inTestDir || /\.test\./.test(e.name);
        const src = readFileSync(p, "utf-8");
        for (const m of src.matchAll(/§\s?(\d+)(?:\.\d+)?/g)) {
            const map = isTest ? testCites : implCites;
            map.set(m[1], (map.get(m[1]) ?? 0) + 1);
        }
    }
}
scan(path.join(root, "src"), false);
scan(path.join(root, "test"), true);
scan(path.join(root, "bin"), false);

let bad = 0;
for (const s of sections) {
    const t = testCites.get(s.id) ?? 0;
    const i = implCites.get(s.id) ?? 0;
    if (s.policy) {
        if (t > 0) console.log(`  policy §${s.id} (${s.title}) — also test-cited ×${t}, fine`);
        continue;
    }
    if (t === 0) {
        bad += 1;
        console.error(`UNCOVERED §${s.id} ${s.title} — no test cites it (impl cites: ${i})`);
    }
}

if (bad) {
    console.error(`\n${bad} spec section(s) without test citations. Cite them from the covering tests, or mark the heading '<!-- coverage: policy -->' in SPEC.md if genuinely untestable.`);
    process.exit(1);
}
console.log(`spec:check — OK: ${sections.filter((s) => !s.policy).length} testable sections all test-cited; ${sections.filter((s) => s.policy).length} declared policy.`);
