// The stepchild phase of the release train (#513). Runs AFTER the monorepo publishes whole
// (release-publish's consumer-verify green) and BEFORE the announcement — because the publish law
// (owner, AGENTS §stepchildren) is that a publish means ALL lifecycle is aligned, stepchildren included.
//
// Per registry entry (plurnk-meta/stepchildren.json): verify current-minor compatibility plus exact
// builtAgainst provenance. Compatible leaves stay put across patches; an incompatible stepdaughter
// is realigned to the new minor, then `npm install` pulls the published head from the registry,
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
const ROOT = process.env.PLURNK_STEPCHILD_ROOT ?? resolve(MONOREPO, "..", "repo");
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
const registryContractMatches = async (p) => {
    try {
        const published = JSON.parse((await run("npm", ["view", `${p.name}@${p.version}`, "--json"])).stdout);
        return JSON.stringify(familyPins(p)) === JSON.stringify(familyPins(published))
            && p.plurnk?.builtAgainst === published.plurnk?.builtAgainst;
    } catch {
        return false;
    }
};
const exact = (value) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
const tilde = (value) => /^~(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
const includes = (range, candidate) => {
    const r = tilde(range); const v = exact(candidate);
    return r !== null && v !== null && r[1] === v[1] && r[2] === v[2] && Number(v[3]) >= Number(r[3]);
};
const familyPins = (p) => ["dependencies", "peerDependencies"].flatMap((field) =>
    Object.entries(p[field] ?? {}).filter(([name]) => /^@plurnk\//.test(name)).map(([name, range]) => ({ field, name, range })));
const contract = (p, hostVersion) => {
    const pins = familyPins(p);
    const builtAgainst = p.plurnk?.builtAgainst;
    const errors = [];
    if (pins.length > 0 && exact(builtAgainst) === null) errors.push(`plurnk.builtAgainst must be an exact version (got ${JSON.stringify(builtAgainst)})`);
    for (const { field, name, range } of pins) {
        if (tilde(range) === null) errors.push(`${field}.${name} must use ~M.m.p compatibility (got ${JSON.stringify(range)})`);
        else if (!includes(range, builtAgainst)) errors.push(`${field}.${name}@${range} excludes builtAgainst ${builtAgainst}`);
    }
    return { errors, compatible: pins.every(({ range }) => includes(range, hostVersion)) };
};

// STEPDAUGHTER edit at a compatibility boundary: its own artifact takes the stamp, runtime/peer
// heads move to the new minor range, dev heads remain exact, and provenance names the tested head.
const alignStepdaughter = async (repoDir) => {
    const pjPath = join(repoDir, "package.json");
    const p = JSON.parse(await readFile(pjPath, "utf8"));
    let changed = p.version !== version;
    p.version = version;
    for (const field of ["dependencies", "peerDependencies"]) {
        for (const k of Object.keys(p[field] ?? {})) {
            if (/^@plurnk\//.test(k) && p[field][k] !== `~${version}`) { p[field][k] = `~${version}`; changed = true; }
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

console.log(`release-stepchildren: ${registry.stepdaughters} stepdaughters + ${registry.nieces} nieces, stamp ${version}${DRY ? " [DRY RUN]" : ""}`);
let swept = 0, guarded = 0;
for (const { dir, name, kind, lane, heads } of registry.stepchildren) {
    const repo = join(ROOT, dir);
    const tag = `${dir} (${lane})`;
    if (!existsSync(repo)) throw new Error(`${tag}: registry names a repo not on disk — census drift, regenerate`);
    const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    const state = contract(manifest, version);
    if (state.errors.length > 0) throw new Error(`${tag}: invalid compatibility/provenance contract — ${state.errors.join("; ")}`);

    if (kind === "niece") {
        if (!state.compatible) throw new Error(`${tag} [niece]: family-head range excludes platform ${version}; its lane must release a compatible artifact`);
        console.log(`  guard   ${tag} [niece] — compatible with ${version}, built against ${manifest.plurnk.builtAgainst}`);
        guarded++;
        continue;
    }

    // STEPDAUGHTER: a compatible artifact survives patch stamps unchanged. Crossing its minor
    // window realigns and republishes it; provenance moves only when the artifact is rebuilt.
    if (state.compatible && await registryContractMatches(manifest)) {
        console.log(`  guard   ${tag} — ${manifest.version} supports ${version}, built against ${manifest.plurnk.builtAgainst}`);
        guarded++;
        continue;
    }
    if (state.compatible) console.log(`  align   ${tag} — local compatibility/provenance is not published at ${manifest.version}`);

    // Incompatible stepdaughter: passive substrate, machine owns the boundary release.
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
    if (latest === version) {
        throw new Error(`${tag}: ${version} is already immutable on npm with a different compatibility/provenance contract; adopt this reform at the next stamp`);
    }
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
    // --include=peer: the monorepo .npmrc sets omit=peer (right for the workspace root), which the sweep's
    // nested install inherits via npm_config_omit and would drop a stepchild's peer @plurnk heads (a plugin
    // peer-depends on its engine) → empty node_modules → the leaf's prepare-build hits TS2307. Force peers in.
    await run("npm", ["install", "--prefer-online", "--include=peer"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
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
console.log(`release-stepchildren GREEN: ${swept} swept, ${guarded} compatible — the constellation is aligned at ${version}${DRY ? " [DRY]" : ""}`);
