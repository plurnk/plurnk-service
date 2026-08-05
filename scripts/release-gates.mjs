// The committed-candidate gate sweep runs every workspace's own
// prepublish gate after the stamp is committed but BEFORE the first package is
// published. A red halts before the train leaves. The drill (lint+unit+intg) is the
// push gate; the per-package prepublishOnly gates (audit, tests, conformance tiers) are
// the PUBLISH bar, and until this script they ran for the first time during publish itself.
// release:publish builds every workspace immediately before this sweep, then
// uses --ignore-scripts so these complete gates run exactly once.
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

await run("node", ["scripts/package-build-policy.mjs"]);
const provenanceArgs = ["scripts/package-provenance.mjs", "--pack"];
if (values.only !== undefined) provenanceArgs.push("--only", values.only);
await run("node", provenanceArgs, { maxBuffer: 64 * 1024 * 1024 });

let gated = 0;
for (const dir of dirs) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.prepublishOnly === undefined) { console.log(`  no-gate ${pkg.name}`); continue; }
    console.log(`  gate    ${pkg.name}`);
    // The workspace's own bar, exactly as publish would run it; a red rejects
    // and HALTS before the first registry mutation.
    await run("npm", ["run", "prepublishOnly", "-w", pkg.name], { maxBuffer: 64 * 1024 * 1024 });
    gated++;
}
console.log(`release-gates GREEN: ${gated} publish gates passed pre-stamp`);
