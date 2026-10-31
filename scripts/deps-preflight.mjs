// {§release-candidate-graph} — The release and push freshness gate (#1359). Each stale package
// across the root and every workspace is either resolved (bump the range,
// relock, drill) or waived in deps-waivers.json with { reason, issue, lane } —
// documented, attributed debt (an open issue on the owning lane), never silence.
// The owner's `ownerVeto` list outranks any waiver: a package listed there
// blocks regardless. Watched protocol dependencies (`watched`) also enforce a
// verification age budget (`budgetDays`) and explicit prerelease prefix tracking
// (`trackPrefix`, e.g. `0.2.` for `@modelcontextprotocol/conformance`).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run deps:check
Verifies that every external dependency across the root and workspaces resolves at registry latest unless waived in deps-waivers.json, and that watched protocol dependencies are within their verification age budget and at their tracked latest version ({§release-candidate-graph}).
Reads: package.json, workspace package.json files, deps-waivers.json, npm outdated --json, npm view.
Writes: nothing (exits 1 when any unwaived, vetoed, or watched dependency is outdated or expired).
`);

const run = promisify(execFile);
const DAY_MS = 86_400_000;
const UNREACHABLE_RE = /network timeout|audit endpoint returned an error|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ERR_SOCKET_TIMEOUT|FETCH_ERROR|socket hang up|request to .* failed|timed out/iu;

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

export const evaluateWatchedFreshness = (watched = [], trackedLatestByPackage = {}, nowMs = Date.now()) => {
    const violations = [];
    for (const entry of watched) {
        const verifiedMs = Date.parse(`${String(entry.verifiedAt)}T00:00:00Z`);
        if (Number.isNaN(verifiedMs)) {
            violations.push(`${entry.name}: invalid verifiedAt '${String(entry.verifiedAt)}'`);
            continue;
        }
        const elapsedDays = Math.floor((nowMs - verifiedMs) / DAY_MS);
        if (elapsedDays > entry.budgetDays) {
            violations.push(
                `${entry.name}: verifiedAt ${entry.verifiedAt} is ${elapsedDays}d old (budget: ${entry.budgetDays}d) — ` +
                `inspect 'npm view ${entry.name} versions' and bump or refresh verifiedAt in deps-waivers.json`,
            );
        }
        if (typeof entry.trackPrefix === "string" && entry.trackPrefix.length > 0) {
            const trackedLatest = trackedLatestByPackage[entry.name];
            if (typeof trackedLatest === "string" && trackedLatest.length > 0 && trackedLatest !== entry.verifiedLatest) {
                violations.push(
                    `${entry.name}: resolved ${entry.resolved} trails tracked ${entry.trackPrefix}* latest ${trackedLatest}`,
                );
            }
        }
    }
    return violations;
};

const outdated = async () => {
    try {
        const { stdout } = await run("npm", ["outdated", "--json"], {
            env: { ...process.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000" },
        });
        return JSON.parse(stdout || "{}");
    } catch (err) {
        if (typeof err.stdout === "string" && err.stdout.trim().startsWith("{")) {
            return JSON.parse(err.stdout);
        }
        throw err;
    }
};

const queryTrackedLatest = async (watched = []) => {
    const entries = await Promise.all(
        watched
            .filter((entry) => typeof entry.trackPrefix === "string" && entry.trackPrefix.length > 0)
            .map(async (entry) => {
                const { stdout } = await run("npm", ["view", entry.name, "versions", "--json"], {
                    env: { ...process.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000" },
                });
                const parsed = JSON.parse(stdout.trim() || "[]");
                const versions = Array.isArray(parsed) ? parsed : [parsed];
                const matching = versions.filter((v) => typeof v === "string" && v.startsWith(entry.trackPrefix));
                return [entry.name, matching.at(-1) ?? ""];
            }),
    );
    return Object.fromEntries(entries);
};

const workspacePackageNames = async () => {
    const { workspaces = [] } = JSON.parse(await readFile("package.json", "utf8"));
    const names = await Promise.all(workspaces.map(async (dir) =>
        JSON.parse(await readFile(`${dir}/package.json`, "utf8")).name));
    return new Set(names);
};

if (import.meta.main) {
    const { waivers = {}, ownerVeto = [], watched = [] } = JSON.parse(await readFile("deps-waivers.json", "utf8"));
    const workspaces = await workspacePackageNames();

    const ageViolations = evaluateWatchedFreshness(watched, {}, Date.now());
    if (ageViolations.length > 0) {
        console.error(`deps-preflight FAILED — ${ageViolations.length} watched dependency verification budget violation(s):`);
        for (const v of ageViolations) console.error(`  ${v}`);
        process.exit(1);
    }

    let outdatedReport;
    let trackedLatestByPackage = {};
    try {
        [outdatedReport, trackedLatestByPackage] = await Promise.all([
            outdated(),
            queryTrackedLatest(watched),
        ]);
    } catch (cause) {
        const text = `${cause?.stdout ?? ""}\n${cause?.stderr ?? ""}\n${cause?.message ?? ""}`;
        if (!UNREACHABLE_RE.test(text)) throw cause;
        console.warn(`deps-preflight: registry UNREACHABLE — continuing offline (#1359).\n${text.trim().slice(0, 300)}`);
        process.exit(0);
    }

    const trackedViolations = evaluateWatchedFreshness(watched, trackedLatestByPackage, Date.now());
    const { blockers, excused } = classify(outdatedReport, waivers, ownerVeto, workspaces);

    for (const e of excused) console.log(`waived  ${e.name} ${e.current} → ${e.latest}  ${e.waiver.issue} (${e.waiver.lane})`);

    if (blockers.length > 0 || trackedViolations.length > 0) {
        console.error(`deps-preflight FAILED — ${blockers.length + trackedViolations.length} outdated & unwaived:`);
        for (const b of blockers) console.error(`  ${b.name} ${b.current} → ${b.latest}${b.vetoed ? "  [ownerVeto — waiver ignored]" : ""}`);
        for (const v of trackedViolations) console.error(`  ${v}`);
        console.error("Resolve (bump range, relock, drill) or waive in deps-waivers.json { reason, issue, lane }. ownerVeto outranks any waiver.");
        process.exit(1);
    }

    if (workspaces.has("@plurnk/plurnk-mimetypes")) {
        try {
            const { stdout } = await run(process.execPath, ["--conditions=plurnk-dev", "plurnk-mimetypes/scripts/deps-check.mjs", "--only", "pins"]);
            process.stdout.write(stdout);
        } catch (err) {
            if (err.stdout) process.stdout.write(err.stdout);
            if (err.stderr) process.stderr.write(err.stderr);
            process.exit(1);
        }
    }

    console.log(`deps-preflight OK — ${watched.length} watched, ${excused.length} waived, 0 blocking`);
}
