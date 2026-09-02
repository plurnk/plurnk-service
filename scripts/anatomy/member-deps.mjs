// usage: node scripts/anatomy/member-deps.mjs <file.ts> [minLines] — for each class member ≥ minLines, the private fields (this.#x) and private methods it touches
import { readFileSync } from "node:fs";
const [file, min = "60"] = process.argv.slice(2); const lines = readFileSync(file, "utf8").split("\n");
const heads = []; lines.forEach((l, i) => { const m = l.match(/^ {2,4}(?:static |async |readonly |get |set |override |#)*(#?[a-zA-Z_][a-zA-Z0-9_]*)(?:<[^>]*>)?\(/); if (m && !/^\s*(if|for|while|switch|return|await|throw|catch)\b/.test(l.trim())) heads.push({ name: m[1], n: i + 1 }); });
heads.forEach((h, i) => { h.end = (heads[i + 1]?.n ?? lines.length + 1) - 1; });
const fields = new Set([...readFileSync(file, "utf8").matchAll(/^ {2,4}(?:static )?(?:readonly )?(#[a-zA-Z_][a-zA-Z0-9_]*)(?:\??:| =)/gm)].map((m) => m[1]));
for (const h of heads.filter((h) => h.end - h.n + 1 >= +min)) {
  const body = lines.slice(h.n - 1, h.end).join("\n");
  const f = new Set(), ms = new Set();
  for (const m of body.matchAll(/this\.(#[a-zA-Z_][a-zA-Z0-9_]*)(\()?/g)) (m[2] || !fields.has(m[1]) ? ms : f).add(m[1]);
  console.log(`${String(h.n).padStart(5)} ${String(h.end - h.n + 1).padStart(4)}  ${h.name.padEnd(30)} fields[${f.size}]: ${[...f].join(" ")}\n${" ".repeat(42)}methods[${ms.size}]: ${[...ms].join(" ")}`);
}
console.log(`class fields (${fields.size}): ${[...fields].join(" ")}`);
