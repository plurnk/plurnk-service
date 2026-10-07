// Candidate-only release checks. The caller already built and ran the canonical
// deterministic test gate; this sweep proves dependency and packed-artifact facts
// plus the few package-specific checks that have no ordinary test-tier meaning.
// Usage: node scripts/release-gates.mjs [--only <pkg-dir>]...
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const run = promisify(execFile);
const { values } = parseArgs({ options: { only: { type: "string", multiple: true } } });

const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const dirs = [...new Set(values.only ?? root.workspaces)];
for (const dir of dirs) {
    if (!root.workspaces.includes(dir)) throw new Error(`unknown workspace directory: ${dir}`);
}
const selection = (values.only ?? []).flatMap((dir) => ["--only", dir]);

await run("node", ["scripts/package-build-policy.mjs"]);
const provenanceArgs = ["scripts/package-provenance.mjs", "--pack"];
provenanceArgs.push(...selection);
await run("node", provenanceArgs, { maxBuffer: 64 * 1024 * 1024 });
const publintArgs = ["scripts/package-publint.mjs"];
publintArgs.push(...selection);
await run("node", publintArgs, { maxBuffer: 64 * 1024 * 1024 });

let gated = 0;
for (const dir of dirs) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.["release:check"] === undefined) continue;
    console.log(`  release-check ${pkg.name}`);
    await run("npm", ["run", "release:check", "-w", pkg.name], { maxBuffer: 64 * 1024 * 1024 });
    gated++;
}
console.log(`release-gates GREEN: package shape, packed projection, ${gated} package-specific check(s)`);
