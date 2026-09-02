// usage: SPEC=<spec.json> node scripts/anatomy/carry-or-share.mjs <sharedModulePath> <doc> <name>...  — consts used only inside the spec's members are carried; the rest move to the shared module
import { readFileSync, writeFileSync } from "node:fs";
const [sharedPath, doc, ...names] = process.argv.slice(2); const spec = JSON.parse(readFileSync(process.env.SPEC, "utf8"));
let text = readFileSync(spec.file, "utf8").split("\n");
const spans = spec.members.map((m) => { const head = text.findIndex((l) => new RegExp(`^    (static )?(async )?#?${m}\\(`).test(l)); if (head < 0) throw new Error(`member ${m}`); let end = head, d = 0, seen = false; for (let i = head; i < text.length; i++) { for (const ch of text[i]) { if (ch === "{") { d++; seen = true; } if (ch === "}") d--; } if (seen && d === 0) { end = i; break; } } return [head, end]; });
const inside = (i) => spans.some(([a, b]) => i >= a && i <= b);
const blockRange = (n) => { const defIdx = text.findIndex((l) => new RegExp(`^(export )?const ${n}\\b`).test(l)); if (defIdx < 0) throw new Error(`const ${n}`); let to = defIdx, d = 0; for (;;) { for (const ch of text[to]) { if ("([{".includes(ch)) d++; if (")]}".includes(ch)) d--; } if (d === 0 && /;\s*$/.test(text[to])) break; to++; } return [defIdx, to]; };
const topConsts = text.map((l, i) => { const m = l.match(/^(?:export )?const ([A-Za-z_][A-Za-z0-9_]*)/); return m && i < text.findIndex((x) => /^export default class /.test(x)) ? m[1] : null; }).filter(Boolean);
for (let grew = true; grew;) { grew = false; for (const n of [...names]) { const [a, b] = blockRange(n); for (const c of topConsts) if (!names.includes(c) && text.slice(a, b + 1).some((l) => new RegExp(`(?<![A-Za-z0-9_.#])${c}(?![A-Za-z0-9_])`).test(l))) { names.push(c); grew = true; } } }
const nameRanges = names.map(blockRange); const insideAny = (i) => inside(i) || nameRanges.some(([a, b]) => i >= a && i <= b);
const carry = [], share = [];
for (const n of names) { const defIdx = text.findIndex((l) => new RegExp(`^(export )?const ${n}\\b`).test(l)); if (defIdx < 0) throw new Error(`const ${n}`); const uses = text.map((l, i) => new RegExp(`(?<![A-Za-z0-9_.#])${n}(?![A-Za-z0-9_])`).test(l) ? i : -1).filter((i) => i >= 0 && i !== defIdx); const outside = uses.filter((i) => !insideAny(i)); console.log(`${n}: inside ${uses.length - outside.length}, outside ${outside.length}`); (outside.length ? share : carry).push(n); }
// shared consts may reference other shared/carried consts: move dependents together (a carried const referenced by a shared one becomes shared)
for (let changed = true; changed;) { changed = false; for (const n of [...carry]) { const usedByShared = share.some((s) => { const sIdx = text.findIndex((l) => new RegExp(`^(export )?const ${s}\\b`).test(l)); let to = sIdx, d = 0; for (;;) { for (const ch of text[to]) { if ("([{".includes(ch)) d++; if (")]}".includes(ch)) d--; } if (d === 0 && /;\s*$/.test(text[to])) break; to++; } return text.slice(sIdx, to + 1).some((l) => new RegExp(`(?<![A-Za-z0-9_.#])${n}(?![A-Za-z0-9_])`).test(l)); }); if (usedByShared) { carry.splice(carry.indexOf(n), 1); share.push(n); changed = true; } } }
const blocks = [];
for (const n of share) { const defIdx = text.findIndex((l) => new RegExp(`^(export )?const ${n}\\b`).test(l)); let from = defIdx; while (from > 0 && /^\s*\/\//.test(text[from - 1])) from--; let to = defIdx, d = 0; for (;;) { for (const ch of text[to]) { if ("([{".includes(ch)) d++; if (")]}".includes(ch)) d--; } if (d === 0 && /;\s*$/.test(text[to])) break; to++; } blocks.push(text.slice(from, to + 1)); text.splice(from, to - from + 1); if (text[from] === "" && text[from - 1] === "") text.splice(from, 1); }
if (share.length) {
  const importsEnd = text.reduce((last, l, i) => (/^import |^} from "/.test(l) ? i : last), 0);
  const rel = "./" + sharedPath.split("/").pop();
  text.splice(importsEnd + 1, 0, `import { ${share.toSorted().join(", ")} } from "${rel}";`);
  const imports = []; for (let i = 0; i <= importsEnd; i++) { if (!/^import /.test(text[i])) continue; let j = i; imports.push(text[j]); while (!/;\s*$/.test(text[j])) { j++; imports.push(text[j]); } i = j; }
  writeFileSync(sharedPath, `${doc}\n${imports.join("\n")}\n\n${blocks.map((b) => b.join("\n").replace(/^const /m, "export const ")).join("\n\n")}\n`);
  writeFileSync(spec.file, text.join("\n"));
}
spec.carryConsts = [...(spec.carryConsts ?? []), ...carry]; writeFileSync(process.env.SPEC, JSON.stringify(spec, null, 1));
console.log("carry:", carry.join(", ") || "-", "| shared →", share.join(", ") || "-");
