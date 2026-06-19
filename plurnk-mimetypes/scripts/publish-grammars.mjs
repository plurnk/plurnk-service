#!/usr/bin/env node
// Publish every grammar package whose local version is ahead of npm — the last
// step after `grammars:update`. Run inside an OTP window; npm uses the active
// one-time password for each publish. This is the only step that needs the OTP.
//
//   npm run grammars:publish
//
// Config: PLURNK_GRAMMARS_ROOT (.env.example) — same as grammars:update.
import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(); } catch { /* no .env — fine */ }

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PLURNK_GRAMMARS_ROOT
    ? path.resolve(process.env.PLURNK_GRAMMARS_ROOT)
    : path.resolve(here, "..", "..");

const names = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("plurnk-mimetypes-grammar-"))
    .map((e) => e.name)
    .sort();

let shipped = 0;
let skipped = 0;
for (const name of names) {
    const dir = path.join(root, name);
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8"));
    let npmVer = "";
    try { npmVer = execFileSync("npm", ["view", pkg.name, "version"], { encoding: "utf-8" }).trim(); } catch { /* unpublished */ }
    if (pkg.version === npmVer) { skipped += 1; continue; }
    console.log(`publishing ${pkg.name} ${npmVer || "(new)"} -> ${pkg.version} ...`);
    try {
        execFileSync("npm", ["publish"], { cwd: dir, stdio: "inherit" });
        shipped += 1;
    } catch {
        console.error(`  FAILED: ${pkg.name} (OTP expired? re-run to resume — already-published versions are skipped)`);
    }
}
console.log(`\nshipped=${shipped} already-current=${skipped}`);
