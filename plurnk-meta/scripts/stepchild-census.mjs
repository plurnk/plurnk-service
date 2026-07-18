// The stepchild census (#513). Family-operated outside repos are OUTSIDE the monorepo (siblings of it)
// but the family owns their lifecycle: they must keep up with the head surface or a consumer detonates
// (#512 — xai@1.0.0 imported a shed export beside providers@1.0.7). Memory doesn't scale to 60 leaves,
// so the registry is GENERATED from disk, never hand-maintained: it cannot drift because it is derived.
// Committed for visibility (`stepchildren.json`), regenerated + diffed at release time (the models-catalog
// pattern, #424) — a drift between committed and scanned is a loud gate failure, not silent rot.
//
// Usage: node stepchild-census.mjs           # print the registry to stdout
//        node stepchild-census.mjs --write    # write stepchildren.json
//        node stepchild-census.mjs --check     # exit 1 if committed != scanned (release gate)
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const META = resolve(HERE, "..");                              // plurnk-meta
const MONOREPO = resolve(META, "..");                          // plurnk-service
const ROOT = process.env.PLURNK_STEPCHILD_ROOT ?? resolve(MONOREPO, ".."); // the constellation parent
const REGISTRY = join(META, "stepchildren.json");

const laneOf = (name) =>
    name.startsWith("plurnk-mimetypes") ? "mimetypes" :
    name.startsWith("plurnk-providers") ? "providers" :
    name.startsWith("plurnk-schemes") ? "schemes" :
    name.startsWith("plurnk-execs") ? "execs" :
    (name === "plurnk" || name === "plurnk.nvim") ? "client" :
    name === "plurnk-bench" ? "bench" :
    name === "plurnk-learn" ? "learn" :
    null; // null lane = a stepchild with no owning lane — the census flags it, the family assigns one

export const census = () => {
    const stepchildren = [];
    for (const dir of readdirSync(ROOT).sort()) {
        if (dir === "plurnk-service") continue; // the monorepo itself is not a stepchild
        const pjPath = join(ROOT, dir, "package.json");
        if (!existsSync(pjPath)) continue;
        const p = JSON.parse(readFileSync(pjPath, "utf8"));
        const heads = Object.keys({ ...p.dependencies, ...p.peerDependencies }).filter((k) => /^@plurnk\//.test(k)).sort();
        if (heads.length === 0) continue; // no family-head dependency → not a lifecycle concern
        if (p.private === true) continue;  // unpublished by construction
        stepchildren.push({ dir, name: p.name, lane: laneOf(dir), pushable: existsSync(join(ROOT, dir, ".git")), heads });
    }
    return { root: ROOT === resolve(MONOREPO, "..") ? "«monorepo parent»" : ROOT, count: stepchildren.length, stepchildren };
};

const stable = (r) => JSON.stringify(r, null, 4) + "\n";

if (import.meta.main) {
    const { values } = parseArgs({ options: { write: { type: "boolean" }, check: { type: "boolean" } } });
    const scanned = census();
    if (values.write) { writeFileSync(REGISTRY, stable(scanned)); console.log(`stepchild-census: wrote ${scanned.count} to stepchildren.json`); }
    else if (values.check) {
        const committed = existsSync(REGISTRY) ? readFileSync(REGISTRY, "utf8") : "";
        if (committed !== stable(scanned)) { console.error("stepchild-census DRIFT: committed stepchildren.json != disk scan — regenerate with --write and commit"); process.exit(1); }
        console.log(`stepchild-census OK — ${scanned.count} stepchildren, registry current`);
    } else console.log(stable(scanned));
}
