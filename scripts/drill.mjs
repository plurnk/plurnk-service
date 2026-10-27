// The deterministic gate drill. Root-owned lint + unit policy runs first; applicable
// package tiers fan out across all workspaces. Intg scopes only when the pre-push hook hands
// us PLURNK_GATE_BASE. The package lifecycle policy rejects hidden synonym tiers,
// so an omitted phase is explicitly inapplicable rather than silently undiscovered.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm test   (node scripts/drill.mjs; the pre-push hook runs it on a push to main)
The deterministic gate: the platform's one build, root lint and unit, then every workspace's lint, unit and intg tiers, then client conformance. Each node --test tier emits Node's native per-file coverage table as report-only output (--experimental-test-coverage --test-coverage-include-all --test-coverage-include=<scope> must precede --test or Node silently swallows it; --test-coverage-include scopes the table and all-files roll-up to the package's own source so imported workspace dependencies do not pollute it; {§lint-gate}). Test detail is printed only when a phase goes red; no phase can fail on coverage.
Reads: PLURNK_GATE_BASE and PLURNK_GATE_HEAD from the pre-push hook, to scope intg to the changed workspaces (full on a root or framework change); the hook runs it in a throwaway worktree beside this checkout, built from the pushed commit with this checkout's node_modules copied whole (run npm install after a lockfile change).
Writes: the phase summary and per-file coverage tables to stdout; exit 1 on any red phase.
`);

// {§lint-gate} A test process's footprint, measured: a core integration file's process peaks near 420 MB.
const TEST_PROCESS_BYTES = 512 * 2 ** 20;

// {§lint-gate} The host's parallelism: its available cores, and no more test processes than its available
// memory holds at that footprint.
export const hostBudget = (cores = availableParallelism(), memory = process.availableMemory()) =>
    Math.max(1, Math.min(cores, Math.floor(memory / TEST_PROCESS_BYTES)));

// The test files a tier hands `node --test`: every `*.test.*` pattern its script names, expanded in its workspace.
export const tierFiles = async (dir, command) => {
    const files = new Set();
    for (const [, pattern] of command.matchAll(/["']?([^\s"']+\.test\.[\w*]+)["']?/gu)) {
        for await (const file of fs.glob(pattern, { cwd: dir })) files.add(file);
    }
    return files.size;
};

// {§lint-gate} Each lane's share of the budget: the largest lane's is all of it, and each other lane's is scaled
// by its test files against the largest's, at least one; the smaller lanes, done sooner, overlap the largest briefly.
export const shares = (budget, counts) => {
    const largest = Math.max(0, ...counts);
    return counts.map((count) => largest === 0 ? budget : Math.max(1, Math.round(budget * count / largest)));
};

const BUDGET = hostBudget();
const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const rootTarget = { dir: ".", name: root.name, scripts: Object.keys(root.scripts ?? {}), commands: root.scripts ?? {} };
const workspaces = [];
for (const dir of root.workspaces) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    workspaces.push({ dir, name: pkg.name, scripts: Object.keys(pkg.scripts ?? {}), commands: pkg.scripts ?? {} });
}

// The framework packages every other workspace composes. Their intg tiers cannot see
// a dependent break, and package.json points the other way (core lists the extensions it
// bundles), so a change under them runs the full tier (#642: the env family's six
// actions broke plurnk-acp's discovery witness and no scoped push ran it).
export const FULL_INTG_ON = new Set(["plurnk-core", "plurnk-contracts", "plurnk-parser"]);

// Map a changed-file list to the set of workspace dirs to run intg for. A file
// under any other workspace scopes to it; a file outside every workspace (root config,
// scripts/, .githooks/) or under a framework package can affect anything → null =
// run FULL intg.
export const scopeIntg = (files, dirs) => {
    const set = new Set(dirs);
    const changed = new Set();
    for (const file of files) {
        const top = file.split("/")[0];
        if (!set.has(top) || FULL_INTG_ON.has(top)) return null; // root or framework → full intg
        changed.add(top);
    }
    return changed;
};

const gitDiff = (base, head) => new Promise((resolve) => {
    const child = spawn("git", ["diff", "--name-only", `${base}..${head}`]);
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.once("close", (code) => resolve(code === 0 ? out.split("\n").filter(Boolean) : null));
    child.once("error", () => resolve(null));
});

// A push that changes only Markdown is covered by the root lint (markdownlint, the
// specification-reference check, the generated changelog); no integration or conformance
// lane reads it. `plurnk.md` is the exception: it is model-facing teaching that tests parse.
export const docsOnly = (files) => files.length > 0
    && files.every((file) => file.endsWith(".md") && !file.endsWith("plurnk.md"));

// The changed files of the push, or null when there is no base or the diff failed.
const changedFiles = async () => {
    const base = process.env.PLURNK_GATE_BASE;
    if (!base) return null;
    // {#642} — diff to the sha being pushed, not to HEAD: a push of a ref that is not
    // the checked-out branch would otherwise scope intg against the wrong commit.
    return gitDiff(base, process.env.PLURNK_GATE_HEAD ?? "HEAD");
};

// The workspace subset for the intg phase. null → full (no base, a diff failure,
// or a root-level change); otherwise only the changed workspaces.
const intgTargets = (files) => {
    if (files === null) return null;
    const changed = scopeIntg(files, workspaces.map((w) => w.dir));
    return changed === null ? null : workspaces.filter((w) => changed.has(w.dir));
};

// {§lint-gate} A lane runs with its share as its test runner's concurrency.
const run = (dir, script, share = BUDGET) => new Promise((resolve) => {
    const child = spawn("npm", ["run", script, "--silent"], { cwd: dir, env: { ...process.env, PLURNK_TEST_CONCURRENCY: String(share) } });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.once("close", (code) => resolve({ dir, script, code, out }));
});

const pool = async (jobs) => {
    const results = [];
    let i = 0;
    const sessions = Array.from({ length: Math.min(BUDGET, jobs.length) }, async () => {
        while (i < jobs.length) results.push(await jobs[i++]());
    });
    await Promise.all(sessions);
    return results;
};

export const partitionByScript = (subset, script) => ({
    included: subset.filter((workspace) => workspace.scripts.includes(script)),
    excluded: subset.filter((workspace) => !workspace.scripts.includes(script)),
});

export const formatPhaseSummary = ({ title, results, reds, excluded, elapsedSeconds }) => {
    const failures = reds.length === 0
        ? ""
        : `; red: ${reds.map((result) => result.dir).join(", ")}`;
    const inapplicable = excluded.length === 0
        ? ""
        : `; ${excluded.length} n/a: ${excluded.map((workspace) => workspace.dir).join(", ")}`;
    return `${title}: ${results.length - reds.length}/${results.length} green in ${elapsedSeconds}s${failures}${inapplicable}`;
};

export const coverageReport = (out) => {
    const match = /^ℹ start of coverage report[\s\S]*?^ℹ end of coverage report$/mu.exec(out);
    return match?.[0] ?? null;
};

const phase = async (title, script, subset) => {
    const started = Date.now();
    const { included, excluded } = partitionByScript(subset, script);
    // {§lint-gate} The largest lanes start first, each with its share of the host.
    const counts = await Promise.all(included.map((w) => tierFiles(w.dir, w.commands[script])));
    const share = shares(BUDGET, counts);
    const jobs = included
        .map((w, index) => ({ w, files: counts[index], share: share[index] }))
        .toSorted((left, right) => right.files - left.files)
        .map(({ w, share: lane }) => () => run(w.dir, script, lane));
    const results = await pool(jobs);
    const reds = results.filter((r) => r.code !== 0);
    console.log(formatPhaseSummary({
        title,
        results,
        reds,
        excluded,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
    }));
    for (const r of results) {
        if (r.code !== 0) continue;
        const report = coverageReport(r.out);
        if (report !== null) console.log(`\n----- coverage ${r.dir} (${r.script}) -----\n${report}`);
    }
    for (const r of reds) {
        console.log(`\n===== RED ${r.dir} (${r.script}) =====`);
        console.log(r.out);
    }
    return reds.length === 0;
};

if (import.meta.main) {
    const t0 = Date.now();
    console.log(`parallelism: ${BUDGET} (${availableParallelism()} cores, ${Math.floor(process.availableMemory() / 2 ** 20)} MiB available)`);
    // {§lint-gate} Built output is not tracked: one build of these sources comes first, since every later phase reads
    // it (the root lint type-checks against the generated grammar and model catalogs; root unit and conformance boot
    // the platform from dist), so no phase reads a build older than its sources, or none.
    if (!(await phase("build", "build", [rootTarget]))) process.exit(1);
    if (!(await phase("root", "root:lint", [rootTarget]))) process.exit(1);
    if (!(await phase("root unit", "root:unit", [rootTarget]))) process.exit(1);
    if (!(await phase("lint", "test:lint", workspaces))) process.exit(1);
    if (!(await phase("unit", "test:unit", workspaces))) process.exit(1);

    const files = await changedFiles();
    if (files !== null && docsOnly(files)) {
        console.log(`intg and conformance: skipped (${files.length} Markdown file(s) only; the root lint covers them)`);
    } else {
        const targets = intgTargets(files);
        if (targets === null) console.log(`intg: full (${process.env.PLURNK_GATE_BASE ? "root-level or framework change" : "no base"})`);
        else console.log(`intg: scoped to ${targets.length} changed workspace(s)${targets.length ? `: ${targets.map((w) => w.dir).join(", ")}` : ""}`);

        if (!(await phase("intg", "test:intg", targets ?? workspaces))) process.exit(1);
        // Sibling client conformance manifests against live discovery — a service
        // surface change fails this push (#331).
        if (!(await phase("conformance", "test:client-conformance", [rootTarget]))) process.exit(1);
    }
    // Packet Token Floor — a report, never a gate. The script always exits 0 and its output IS the
    // deliverable, so it runs outside phase() and prints directly.
    console.log((await run(rootTarget.dir, "report:floor")).out.trim());
    console.log(`drill green in ${Math.round((Date.now() - t0) / 1000)}s`);
}
