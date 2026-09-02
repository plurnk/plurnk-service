// usage: node scripts/anatomy/class-members.mjs <file.ts> — prints top-level declarations and class members with their line spans, largest first
import { readFileSync } from "node:fs";
const file = process.argv[2]; const lines = readFileSync(file, "utf8").split("\n");
const heads = [];
lines.forEach((l, i) => {
  if (/^(export )?(default )?(abstract )?(class|function|async function|const|let|interface|type|enum) /.test(l)) heads.push({ n: i + 1, kind: "top", head: l.trim().slice(0, 90) });
  else if (/^ {2,4}(static |async |readonly |get |set |private |protected |public |override |#)*[a-zA-Z#_][a-zA-Z0-9_]*(<[^>]*>)?\(/.test(l) && !/^\s*(if|for|while|switch|return|await|throw)\b/.test(l.trim())) heads.push({ n: i + 1, kind: "member", head: l.trim().slice(0, 90) });
  else if (/^ {2,4}(static |readonly |#)*[a-zA-Z#_][a-zA-Z0-9_]* = /.test(l)) heads.push({ n: i + 1, kind: "field", head: l.trim().slice(0, 90) });
});
const spans = heads.map((h, i) => ({ ...h, span: (heads[i + 1]?.n ?? lines.length + 1) - h.n }));
console.log(`${file}: ${lines.length} lines, ${spans.filter((s) => s.kind === "member").length} members, ${spans.filter((s) => s.kind === "top").length} top-level`);
for (const s of spans.toSorted((a, b) => b.span - a.span).slice(0, +(process.argv[3] ?? 30))) console.log(`${String(s.n).padStart(5)} ${String(s.span).padStart(4)}  ${s.kind.padEnd(6)} ${s.head}`);
