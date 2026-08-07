// Align managed external packages after the monorepo publishes.
//
// Per registry entry (plurnk-meta/external-packages.json): verify compatible-major dependency ranges plus
// exact builtAgainst provenance. Compatible packages stay put; an incompatible managed package
// is realigned to the current family head, then `npm install` pulls the published head from the registry,
// then `npm publish` (runs the repo's OWN prepublishOnly gate in its own context — a red there halts
// with the repository's real exit code), then poll the registry until it serves. Same laws:
// real exits, halt-on-red naming the repository and owner, and idempotency (a package already serving the version
// is skipped, so a resumed sweep does exactly the missing leaves). A leaf that never
// adopted a head rename fails its own build/test and names itself.
//
// Usage: node scripts/release-external-packages.mjs [--check]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { caretRange, compatibleRange, exactVersion, supportsVersion } from "./release-compat.mjs";
import {
    assertNpmPublisher,
    assertReleaseRepository,
} from "./release-authority.mjs";
import { resolveExternalReposRoot } from "./project-topology.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MONOREPO = resolve(HERE, "..");
const ROOT = resolveExternalReposRoot(process.env, MONOREPO);
const CHECK = process.argv.includes("--check");
if (!CHECK) await assertNpmPublisher(MONOREPO);

const version = JSON.parse(await readFile(join(MONOREPO, "package.json"), "utf8")).workspaces
    ? JSON.parse(await readFile(join(MONOREPO, "plurnk-meta", "package.json"), "utf8")).version
    : null;
if (version === null) throw new Error("could not resolve the stamp version from plurnk-meta");

const registry = JSON.parse(await readFile(join(MONOREPO, "plurnk-meta", "external-packages.json"), "utf8"));
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
if (only) registry.packages = registry.packages.filter((entry) => entry.dir === only);

