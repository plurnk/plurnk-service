// Build step: copy src/**/*.sql into dist/ (tsc emits only .js). sqlrite loads schema +
// prepared statements off disk at runtime, so a published install needs the .sql beside dist/.
import { cpSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { usage } from "../../scripts/lib/usage.mjs";

usage(`
usage: npm run build:sql   (a step of npm run build, from plurnk-core)
Build step: copies src/**/*.sql beside dist/, since tsc emits only JavaScript and SqlRite loads the statements from disk at runtime.
Reads: src/**/*.sql.
Writes: dist/**/*.sql.
`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(resolve(root, "src"), resolve(root, "dist"), {
    recursive: true,
    filter: (src) => statSync(src).isDirectory() || src.endsWith(".sql"),
});
