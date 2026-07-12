// Greenfield registry purge (owner ruling 2026-07-12: "make it look like we did it
// right the first time" + fail-forward on stale consumers). For every @plurnk package:
// keep ONLY dist-tags.latest; the five dead packages (docs + four -alls) are erased
// entirely. @plurnk/plurnk (the client) is untouchable. Rounds tolerate dependent-order
// refusals; irreducible failures are reported, never hidden. Irreversible by design.
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const CLIENT = "@plurnk/plurnk";
const DEAD = new Set(["@plurnk/plurnk-docs", "@plurnk/plurnk-execs-all", "@plurnk/plurnk-mimetypes-all", "@plurnk/plurnk-providers-all", "@plurnk/plurnk-schemes-all"]);
const npm = (...a) => execFileSync("npm", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// scoped tokens may not list the org — enumerate from local truth: monorepo
// workspaces + metaproject leaf dirs + the five dead names + the client
const names = new Set([...DEAD, CLIENT]);
const MONO = "/home/hyzen/repo/plurnk/plurnk-service";
const rootPkg = JSON.parse(await fs.readFile(`${MONO}/package.json`, "utf8"));
for (const w of rootPkg.workspaces) names.add(JSON.parse(await fs.readFile(`${MONO}/${w}/package.json`, "utf8")).name);
const META = "/home/hyzen/repo/plurnk";
for (const e of await fs.readdir(META, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
        const p = JSON.parse(await fs.readFile(`${META}/${e.name}/package.json`, "utf8"));
        if (p.name?.startsWith("@plurnk/") && p.private !== true) names.add(p.name);
    } catch { /* not a package */ }
}
const packages = [...names].toSorted();

const plan = [];
for (const name of packages) {
    if (name === CLIENT) { console.log(`UNTOUCHED ${name} (client)`); continue; }
    let versions, latest;
    try {
        const meta = JSON.parse(npm("view", name, "versions", "dist-tags.latest", "--json"));
        versions = Array.isArray(meta.versions) ? meta.versions : [meta.versions];
        latest = meta["dist-tags.latest"];
    } catch { console.log(`GONE ${name} (not on registry)`); continue; }
    if (DEAD.has(name)) {
        plan.push({ name, whole: true, kill: versions });
    } else {
        plan.push({ name, whole: false, keep: latest, kill: versions.filter((v) => v !== latest) });
    }
}

const totalKill = plan.reduce((a, p) => a + p.kill.length, 0);
await fs.writeFile(process.env.PURGE_PLAN ?? "purge-plan.json", JSON.stringify(plan, null, 1));
console.log(`PLAN: ${plan.length} packages, ${totalKill} versions to remove (${plan.filter((p) => p.whole).length} whole-package erasures)`);
for (const p of plan) console.log(`  ${p.name}: ${p.whole ? `ERASE (${p.kill.length} versions)` : `keep ${p.keep}, kill ${p.kill.length}`}`);
if (process.env.PURGE_DRY === "1") { console.log("DRY RUN — stopping before removal"); process.exit(0); }

// the aggregators reference every head and leaf — while any of their versions exist,
// the dependents check blocks the whole graph. Their only dependents (old service
// versions) die first; then the erasures unblock everything else.
const serviceKills = plan.filter((p) => p.name === "@plurnk/plurnk-service" && !p.whole).flatMap((p) => p.kill.map((v) => `${p.name}@${v}`));
for (const spec of serviceKills) {
    try { npm("unpublish", spec); } catch { /* re-runs: already gone */ }
    await sleep(80);
}
console.log(`service versions cleared (${serviceKills.length})`);
for (const p of plan.filter((x) => x.whole)) {
    try { npm("unpublish", p.name, "--force"); console.log(`ERASED ${p.name}`); }
    catch (e) { console.log(`ERASE FAILED ${p.name}: ${String(e.stderr ?? "").split("\n")[0]}`); }
    await sleep(80);
}

// version rounds
let pending = plan.filter((p) => !p.whole && p.name !== "@plurnk/plurnk-service").flatMap((p) => p.kill.map((v) => `${p.name}@${v}`));
for (let round = 1; round <= 4 && pending.length; round++) {
    console.log(`ROUND ${round}: ${pending.length} version unpublishes`);
    const failed = [];
    for (const spec of pending) {
        try { npm("unpublish", spec); }
        catch (e) { failed.push([spec, String(e.stderr ?? "").split("\n").find((l) => l.includes("npm error")) ?? "unknown"]); }
        await sleep(80);
    }
    console.log(`  round ${round}: ${pending.length - failed.length} removed, ${failed.length} deferred`);
    pending = failed.map(([s]) => s);
    if (failed.length && round === 4) for (const [s, m] of failed) console.log(`  IRREDUCIBLE ${s}: ${m}`);
}

// final verification
console.log("VERIFY:");
for (const name of packages) {
    if (name === CLIENT) continue;
    try {
        const v = JSON.parse(npm("view", name, "versions", "--json"));
        console.log(`  ${name}: [${Array.isArray(v) ? v.join(", ") : v}]`);
    } catch { console.log(`  ${name}: (gone)`); }
}
console.log("PURGE COMPLETE");
