#!/usr/bin/env node
// Freshness gate for a package with no node_modules (an aggregator / pin manifest):
// every first-party EXACT pin in the CWD's package.json must match npm-latest.
// No install required — compares pins to the registry directly (an aggregator has
// no node_modules, so install-based `npm outdated` reports MISSING and exits 0,
// useless as a gate). Wire into a package's prepublishOnly so `npm publish`
// refuses on a stale pin — the re-pin treadmill (a child publishes, this pin
// silently falls behind) can no longer ship. Caret/range floors are intentional
// minimums and never flagged. Run from the package root (`plurnk-mimetypes-deps-fresh`).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const pj = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));

const triplet = (v) => v.replace(/^[\^~>=<\s]+/, "").split("-")[0].split(".").map(Number);
const cmp = (a, b) => { const [A, B] = [triplet(a), triplet(b)]; for (let i = 0; i < 3; i += 1) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0); } return 0; };
const isExact = (range) => /^\d/.test(range);

const stale = [];
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(pj[field] || {})) {
        if (!isExact(range)) continue;
        let latest = null;
        try { latest = execFileSync("npm", ["view", name, "version"], { encoding: "utf-8" }).trim(); } catch { /* unpublished */ }
        if (latest && cmp(range, latest) < 0) stale.push({ field, name, range, latest });
    }
}

if (stale.length === 0) {
    console.log(`deps:fresh — OK, ${Object.keys({ ...pj.dependencies, ...pj.devDependencies }).length} pins match npm-latest.`);
    process.exit(0);
}
console.error("deps:fresh — STALE first-party exact pins:");
for (const s of stale) console.error(`  ${s.name}  pins ${s.range} → npm ${s.latest}  [${s.field}]`);
process.exit(1);
