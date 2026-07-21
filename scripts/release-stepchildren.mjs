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

// STEPDAUGHTER edit: lockstep the leaf's OWN version to the stamp AND repin every @plurnk head exact.
// A stepdaughter's version IS the head it tracks (self-documenting: mimetypes-grammar-rust@1.0.8 pins
// mimetypes@1.0.8). Only rewrites when something differs — idempotent.
const alignStepdaughter = async (repoDir) => {
    const pjPath = join(repoDir, "package.json");
    const p = JSON.parse(await readFile(pjPath, "utf8"));
    let changed = p.version !== version;
    p.version = version;
    // devDependencies included — a leaf's gate installs its devDeps and runs `npm outdated`; a stale
    // `^1` devDep head resolves behind the just-published stamp and fails the freshness check (#513 maiden).
    for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
        for (const k of Object.keys(p[field] ?? {})) {
            if (/^@plurnk\//.test(k) && p[field][k] !== version) { p[field][k] = version; changed = true; }
        }
    }
    if (changed) await writeFile(pjPath, JSON.stringify(p, null, 4) + "\n");
    return changed;
};

// NIECE guard: a niece is lane-released with its own version — the machine NEVER republishes it. It only
// enforces the honesty rule: every @plurnk head-pin must be EXACT (a range is the #512 lie). An old-but-
// exact pin is fine (the niece works against that head; its lane bumps the pin when it ships). Returns the
// list of dishonest (ranged) head-pins, empty if clean.
const nieceRangedPins = async (repoDir) => {
    const p = JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"));
    const bad = [];
    for (const field of ["dependencies", "peerDependencies"]) {
        for (const [k, v] of Object.entries(p[field] ?? {})) {
            if (/^@plurnk\//.test(k) && /[\^~*x><|\s-]|\.\*/.test(v)) bad.push(`${k}@${v}`);
        }
    }
    return bad;
};

console.log(`release-stepchildren: ${registry.stepdaughters} stepdaughters + ${registry.nieces} nieces, stamp ${version}${DRY ? " [DRY RUN]" : ""}`);
let swept = 0, skipped = 0, guarded = 0;
for (const { dir, name, kind, lane, heads } of registry.stepchildren) {
    const repo = join(ROOT, dir);
    const tag = `${dir} (${lane})`;
    if (!existsSync(repo)) throw new Error(`${tag}: registry names a repo not on disk — census drift, regenerate`);

    if (kind === "niece") {
        // A niece is lane-released with its own version — the machine only guards pin honesty, never republishes.
        const bad = await nieceRangedPins(repo);
        if (bad.length > 0) throw new Error(`${tag} [niece]: dishonest head-pin(s) ${bad.join(", ")} — a range on a fail-forward head is the #512 lie; the lane must pin exact (an old-but-exact pin is fine)`);
        console.log(`  guard   ${tag} [niece] — pins exact, lane-released`);
        guarded++;
        continue;
    }

    // STEPDAUGHTER: passive substrate, machine owns the version — lockstep to the stamp, republish.
    // COLLISION DETECTOR (#542, the terraform lesson): a leaf whose registry LATEST exceeds the stamp
    // ran an independent version line that burned numbers ahead of the family — align/publish cannot
    // succeed and a silent downgrade-align lies about lineage. Halt naming the leaf at the FIRST
    // window, not the third. (The serves-equality check below is trustworthy by construction: the
    // stamp-virginity gate proved the number unpublished family-wide at stamp time, so a leaf serving
    // it now can only have gotten it from THIS train.)
    const latest = await served(name);
    if (latest !== null && latest !== version) {
        const cmp = latest.split(".").map(Number); const stamp = version.split(".").map(Number);
        const ahead = cmp[0] > stamp[0] || (cmp[0] === stamp[0] && (cmp[1] > stamp[1] || (cmp[1] === stamp[1] && cmp[2] > stamp[2])));
        if (ahead) throw new Error(`${tag}: VERSION-LINE COLLISION — registry latest ${latest} is ahead of the stamp ${version}; this leaf ran an independent line (the terraform class). It cannot wear this stamp; it rejoins lockstep at the next stamp past ${latest}. Do not align, do not publish — rule it on the board.`);
    }
    if (latest === version) { console.log(`  serves  ${tag}`); skipped++; continue; }
    // Clean tree — never bundle a lane's uncommitted SOURCE work blindly. A dirty package-lock is NOT
    // source: it's a regenerable artifact the sweep's own `npm install` rewrites and the commit absorbs
    // (dev-env workspace-link churn dirties it across the fleet). Block real changes; ignore the lock.
    const dirty = (await run("git", ["-C", repo, "status", "--porcelain"])).stdout
        .split("\n").filter((l) => l.trim() !== "" && !/\bpackage-lock\.json$/.test(l)).join("\n");
    if (dirty !== "") throw new Error(`${tag}: uncommitted SOURCE work — the lane must land or stash it before the sweep can align+publish:\n${dirty}`);

    console.log(`  sweep   ${tag}  [${heads.join(",")}] → ${version}`);
    await alignStepdaughter(repo);
    // --prefer-online: a head published moments ago is not in npm's local metadata cache yet, so a plain
    // install resolves the leaf's heads behind the stamp. Force a fresh metadata fetch so it pulls the stamp.
    // --ignore-scripts: a leaf with `prepare: npm run build` otherwise builds DURING install, racing npm's
    // extraction of the just-published heads (the build fires before the head's dist/ lands → TS2307, flaky).
    // The leaf's own build belongs at publish/prepublishOnly (dry: the explicit build below), where the heads
    // are guaranteed present. `npm rebuild` restores dep native builds (tree-sitter node-gyp) --ignore-scripts skipped.
    await run("npm", ["install", "--prefer-online", "--ignore-scripts"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    await run("npm", ["rebuild"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    if (DRY) {
        const scripts = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).scripts ?? {};
        if (scripts.build) await run("npm", ["run", "build"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
        if (scripts.test) await run("npm", ["test"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
        console.log(`          would commit align + push + publish ${name}@${version}`);
        swept++; continue;
    }
    // Idempotent against a lane pre-committing the alignment (#541 resume): commit only when the
    // align/install actually changed the tree — an empty `git commit` exits 1 and would halt a
    // resume on a leaf whose lane already landed the lockstep. Push is a safe no-op either way.
    const aligned = (await run("git", ["-C", repo, "status", "--porcelain"])).stdout.trim();
    if (aligned !== "") await run("git", ["-C", repo, "commit", "-am", `chore(release): lockstep ${version}`], { maxBuffer: 8 * 1024 * 1024 });
    await run("git", ["-C", repo, "push"], { maxBuffer: 8 * 1024 * 1024 });
    await run("npm", ["publish", "--access", "public"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }); // runs the repo's own prepublishOnly gate
    for (let i = 0; ; i++) { if (await served(name) === version) break; if (i >= 12) throw new Error(`${tag}: published but registry never served ${version}`); await sleep(10_000); }
    swept++;
}
console.log(`release-stepchildren GREEN: ${swept} swept, ${skipped} already served, ${guarded} nieces pin-verified — the constellation is aligned at ${version}${DRY ? " [DRY]" : ""}`);
