import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "dist" || e === ".git" || e === "generated" || e === ".changeset" || e === "CHANGELOG.md") continue;
        const p = join(dir, e);
        const s = statSync(p);
        if (s.isDirectory()) walk(p, out);
        else if (/\.(ts|mjs|js|md|sql|json|sh|py)$/.test(e)) out.push(p);
    }
    return out;
};

const stripMarkdownCode = (text) => text.replace(/^(?:`{3,}|~{3,})[\s\S]*?^(?:`{3,}|~{3,})[^\n]*$/gmu, "").replace(/`[^`\n]+`/gu, "");

const files = walk(root);
const specs = files.filter((f) => f.endsWith("/SPEC.md"));
const decl = new Map(); // tag -> {spec, line}
for (const f of specs) {
    const lines = readFileSync(f, "utf8").split("\n");
    let inFence = false;
    lines.forEach((l, i) => {
        if (/^(?:`{3,}|~{3,})/u.test(l)) { inFence = !inFence; return; }
        if (inFence) return;
        const m = /^#{2,4}\s+§([a-z][a-z0-9-]*[a-z0-9])\b/u.exec(l);
        if (m !== null && !decl.has(m[1])) decl.set(m[1], { spec: relative(root, f), line: i + 1 });
    });
}
const cites = new Map(); // tag -> {code, tests, specs, docs}
for (const f of files) {
    const rel = relative(root, f);
    const kind = /\.test\.|\/test\//.test(rel) ? "tests" : rel.endsWith("SPEC.md") ? "specs" : rel.endsWith(".md") ? "docs" : "code";
    const raw = readFileSync(f, "utf8");
    const text = rel.endsWith(".md") ? stripMarkdownCode(raw) : raw;
    for (const m of text.matchAll(/\{§([a-z0-9][a-z0-9-]*)\}/g)) {
        const t = m[1];
        const c = cites.get(t) ?? { code: 0, tests: 0, specs: 0, docs: 0 };
        c[kind]++;
        cites.set(t, c);
    }
}
const rows = [...decl.entries()].map(([tag, d]) => ({ tag, ...d, ...(cites.get(tag) ?? { code: 0, tests: 0, specs: 0, docs: 0 }) }));
const unenforced = rows.filter((r) => r.code === 0), untested = rows.filter((r) => r.tests === 0), orphan = rows.filter((r) => r.code + r.tests + r.docs === 0 && r.specs <= 1);
console.log(`declared tags: ${rows.length} across ${specs.length} SPECs`);
console.log(`cited from code: ${rows.filter((r) => r.code > 0).length} | cited from tests: ${rows.filter((r) => r.tests > 0).length} | no code citation: ${unenforced.length} | no test citation: ${untested.length} | orphan (no code/test/doc citation, ≤1 spec self-cite): ${orphan.length}`);
const perSpec = {};
for (const r of rows) { const k = r.spec; perSpec[k] ??= { tags: 0, orphan: 0 }; perSpec[k].tags++; if (orphan.includes(r)) perSpec[k].orphan++; }
console.log("per SPEC (tags / orphans):");
for (const [k, v] of Object.entries(perSpec).toSorted((a, b) => b[1].tags - a[1].tags)) console.log(`  ${k}: ${v.tags} / ${v.orphan}`);
console.log("first 25 orphan tags:", orphan.slice(0, 25).map((r) => r.tag).join(", "));
const undeclaredCites = [...cites.keys()].filter((t) => !decl.has(t));
console.log(`cited but never declared as a block: ${undeclaredCites.length}`, undeclaredCites.slice(0, 12).join(", "));
const specText = new Map(specs.map((f) => [relative(root, f), readFileSync(f, "utf8").split("\n")]));
const grouped = new Map();
for (const r of orphan) (grouped.get(r.spec) ?? grouped.set(r.spec, []).get(r.spec)).push(r);
for (const [spec, specRows] of [...grouped.entries()].toSorted((a, b) => b[1].length - a[1].length)) {
    console.log(`\n## ${spec}\n`);
    for (const r of specRows.toSorted((a, b) => a.line - b.line)) console.log(`- ${r.line}: §${r.tag} — ${specText.get(spec)[r.line - 1].trim().slice(0, 160)}`);
}
