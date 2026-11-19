// {§release-candidate-graph} — Hermetic dependency ledger check (`--offline`, `npm run deps:check`)
// and live registry/upstream drift gate (`npm run deps:drift`, #1359). Each stale package across
// the root and every workspace is either resolved (bump the range, relock, drill) or waived in
// deps-waivers.json with { reason, issue, lane } — documented, attributed debt (an open issue on
// the owning lane), never silence. The owner's `ownerVeto` list outranks any waiver: a package
// listed there blocks regardless. Watched protocol dependencies (`watched`) also enforce a
// verification age budget (`budgetDays`), manifest/lockfile alignment, and explicit prerelease
// prefix tracking (`trackPrefix`, e.g. `0.2.` for `@modelcontextprotocol/conformance`).
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run deps:check   (node scripts/deps-preflight.mjs --offline)
       npm run deps:drift   (node scripts/deps-preflight.mjs)
Verifies watched dependency verification age budgets, deps-waivers.json schema/expiry/ownerVeto rules, and local manifest/lockfile invariants (--offline); without --offline, also verifies every external dependency across the root and workspaces against live npm registry and upstream git release metadata ({§release-candidate-graph}).
Reads: package.json, workspace package.json files, package-lock.json, deps-waivers.json; without --offline, also npm outdated --json, npm view, and plurnk-mimetypes/scripts/deps-check.mjs.
Writes: nothing (exits 1 on any local policy violation or unwaived/vetoed/watched drift).
`);

const run = promisify(execFile);
const DAY_MS = 86_400_000;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const UNREACHABLE_RE = /network timeout|audit endpoint returned an error|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ERR_SOCKET_TIMEOUT|FETCH_ERROR|socket hang up|request to .* failed|timed out/iu;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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

export const evaluateLocalPolicy = ({
    policy,
    rootManifest,
    workspaceManifests = [],
    lockfile = null,
    nowMs = Date.now(),
}) => {
    const violations = [];
    if (!isRecord(policy)) {
        return ["deps-waivers.json: root value must be a JSON object"];
    }
    const rawWaivers = policy.waivers ?? {};
    const rawOwnerVeto = policy.ownerVeto ?? [];
    const rawWatchedFamilies = policy.watchedFamilies ?? [];
    const hasWatched = policy.watched !== undefined;
    const rawWatched = policy.watched ?? [];

    if (!isRecord(rawWaivers)) {
        violations.push("deps-waivers.json: waivers must be an object");
    }
    if (!Array.isArray(rawOwnerVeto) || rawOwnerVeto.some((name) => typeof name !== "string" || name.trim().length === 0)) {
        violations.push("deps-waivers.json: ownerVeto must be an array of non-empty package names");
    }
    if (!Array.isArray(rawWatchedFamilies) || rawWatchedFamilies.some((prefix) => typeof prefix !== "string" || prefix.trim().length === 0)) {
        violations.push("deps-waivers.json: watchedFamilies must be an array of non-empty package prefixes");
    }
    if (!Array.isArray(rawWatched)) {
        violations.push("deps-waivers.json: watched must be an array when present");
    }

    const waivers = isRecord(rawWaivers) ? rawWaivers : {};
    const vetoList = Array.isArray(rawOwnerVeto) ? rawOwnerVeto.filter((name) => typeof name === "string") : [];
    const veto = new Set(vetoList);
    const watchedFamilies = Array.isArray(rawWatchedFamilies) ? rawWatchedFamilies.filter((p) => typeof p === "string") : [];
    const watched = Array.isArray(rawWatched) ? rawWatched : [];
    const workspaceNames = new Set(workspaceManifests.map(({ manifest }) => manifest?.name).filter(Boolean));
    const byDir = new Map(workspaceManifests.map(({ dir, manifest }) => [dir, manifest]));

    for (const [name, waiver] of Object.entries(waivers)) {
        if (workspaceNames.has(name)) {
            violations.push(`deps-waivers.json: workspace package ${name} cannot carry an external waiver`);
        }
        if (veto.has(name)) {
            violations.push(`deps-waivers.json: ${name} is listed in ownerVeto and cannot be waived`);
        }
        if (
            !isRecord(waiver)
            || typeof waiver.reason !== "string" || waiver.reason.trim().length === 0
            || typeof waiver.issue !== "string" || waiver.issue.trim().length === 0
            || typeof waiver.lane !== "string" || waiver.lane.trim().length === 0
        ) {
            violations.push(`deps-waivers.json: waiver for ${name} requires non-empty { reason, issue, lane }`);
            continue;
        }
        if (waiver.expiresAt !== undefined) {
            const expiresStr = String(waiver.expiresAt);
            const expiresMs = DATE_RE.test(expiresStr) ? Date.parse(`${expiresStr}T23:59:59.999Z`) : Number.NaN;
            if (Number.isNaN(expiresMs)) {
                violations.push(`deps-waivers.json: waiver for ${name} has invalid expiresAt '${expiresStr}' (expected YYYY-MM-DD)`);
            } else if (nowMs > expiresMs) {
                violations.push(`deps-waivers.json: waiver for ${name} expired on ${expiresStr}`);
            }
        }
    }

    violations.push(...evaluateWatchedFreshness(watched, {}, nowMs));

    if (hasWatched && watched.length === 0) {
        violations.push("deps-waivers.json: watched list must not be empty");
    }

    const watchedByName = new Map();
    for (const entry of watched) {
        const { name, workspaces = [], requirement, resolved, verifiedLatest, verifiedAt, budgetDays, why } = entry ?? {};
        if (typeof name !== "string" || name.length === 0) {
            violations.push("deps-waivers.json: watched entry is missing a package name");
            continue;
        }
        watchedByName.set(name, entry);
        if (!Object.hasOwn(waivers, name) && !veto.has(name)) {
            violations.push(`deps-waivers.json: unwaived watched dependency ${name} must be listed in ownerVeto`);
        }
        if (typeof why !== "string" || why.trim().length === 0) {
            violations.push(`deps-waivers.json: ${name} is missing a non-empty 'why' rationale`);
        }
        if (!SEMVER_RE.test(String(resolved))) {
            violations.push(`deps-waivers.json: ${name}.resolved '${String(resolved)}' is not an exact semver`);
        }
        if (!SEMVER_RE.test(String(verifiedLatest))) {
            violations.push(`deps-waivers.json: ${name}.verifiedLatest '${String(verifiedLatest)}' is not an exact semver`);
        }
        if (resolved !== verifiedLatest) {
            violations.push(`deps-waivers.json: ${name}.resolved (${String(resolved)}) does not match verifiedLatest (${String(verifiedLatest)})`);
        }
        if (!DATE_RE.test(String(verifiedAt)) || Number.isNaN(Date.parse(`${String(verifiedAt)}T00:00:00Z`))) {
            violations.push(`deps-waivers.json: ${name}.verifiedAt '${String(verifiedAt)}' must be YYYY-MM-DD`);
        }
        if (!Number.isSafeInteger(budgetDays) || budgetDays <= 0 || budgetDays > 30) {
            violations.push(`deps-waivers.json: ${name}.budgetDays must be an integer in 1..30`);
        }
        if (!Array.isArray(workspaces) || workspaces.length === 0) {
            violations.push(`deps-waivers.json: ${name}.workspaces must list at least one workspace`);
        }
        const expectedSpec = requirement === "exact"
            ? String(resolved)
            : requirement === "caret"
                ? `^${String(resolved)}`
                : null;
        if (expectedSpec === null) {
            violations.push(`deps-waivers.json: ${name}.requirement '${String(requirement)}' must be 'exact' or 'caret'`);
        } else if (Array.isArray(workspaces)) {
            for (const dir of workspaces) {
                const manifest = byDir.get(dir);
                if (!manifest) {
                    violations.push(`deps-waivers.json: ${name} names unknown workspace '${String(dir)}'`);
                    continue;
                }
                const specs = DEP_SECTIONS
                    .map((section) => manifest[section]?.[name])
                    .filter((spec) => spec !== undefined);
                if (specs.length === 0) {
                    violations.push(`${String(dir)}/package.json: missing watched dependency ${name}`);
                } else if (specs[0] !== expectedSpec) {
                    violations.push(`${String(dir)}/package.json: ${name} requires '${expectedSpec}', found '${String(specs[0])}'`);
                }
            }
        }
        const lockEntry = lockfile?.packages?.[`node_modules/${name}`];
        if (!lockEntry || typeof lockEntry.version !== "string") {
            violations.push(`package-lock.json: missing node_modules/${name} resolution`);
        } else if (lockEntry.version !== resolved) {
            violations.push(`package-lock.json: node_modules/${name} resolves to '${lockEntry.version}', expected '${String(resolved)}' from deps-waivers.json`);
        }
    }

    for (const { dir, manifest } of workspaceManifests) {
        for (const section of DEP_SECTIONS) {
            for (const name of Object.keys(manifest?.[section] ?? {})) {
                if (!watchedFamilies.some((prefix) => name.startsWith(prefix))) continue;
                const entry = watchedByName.get(name);
                if (!entry) {
                    violations.push(`${dir}/package.json: ${section}.${name} belongs to watched family (${watchedFamilies.join(", ")}) and must be listed in deps-waivers.json`);
                } else if (!Array.isArray(entry.workspaces) || !entry.workspaces.includes(dir)) {
                    violations.push(`${dir}/package.json: ${section}.${name} is declared in ${dir} but deps-waivers.json does not list '${dir}' in ${name}.workspaces`);
                }
            }
        }
    }

    if (lockfile !== null) {
        const manifestsToCheck = [
            ...(rootManifest ? [{ dir: ".", file: "package.json", manifest: rootManifest }] : []),
            ...workspaceManifests.map(({ dir, manifest }) => ({ dir, file: `${dir}/package.json`, manifest })),
        ];
        for (const { dir, file, manifest } of manifestsToCheck) {
            if (dir !== "." && !lockfile.packages?.[dir]) {
                violations.push(`package-lock.json: missing workspace entry '${dir}'`);
            }
            for (const section of DEP_SECTIONS) {
                for (const name of Object.keys(manifest?.[section] ?? {})) {
                    if (workspaceNames.has(name)) continue;
                    const resolvedEntry = (dir !== "." ? lockfile.packages?.[`${dir}/node_modules/${name}`] : undefined)
                        ?? lockfile.packages?.[`node_modules/${name}`];
                    if (!resolvedEntry || typeof resolvedEntry.version !== "string" || resolvedEntry.version.length === 0) {
                        violations.push(`package-lock.json: missing resolution for ${file} ${section}.${name}`);
                    }
                }
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

const loadWorkspaceState = async () => {
    const rootManifest = JSON.parse(await readFile("package.json", "utf8"));
    const workspaceDirs = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
    const workspaceManifests = await Promise.all(workspaceDirs.map(async (dir) => ({
        dir,
        manifest: JSON.parse(await readFile(`${dir}/package.json`, "utf8")),
    })));
    const lockfile = await readFile("package-lock.json", "utf8")
        .then((raw) => JSON.parse(raw))
        .catch((error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
        });
    return {
        rootManifest,
        workspaceManifests,
        workspaces: new Set(workspaceManifests.map(({ manifest }) => manifest.name)),
        lockfile,
    };
};

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            offline: { type: "boolean", default: false },
        },
        strict: true,
    });
    const policy = JSON.parse(await readFile("deps-waivers.json", "utf8"));
    const { waivers = {}, ownerVeto = [], watched = [] } = policy;
    const { rootManifest, workspaceManifests, workspaces, lockfile } = await loadWorkspaceState();

    const localViolations = evaluateLocalPolicy({
        policy,
        rootManifest,
        workspaceManifests,
        lockfile,
        nowMs: Date.now(),
    });
    if (localViolations.length > 0) {
        console.error(`deps-preflight FAILED — ${localViolations.length} local dependency policy violation(s):`);
        for (const v of localViolations) console.error(`  ${v}`);
        process.exit(1);
    }

    if (values.offline) {
        console.log(`deps-preflight OK (offline) — ${watched.length} watched, ${Object.keys(waivers).length} waived, 0 local violations`);
        process.exit(0);
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
