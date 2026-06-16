import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const unesc = (s) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const debrace = (s) => s.replace(/\{(§[\w-]+)\}/g, "$1");
const props = JSON.parse(await readFile("scriptify/proposals.json", "utf8"));
const spec = await readFile("SPEC.md", "utf8");
const valid = new Set([...spec.matchAll(/\{§([^}]+)\}/g)].map((m) => "§" + m[1]));
const srcFiles = [];
const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) {
  if (["node_modules", "dist", "scriptify", ".git"].includes(e.name)) continue;
  const p = join(d, e.name);
  if (e.isDirectory()) await walk(p); else if (/\.(ts|sql)$/.test(e.name)) srcFiles.push(p);
} };
await walk("src");
const referenced = new Set();
for (const f of srcFiles) for (const m of (await readFile(f, "utf8")).matchAll(/§[\w-]+/g)) referenced.add(m[0]);
let applied = 0, miss = 0, skip = 0, invalid = 0;
for (const p of props) {
  if (p.file === null) { skip++; continue; }
  if (!valid.has(p.anchor)) { console.log(`INVALID ${p.anchor} (not a SPEC anchor)`); invalid++; continue; }
  if (referenced.has(p.anchor)) { skip++; continue; }
  const t = await readFile(p.file, "utf8");
  const oldText = unesc(p.oldText), newText = debrace(unesc(p.newText));
  if (!t.includes(oldText)) { console.log(`MISS ${p.anchor} @ ${p.file}`); miss++; continue; }
  await writeFile(p.file, t.replace(oldText, newText));
  referenced.add(p.anchor);
  console.log(`OK   ${p.anchor}`);
  applied++;
}
console.log(`\n${applied} applied, ${miss} missed, ${skip} skipped, ${invalid} invalid`);
