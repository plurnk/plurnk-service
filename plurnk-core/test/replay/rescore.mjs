// Re-derive each replay row's kind from its recorded head under the current scorer rules.
// usage: node test/replay/rescore.mjs <out.jsonl>...
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const recorded = readFileSync(resolve(import.meta.dirname, "fixtures", "run6-django-15819-kmax-T13.user.md"), "utf8");
const hashLine = new Map();
for (const line of recorded.split("\n")) { const m = /^@([0-9A-Za-z]{5}) +(\d+):/u.exec(line); if (m) hashLine.set(m[1], Number(m[2])); }
const TARGET_TEXT = { 135: "column_to_field_name", 136: "for row in table_description", 131: "yield" };
const score = (head, intended) => {
    const m = /(?:^|\n)`{0,4}EDIT\s*\([^)]*\)\s*<([^>]*)>/u.exec(head);
    if (!m) {
        const pattern = /(?:^|\n)`{0,4}EDIT\s*\([^)]*\)\s*\/(.+?)\//u.exec(head);
        if (pattern) return pattern[1].includes(TARGET_TEXT[intended[0]] ?? "\u0000") ? "pattern-exact" : "pattern-other";
        return "no-edit-scope";
    }
    const marks = m[1].split(",").map((s) => s.trim());
    const anchored = marks.map((s) => /@([0-9A-Za-z]{5})/u.exec(s)?.[1]).filter((h) => h !== undefined);
    const lines = anchored.map((h) => hashLine.get(h) ?? null);
    if (lines.length === 0) {
        const n = Number(marks[0]);
        return n === intended[0] ? "numeric-exact" : Number.isFinite(n) ? `numeric-${n === intended[0] + 1 ? "N+1" : "other"}` : "numeric";
    }
    const first = lines[0];
    if (first === null) return "unknown-hash";
    const t = intended[0];
    // A zero-width insert before N+1 is an insert after N: the same edit as replacing N with itself plus the new line.
    const insertAfter = marks.length === 4 && marks[0] === marks[2] && marks[1] === "1" && marks[3] === "1" && first === t + 1;
    if (insertAfter) return "exact(insert-after)";
    return first === t ? "exact" : first === t + 1 ? "N+1" : first === t - 1 ? "N-1" : "other";
};
for (const name of process.argv.slice(2)) {
    const path = name;
    let rows;
    try { rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { console.log(name, "missing"); continue; }
    const by = {};
    for (const r of rows) { const k = `${r.rendering}/${r.task ?? r.card}`; const kind = score(r.head ?? "", r.intended ?? [135]); by[k] ??= {}; by[k][kind] = (by[k][kind] ?? 0) + 1; }
    console.log(`== ${name} (${rows.length} rows)`);
    for (const [k, v] of Object.entries(by).sort()) console.log("  ", k.padEnd(24), JSON.stringify(v));
}
