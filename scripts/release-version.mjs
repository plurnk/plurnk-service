// Lockstep version stamp. Usage: node scripts/release-version.mjs <version>
// Sets every workspace to <version>, pins internal runtime/dev dependencies
// exactly, and gives plugin-facing peers a current-minor compatibility range.
// The root workspaces array is authoritative; a missing manifest crashes.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const version = process.argv[2];
if (!version) throw new Error("usage: release-version.mjs <version>");

const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const members = new Set();
const manifests = new Map();

for (const dir of root.workspaces) {
    const file = path.join(dir, "package.json");
    const pkg = JSON.parse(await fs.readFile(file, "utf8"));
    members.add(pkg.name);
    manifests.set(file, pkg);
}

// STAMP-VIRGINITY GATE (#542): a version number is burned FOREVER once ANY family package has
// published it (npm immutability) — terraform's independent 1.0.9–1.0.11 line proved a burned
// number wears the stamp as a lie (a pre-train artifact serving under tonight's number). The stamp
// is legal only on a number NO family package has ever published; this also makes the stepchild
// sweep's serves-check trustworthy by construction (any leaf serving the stamp mid-train can only
// have gotten it FROM this train). Checks workspaces + the stepchild registry, fails loud with the
// full burned list.
{
    const reg = JSON.parse(await fs.readFile(path.join("plurnk-meta", "stepchildren.json"), "utf8"));
    const names = new Set([...members, ...reg.stepchildren.map((s) => s.name)]);
    const burned = [];
    await Promise.all([...names].map(async (name) => {
        try {
            const vs = JSON.parse((await run("npm", ["view", name, "versions", "--json"])).stdout);
            if ((Array.isArray(vs) ? vs : [vs]).includes(version)) burned.push(name);
        } catch { /* unpublished package — virgin by definition */ }
    }));
    if (burned.length > 0) throw new Error(`stamp-virginity: ${version} is BURNED on the registry by ${burned.length} package(s) — a stamp must be virgin family-wide (pick the next clean number):\n  ${burned.sort().join("\n  ")}`);
    console.log(`stamp-virginity OK — ${version} unpublished across all ${names.size} family packages`);
}

for (const [file, pkg] of manifests) {
    pkg.version = version;
    for (const field of ["dependencies", "devDependencies"]) {
        for (const name of Object.keys(pkg[field] ?? {})) {
            if (members.has(name)) pkg[field][name] = version;
        }
    }
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
        if (members.has(name)) pkg.peerDependencies[name] = `~${version}`;
    }
    await fs.writeFile(file, `${JSON.stringify(pkg, null, 4)}\n`);
}

console.log(`stamped ${manifests.size} workspaces at ${version}`);

// LOCKFILE SYNC (#550): the stamp rewrites manifests, so the committed package-lock must be
// regenerated in the same act or `npm ci` fails on committed state (the 1.0.9 train shipped every
// workspace's lock self-version a tick stale — benign only because the drill uses `npm install`).
// --package-lock-only touches no node_modules; the verification is structural, not trusted.
await run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { maxBuffer: 64 * 1024 * 1024 });
const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
const stale = root.workspaces.filter((dir) => lock.packages?.[dir]?.version !== version);
if (stale.length > 0) throw new Error(`lockfile sync failed — ${stale.length} workspace(s) still stale after regen: ${stale.join(", ")}`);
console.log(`lockfile synced — ${root.workspaces.length} workspace self-versions at ${version}`);
