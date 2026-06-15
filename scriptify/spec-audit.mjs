// One-off (reusable) audit of the SPEC{§} ↔ test[§] ↔ code§ anchor linkage.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const ROOT = process.cwd();
const walk = async (dir, acc = []) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "scriptify"].includes(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
};
const grab = (text, re) => { const s = new Set(); let m; while ((m = re.exec(text))) s.add(m[1]); return s; };
const spec = await readFile(join(ROOT, "SPEC.md"), "utf8");
const anchors = grab(spec, /\{§([^}]+)\}/g);
const tCites = new Set();
for (const f of await walk(join(ROOT, "test"))) for (const a of grab(await readFile(f, "utf8"), /\[§([^\]]+)\]/g)) tCites.add(a);
const cRefs = new Set();
for (const f of await walk(join(ROOT, "src"))) for (const a of grab(await readFile(f, "utf8"), /§([A-Za-z0-9][\w.-]*)/g)) cRefs.add(a);
const S = (s) => [...s].sort();
console.log(`SPEC {§} anchors: ${anchors.size}   test [§] cites: ${tCites.size}   code §refs: ${cRefs.size}`);
const noTest = S(anchors).filter(a => !tCites.has(a));
console.log(`\nanchors NOT cited by a test (${noTest.length}): ${noTest.map(a=>"§"+a).join("  ") || "(none — 100%)"}`);
const noCode = S(anchors).filter(a => !cRefs.has(a));
console.log(`\nanchors with NO src §reference — the tagging gap (${noCode.length}):`);
noCode.forEach(a => console.log(`  §${a}`));
const orphan = S(cRefs).filter(a => !anchors.has(a) && /[a-z-]/.test(a) && a.includes("-"));
console.log(`\ncode §refs that look like anchors but are NOT in SPEC — typos/renamed (${orphan.length}):`);
orphan.forEach(a => console.log(`  §${a}`));