const served = async (name) => { try { return (await run("npm", ["view", name, "version"])).stdout.trim(); } catch { return null; } };
const registryContractMatches = async (p) => {
    try {
        const published = JSON.parse((await run("npm", ["view", `${p.name}@${p.version}`, "--json"])).stdout);
        return JSON.stringify(platformPins(p)) === JSON.stringify(platformPins(published))
            && p.plurnk?.builtAgainst === published.plurnk?.builtAgainst;
    } catch {
        return false;
    }
};
const platformPins = (p) => ["dependencies", "peerDependencies"].flatMap((field) =>
    Object.entries(p[field] ?? {}).filter(([name]) => /^@plurnk\//.test(name)).map(([name, range]) => ({ field, name, range })));
const contract = (p, hostVersion) => {
    const pins = platformPins(p);
    const builtAgainst = p.plurnk?.builtAgainst;
    const errors = [];
    if (pins.length > 0 && exactVersion(builtAgainst) === null) errors.push(`plurnk.builtAgainst must be an exact version (got ${JSON.stringify(builtAgainst)})`);
    for (const { field, name, range } of pins) {
        if (caretRange(range) === null) errors.push(`${field}.${name} must use ^M.m.p compatibility (got ${JSON.stringify(range)})`);
        else if (!supportsVersion(range, builtAgainst)) errors.push(`${field}.${name}@${range} excludes builtAgainst ${builtAgainst}`);
    }
    return { errors, compatible: pins.every(({ range }) => supportsVersion(range, hostVersion)) };
};

// Managed-package edit at a compatibility boundary: its own artifact takes the stamp, runtime/peer
// heads move to the new minor range, dev heads remain exact, and provenance names the tested head.
const alignManagedPackage = async (repoDir) => {
    const pjPath = join(repoDir, "package.json");
    const p = JSON.parse(await readFile(pjPath, "utf8"));
    let changed = p.version !== version;
    p.version = version;
    for (const field of ["dependencies", "peerDependencies"]) {
        for (const k of Object.keys(p[field] ?? {})) {
            const range = compatibleRange(version);
            if (/^@plurnk\//.test(k) && p[field][k] !== range) { p[field][k] = range; changed = true; }
        }
    }
    for (const k of Object.keys(p.devDependencies ?? {})) {
        if (/^@plurnk\//.test(k) && p.devDependencies[k] !== version) { p.devDependencies[k] = version; changed = true; }
    }
    p.plurnk ??= {};
    if (p.plurnk.builtAgainst !== version) { p.plurnk.builtAgainst = version; changed = true; }
    if (changed) await writeFile(pjPath, JSON.stringify(p, null, 4) + "\n");
    return changed;
};

console.log(`release-externals: ${registry.managed} managed + ${registry.independent} independent, version ${version}${CHECK ? " [CHECK]" : ""}`);
let swept = 0, guarded = 0;
for (const { dir, name, release, owner, platformDependencies, pushable } of registry.packages) {
    const repo = join(ROOT, dir);
    const tag = `${dir} (${owner ?? "unassigned"})`;
    if (!existsSync(repo)) throw new Error(`${tag}: registry names a repo not on disk — census drift, regenerate`);
    const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    if (manifest.name !== name) throw new Error(`${tag}: registry expects ${name}, checkout contains ${manifest.name}`);
    const state = contract(manifest, version);

    if (release === "independent") {
        if (state.errors.length > 0) throw new Error(`${tag}: invalid compatibility/provenance contract — ${state.errors.join("; ")}`);
        if (!state.compatible) throw new Error(`${tag}: platform dependency range excludes ${version}; the product requires its own compatible release`);
        console.log(`  guard   ${tag} [independent] — compatible with ${version}, built against ${manifest.plurnk.builtAgainst}`);
        guarded++;
        continue;
    }

    if (pushable !== true) throw new Error(`${tag}: managed release requires pushable=true in the external registry`);
    await assertReleaseRepository(repo, dir);

    // A compatible artifact survives family releases unchanged. Invalid ranges
    // and genuinely incompatible artifacts are realigned and republished;
    // provenance moves only when the artifact is rebuilt.
    if (state.errors.length === 0 && state.compatible && await registryContractMatches(manifest)) {
        console.log(`  guard   ${tag} — ${manifest.version} supports ${version}, built against ${manifest.plurnk.builtAgainst}`);
        guarded++;
        continue;
    }
    if (state.errors.length > 0) console.log(`  align   ${tag} — ${state.errors.join("; ")}`);
    else if (state.compatible) console.log(`  align   ${tag} — local compatibility/provenance is not published at ${manifest.version}`);

    // The release workflow updates an incompatible managed plugin.
    // A leaf whose registry latest exceeds the stamp has run an independent version line:
    // ran an independent version line that burned numbers ahead of the platform — align/publish cannot
    // succeed and a silent downgrade-align lies about lineage. Halt naming the leaf at the FIRST
    // window, not the third. (The serves-equality check below is trustworthy by construction: the
    // the version gate proved the number unpublished across platform packages, so a package serving
    // it now can only have gotten it from THIS train.)
    const latest = await served(name);
    if (latest !== null && latest !== version) {
        const cmp = latest.split(".").map(Number); const stamp = version.split(".").map(Number);
        const ahead = cmp[0] > stamp[0] || (cmp[0] === stamp[0] && (cmp[1] > stamp[1] || (cmp[1] === stamp[1] && cmp[2] > stamp[2])));
        if (ahead) throw new Error(`${tag}: VERSION-LINE COLLISION — registry latest ${latest} is ahead of the stamp ${version}; this managed leaf ran an independent line (the terraform class). Do not overwrite its lineage — rule the next release on the board.`);
    }
    if (latest === version) {
        throw new Error(`${tag}: ${version} is already immutable on npm with a different compatibility/provenance contract; adopt this reform at the next stamp`);
    }
    // Clean tree — never bundle a lane's uncommitted SOURCE work blindly. A dirty package-lock is NOT
    // source: it's a regenerable artifact the sweep's own `npm install` rewrites and the commit absorbs
    // (dev-env workspace-link churn dirties it across the fleet). Block real changes; ignore the lock.
    const dirty = (await run("git", ["-C", repo, "status", "--porcelain"])).stdout
        .split("\n").filter((l) => l.trim() !== "" && !/\bpackage-lock\.json$/.test(l)).join("\n");
    if (dirty !== "") throw new Error(`${tag}: uncommitted SOURCE work — the lane must land or stash it before the sweep can align+publish:\n${dirty}`);

    if (CHECK) {
        console.log(`  would align ${tag} [${platformDependencies.join(",")}] → ${version}`);
        swept++;
        continue;
    }

    console.log(`  update  ${tag}  [${platformDependencies.join(",")}] → ${version}`);
    await alignManagedPackage(repo);
    // --prefer-online: a head published moments ago is not in npm's local metadata cache yet, so a plain
    // install resolves the leaf's heads behind the stamp. Force a fresh metadata fetch so it pulls the stamp.
    // --include=peer: the monorepo .npmrc sets omit=peer, which the nested install
    // inherits via npm_config_omit and would drop the package's peer @plurnk dependencies
    // peer-depends on its engine) → empty node_modules → the leaf's prepare-build hits TS2307. Force peers in.
    await run("npm", ["install", "--prefer-online", "--include=peer"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    // Idempotent when a lane pre-commits the alignment: commit only when the
    // align/install actually changed the tree — an empty `git commit` exits 1 and would halt a
    // resume on a leaf whose lane already landed the alignment. Push is a safe no-op either way.
    const aligned = (await run("git", ["-C", repo, "status", "--porcelain"])).stdout.trim();
    if (aligned !== "") await run("git", ["-C", repo, "commit", "-am", `chore(release): align with ${version}`], { maxBuffer: 8 * 1024 * 1024 });
    await run("git", ["-C", repo, "push"], { maxBuffer: 8 * 1024 * 1024 });
    await run("npm", ["publish", "--access", "public"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }); // runs the repo's own prepublishOnly gate
    for (let i = 0; ; i++) { if (await served(name) === version) break; if (i >= 12) throw new Error(`${tag}: published but registry never served ${version}`); await sleep(10_000); }
    swept++;
}
console.log(`release-externals: ${swept} ${CHECK ? "would update" : "updated"}, ${guarded} compatible at ${version}${CHECK ? " [CHECK]" : ""}`);
