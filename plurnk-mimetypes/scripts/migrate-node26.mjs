#!/usr/bin/env node
// One-shot ecosystem migration: raise engines.node to >=26 across every
// @plurnk/plurnk-mimetypes-* package and commit+push each. `>=25` already
// permitted Node 26 (it's a floor), so this is a deliberate baseline raise —
// 26 becomes the minimum, dropping 25. Verified: framework 529 + embeddings
// (workers+wasm) + handlers all pass on v26.3.1.
//
//   node scripts/migrate-node26.mjs --check   # report, change nothing
//   node scripts/migrate-node26.mjs           # bump + commit + push each
//
// Config: PLURNK_MIMETYPES_FAMILY_ROOT (.env.example), default = this checkout's parent.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(); } catch { /* no .env — fine */ }
// Rename tripwires (family-prefix sweep): old knob names crash with a pointer,
// never silently ignored (a stale FAMILY_ROOT would silently scan the wrong dir).
for (const old of ["PLURNK_AUDIT_LEVEL", "PLURNK_FAMILY_ROOT", "PLURNK_GRAMMARS_ROOT"]) {
    if (process.env[old] !== undefined) throw new Error(`${old} was renamed to ${old.replace("PLURNK_", "PLURNK_MIMETYPES_")} (family-prefix convention); update the environment.`);
}


const check = process.argv.includes("--check");
const TARGET = ">=26";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PLURNK_MIMETYPES_FAMILY_ROOT
    ? path.resolve(process.env.PLURNK_MIMETYPES_FAMILY_ROOT)
    : path.resolve(here, "..", "..");

const entries = await readdir(root, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory() && e.name.includes("plurnk-mimetypes")).map((e) => e.name).sort();

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf-8" });

const results = [];
for (const name of dirs) {
    const dir = path.join(root, name);
    const pkgPath = path.join(dir, "package.json");
    let pkg;
    try { pkg = JSON.parse(await readFile(pkgPath, "utf-8")); }
    catch { continue; }
    if (!pkg.name?.includes("plurnk-mimetypes")) continue;
    const current = pkg.engines?.node;
    if (current === TARGET) { results.push({ name, state: "already" }); continue; }
    if (check) { results.push({ name, state: "would-bump", note: `${current ?? "(none)"} → ${TARGET}` }); continue; }

    pkg.engines = { ...(pkg.engines ?? {}), node: TARGET };
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
    try {
        git(["add", "package.json"], dir);
        git(["commit", "-m", "chore: require Node >=26 (ecosystem migration)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"], dir);
        git(["push", "origin", "main"], dir);
        results.push({ name, state: "migrated", note: `${current ?? "(none)"} → ${TARGET}` });
    } catch (e) {
        results.push({ name, state: "failed", note: (e.stderr || e.message || "").toString().trim().split("\n").pop() });
    }
}

const by = (s) => results.filter((r) => r.state === s);
console.log(`\n${check ? "CHECK" : "MIGRATE"} — ${results.length} family packages under ${root}`);
for (const r of results) console.log(`  ${r.state.padEnd(11)} ${r.name}${r.note ? "  " + r.note : ""}`);
console.log(`\nmigrated=${by("migrated").length} would-bump=${by("would-bump").length} already=${by("already").length} failed=${by("failed").length}`);
if (by("failed").length) process.exitCode = 1;
