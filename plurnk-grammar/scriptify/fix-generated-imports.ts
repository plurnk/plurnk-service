import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = "src/generated";
const entries = await readdir(dir);
const pattern = /from\s+(['"])\.\/([^'"]+)\.js\1/g;

for (const file of entries) {
  if (!file.endsWith(".ts")) continue;
  const path = join(dir, file);
  const original = await readFile(path, "utf8");
  const fixed = original.replace(pattern, "from $1./$2.ts$1");
  if (fixed !== original) await writeFile(path, fixed);
}
