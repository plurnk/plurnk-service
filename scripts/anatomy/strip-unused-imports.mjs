// usage: node scripts/anatomy/strip-unused-imports.mjs <file.ts>... — removes import specifiers (and whole import lines) whose name never appears outside the import block; prints what it dropped.
import { readFileSync, writeFileSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  let text = readFileSync(file, "utf8");
  const importRe = /^import (type )?(\{[^}]*\}|[A-Za-z_$][\w$]*|\* as [A-Za-z_$][\w$]*)(, \{[^}]*\})? from "[^"]+";\n/gm;
  const imports = [...text.matchAll(importRe)];
  const body = text.replace(importRe, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const used = (name) => new RegExp(`(?<![\\w$#])(?<!(?<!\\.)\\.)${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body);
  const dropped = [];
  for (const m of imports) {
    const full = m[0];
    const rebuild = (spec) => {
      if (spec.startsWith("{")) { const names = spec.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean); const kept = names.filter((n) => { const local = n.replace(/^type /, "").split(/\s+as\s+/).pop(); const ok = used(local); if (!ok) dropped.push(local); return ok; }); return kept.length ? `{ ${kept.join(", ")} }` : null; }
      if (spec.startsWith("* as ")) { const local = spec.slice(5); if (used(local)) return spec; dropped.push(local); return null; }
      if (used(spec)) return spec; dropped.push(spec); return null;
    };
    const parts = [m[2], m[3]?.slice(2)].filter(Boolean).map(rebuild).filter(Boolean);
    const from = full.match(/ from "([^"]+)";/)[1];
    const replacement = parts.length ? `import ${m[1] ?? ""}${parts.join(", ")} from "${from}";\n` : "";
    text = text.replace(full, replacement);
  }
  // multi-line brace imports: normalise the ones the split generated (one name per line) the same way
  const multi = /^import (type )?\{\n((?:    [^\n]+,\n)+)\} from "([^"]+)";\n/gm;
  text = text.replace(multi, (all, t, names, from) => { const kept = names.split("\n").map((s) => s.replace(/,$/, "").trim()).filter(Boolean).filter((n) => { const local = n.replace(/^type /, "").split(/\s+as\s+/).pop(); const ok = used(local); if (!ok) dropped.push(local); return ok; }); return kept.length ? `import ${t ?? ""}{\n${kept.map((n) => `    ${n},`).join("\n")}\n} from "${from}";\n` : ""; });
  writeFileSync(file, text);
  console.log(`${file.split("/").pop()}: dropped ${dropped.length}: ${dropped.join(", ")}`);
}
