// The pre-stamp gate sweep (#505 post-mortem, law 4's other half): run every workspace's OWN
// prepublish gate BEFORE the stamp, so a red that would refuse a publish is found before the
// train leaves — never mid-publish over a stamped tree. The drill (lint+unit+intg) is the
// push gate; the per-package prepublishOnly gates (deps:fresh, audit, conformance tiers) are
// the PUBLISH bar, and until this script they ran for the first time during publish itself.
// Expensive by design — a release is deliberate ("pain is the best teacher").
// Usage: node scripts/release-gates.mjs [--only <pkg-dir>]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const run = promisify(execFile);
const { values } = parseArgs({ options: { only: { type: "string" } } });

const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const dirs = values.only ? [values.only] : root.workspaces;

let gated = 0;
for (const dir of dirs) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.prepublishOnly === undefined) { console.log(`  no-gate ${pkg.name}`); continue; }
    console.log(`  gate    ${pkg.name}`);
    // The workspace's own bar, exactly as publish would run it; a red rejects and HALTS here,
    // before any stamp exists to tear.
    await run("npm", ["run", "prepublishOnly", "-w", pkg.name], { maxBuffer: 64 * 1024 * 1024 });
    gated++;
}
console.log(`release-gates GREEN: ${gated} publish gates passed pre-stamp`);
