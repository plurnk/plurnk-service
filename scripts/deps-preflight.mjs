// {§release-candidate-graph} — The release freshness gate. Each stale package
// across the root and every workspace is either resolved (bump the range,
// relock, drill) or waived in deps-waivers.json with { reason, issue, lane } —
// documented, attributed debt (an open issue on the owning lane), never silence.
// The owner's `ownerVeto` list outranks any waiver: a package listed there
// blocks regardless.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run deps:check
Verifies that every external dependency across the root and workspaces resolves at registry latest unless waived in deps-waivers.json ({§release-candidate-graph}).
Reads: package.json, workspace package.json files, deps-waivers.json, npm outdated --json.
Writes: nothing (exits 1 when any unwaived or vetoed dependency is outdated).
`);

const run = promisify(execFile);

export const classify = (outdated, waivers, ownerVeto, workspaceNames) => {
    const veto = new Set(ownerVeto);
    const blockers = [];
    const excused = [];
    for (const [name, info] of Object.entries(outdated)) {
        if (workspaceNames.has(name)) continue;
        const { current, latest } = Array.isArray(info) ? info[0] : info;
        const w = waivers[name];
        const excusable = Boolean(w?.reason && w?.issue && w?.lane) && !veto.has(name);
        (excusable ? excused : blockers).push({ name, current, latest, vetoed: veto.has(name), waiver: w });
    }
    return { blockers, excused };
};

const outdated = async () => {
    try {
        const { stdout } = await run("npm", ["outdated", "--json"]);
        return JSON.parse(stdout || "{}");
    } catch (err) {
        if (!err.stdout) throw err;
        return JSON.parse(err.stdout);
    }
};

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
