// The stepchild phase of the release train (#513). Runs AFTER the monorepo publishes whole
// (release-publish's consumer-verify green) and BEFORE the announcement — because the publish law
// (owner, AGENTS §stepchildren) is that a publish means ALL lifecycle is aligned, stepchildren included.
//
// Per registry entry (plurnk-meta/stepchildren.json): repin every family head EXACT to the new stamp,
// then `npm install` (pulls the just-published head from the registry — the honest consumer surface),
// then `npm publish` (runs the repo's OWN prepublishOnly gate in its own context — a red there halts
// with the repo's real exit code, #505's lesson), then poll the registry until it serves. Same laws:
// real exits, halt-on-red naming repo + owning lane, idempotent (a stepchild already serving the stamp
// is skipped, so a resumed sweep does exactly the missing leaves). #512's adopted-in-git-never-published
// class dies here: a leaf that never adopted a head rename fails its own build/test and names itself.
//
// Usage: node scripts/release-stepchildren.mjs [--dry-run]   (dry-run: repin + install + build/test, no push/publish)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MONOREPO = resolve(HERE, "..");
const ROOT = process.env.PLURNK_STEPCHILD_ROOT ?? resolve(MONOREPO, "..");
const DRY = process.argv.includes("--dry-run");

const version = JSON.parse(await readFile(join(MONOREPO, "package.json"), "utf8")).workspaces
    ? JSON.parse(await readFile(join(MONOREPO, "plurnk-meta", "package.json"), "utf8")).version
    : null;
if (version === null) throw new Error("could not resolve the stamp version from plurnk-meta");

const registry = JSON.parse(await readFile(join(MONOREPO, "plurnk-meta", "stepchildren.json"), "utf8"));
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null; // re-run a single stepchild by dir (recovery / test)
if (only) registry.stepchildren = registry.stepchildren.filter((s) => s.dir === only);

const served = async (name) => { try { return (await run("npm", ["view", name, "version"])).stdout.trim(); } catch { return null; } };

// Rewrite every @plurnk/* dep + peerDep to the exact stamp — the honesty edit (^1 → exact).
const repinExact = async (repoDir) => {
    const pjPath = join(repoDir, "package.json");
    const p = JSON.parse(await readFile(pjPath, "utf8"));
    let changed = false;
    for (const field of ["dependencies", "peerDependencies"]) {
        for (const k of Object.keys(p[field] ?? {})) {
            if (/^@plurnk\//.test(k) && p[field][k] !== version) { p[field][k] = version; changed = true; }
        }
    }
    if (changed) await writeFile(pjPath, JSON.stringify(p, null, 4) + "\n");
    return changed;
};

console.log(`release-stepchildren: ${registry.count} stepchildren, stamp ${version}${DRY ? " [DRY RUN]" : ""}`);
let swept = 0, skipped = 0;
for (const { dir, name, lane, heads } of registry.stepchildren) {
    const repo = join(ROOT, dir);
    const tag = `${dir} (${lane})`;
    if (!existsSync(repo)) throw new Error(`${tag}: registry names a repo not on disk — census drift, regenerate`);
    if (await served(name) === version) { console.log(`  serves  ${tag}`); skipped++; continue; }

    // Clean tree first — never bundle a lane's uncommitted work blindly into a release publish.
    const dirty = (await run("git", ["-C", repo, "status", "--porcelain"])).stdout.trim();
    if (dirty !== "") throw new Error(`${tag}: uncommitted work in the stepchild tree — the lane must land or stash it before the sweep can repin+publish`);

    console.log(`  sweep   ${tag}  [${heads.join(",")}] → ${version}`);
    await repinExact(repo);
    if (existsSync(join(repo, "package-lock.json"))) await run("npm", ["install"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }); // pulls the just-published head
    if (DRY) {
        // Prove the leaf builds/tests against the real published head without shipping.
        const scripts = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).scripts ?? {};
        if (scripts.build) await run("npm", ["run", "build"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
        if (scripts.test) await run("npm", ["test"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
        console.log(`          would commit repin + push + publish ${name}@${version}`);
        swept++; continue;
    }
    await run("git", ["-C", repo, "commit", "-am", `chore(release): pin heads to ${version}`], { maxBuffer: 8 * 1024 * 1024 });
    await run("git", ["-C", repo, "push"], { maxBuffer: 8 * 1024 * 1024 });
    await run("npm", ["publish", "--access", "public"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }); // runs the repo's own prepublishOnly gate
    for (let i = 0; ; i++) { if (await served(name) === version) break; if (i >= 12) throw new Error(`${tag}: published but registry never served ${version}`); await sleep(10_000); }
    swept++;
}
console.log(`release-stepchildren GREEN: ${swept} swept, ${skipped} already served — the constellation is aligned at ${version}${DRY ? " [DRY]" : ""}`);
