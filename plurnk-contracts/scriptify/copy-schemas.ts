// The dist/schema mirror's single owner. dist/ is wiped by build:clean and tsc
// never emits .json, so the shipped wire schemas (the "./schema/*.json" export
// surface) must be copied deterministically here — never hand-maintained.

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const source = "schema";
const target = "dist/schema";

mkdirSync(target, { recursive: true });
for (const file of readdirSync(source).filter((f) => f.endsWith(".json"))) {
    copyFileSync(join(source, file), join(target, file));
}
process.stdout.write(`Copied ${readdirSync(source).filter((f) => f.endsWith(".json")).length} schemas to ${target}\n`);
