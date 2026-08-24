// The single release freshness gate — the FIRST step of `release:version`, so a tree with
// ANY outdated dependency cannot be stamped (fail on any update). Each stale
// package is either resolved (bump the range, relock, drill) or waived in
// deps-waivers.json with { reason, issue, lane } — documented, attributed debt
// (an open issue on the owning lane), never silence. The waiver is the escape
// hatch and gets reached for reflexively, which is why every one is committed
// and named. Package-local `npm outdated` gates are invalid in a shared
// workspace: npm reports unrelated compatible leaves from the root tree. The
// dependency-policy gate prevents those duplicate checks from returning.
// The owner's `ownerVeto` list OUTRANKS any waiver: a package listed
// there blocks regardless — the override of the override.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);

// Pure split — testable without the network. A package `npm outdated` reports is
// a blocker unless it carries a complete waiver (reason+issue+lane) the owner
// has not vetoed. Presence in the outdated map IS the staleness; the version
// fields only feed the report.
export const classify = (outdated, waivers, ownerVeto, workspaceNames) => {
    const veto = new Set(ownerVeto);
    const blockers = [];
    const excused = [];
    for (const [name, info] of Object.entries(outdated)) {
        // Workspace platform packages are versioned by the release workflow in lockstep —
        // temporary drift while that workflow runs is not a blocker. @plurnk-scoped
        // EXTERNALS release on their own cadence and are ordinary freshness concerns
        // (#349): an own grammar package a minor behind is exactly the staleness this
        // gate exists to refuse.
        if (workspaceNames.has(name)) continue;
        const { current, latest } = Array.isArray(info) ? info[0] : info;
        const w = waivers[name];
        const excusable = Boolean(w?.reason && w?.issue && w?.lane) && !veto.has(name);
        (excusable ? excused : blockers).push({ name, current, latest, vetoed: veto.has(name), waiver: w });
    }
    return { blockers, excused };
};

// `npm outdated` exits 1 when anything is outdated — populated stdout is the
// normal path. Only an empty stdout is a genuine failure.
const outdated = async () => {
    try {
        const { stdout } = await run("npm", ["outdated", "--json", "--include-workspace-root", "-ws"]);
        return JSON.parse(stdout || "{}");
    } catch (err) {
        if (!err.stdout) throw err;
        return JSON.parse(err.stdout);
    }
};

// The lockstep-exempt set is exactly the workspace tree — read each member's
// published name (dir and name differ: plurnk-core publishes @plurnk/plurnk-service).
const workspacePackageNames = async () => {
    const { workspaces = [] } = JSON.parse(await readFile("package.json", "utf8"));
    const names = await Promise.all(workspaces.map(async (dir) =>
        JSON.parse(await readFile(`${dir}/package.json`, "utf8")).name));
    return new Set(names);
};

if (import.meta.main) {
    const { waivers = {}, ownerVeto = [] } = JSON.parse(await readFile("deps-waivers.json", "utf8"));
    const { blockers, excused } = classify(await outdated(), waivers, ownerVeto, await workspacePackageNames());

    for (const e of excused) console.log(`waived  ${e.name} ${e.current} → ${e.latest}  ${e.waiver.issue} (${e.waiver.lane})`);

    if (blockers.length > 0) {
        console.error(`deps-preflight FAILED — ${blockers.length} outdated & unwaived:`);
        for (const b of blockers) console.error(`  ${b.name} ${b.current} → ${b.latest}${b.vetoed ? "  [ownerVeto — waiver ignored]" : ""}`);
        console.error("Resolve (bump range, relock, drill) or waive in deps-waivers.json { reason, issue, lane }. ownerVeto outranks any waiver.");
        process.exit(1);
    }

    console.log(`deps-preflight OK — ${excused.length} waived, 0 blocking`);
}
