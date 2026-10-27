// The dist/schema mirror's single owner. dist/ is wiped by build:clean and tsc
// never emits .json, so the shipped wire schemas (the "./schema/*.json" export
// surface) must be copied deterministically here — never hand-maintained.

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

let copied = 0;
const target = join("dist", "schema");
mkdirSync(target, { recursive: true });
for (const file of readdirSync("schema").filter((candidate) => candidate.endsWith(".json"))) {
    copyFileSync(join("schema", file), join(target, file));
    copied++;
}
process.stdout.write(`Copied ${copied} contract JSON resources to dist\n`);
