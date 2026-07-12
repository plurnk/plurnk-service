// Lockstep version stamp. Usage: node scripts/release-version.mjs <version>
// Sets every workspace to <version> and re-pins every internal @plurnk/*
// dependency and peerDependency to that exact version. The root workspaces
// array is the authoritative member list; a workspace without a package.json
// crashes the stamp.
import fs from "node:fs/promises";
import path from "node:path";

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

for (const [file, pkg] of manifests) {
    pkg.version = version;
    for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
        for (const name of Object.keys(pkg[field] ?? {})) {
            if (members.has(name)) pkg[field][name] = version;
        }
    }
    await fs.writeFile(file, `${JSON.stringify(pkg, null, 4)}\n`);
}

console.log(`stamped ${manifests.size} workspaces at ${version}`);
