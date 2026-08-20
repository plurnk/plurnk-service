// The deterministic gate drill. Applicable lint + unit tiers fan out across all
// workspaces; intg scopes to changed workspaces only when the pre-push hook hands
// us PLURNK_GATE_BASE. The package lifecycle policy rejects hidden synonym tiers,
// so an omitted phase is explicitly inapplicable rather than silently undiscovered.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const LIMIT = 8;
const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const rootTarget = { dir: ".", name: root.name, scripts: Object.keys(root.scripts ?? {}) };
const workspaces = [];
for (const dir of root.workspaces) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    workspaces.push({ dir, name: pkg.name, scripts: Object.keys(pkg.scripts ?? {}) });
}

// Map a changed-file list to the set of workspace dirs to run intg for. A file
// under a workspace scopes to it; a file outside every workspace (root config,
// scripts/, .githooks/) can affect anything → null = run FULL intg.
export const scopeIntg = (files, dirs) => {
    const set = new Set(dirs);
    const changed = new Set();
    for (const file of files) {
        const top = file.split("/")[0];
        if (!set.has(top)) return null; // root-level change → full intg
        changed.add(top);
    }
    return changed;
};

const gitDiff = (base) => new Promise((resolve) => {
    const child = spawn("git", ["diff", "--name-only", `${base}..HEAD`]);
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.once("close", (code) => resolve(code === 0 ? out.split("\n").filter(Boolean) : null));
    child.once("error", () => resolve(null));
});

// The workspace subset for the intg phase. null → full (no base, a diff failure,
// or a root-level change); otherwise only the changed workspaces.
const intgTargets = async () => {
    const base = process.env.PLURNK_GATE_BASE;
    if (!base) return null;
    const files = await gitDiff(base);
    if (files === null) return null;
    const changed = scopeIntg(files, workspaces.map((w) => w.dir));
    return changed === null ? null : workspaces.filter((w) => changed.has(w.dir));
};

const run = (dir, script) => new Promise((resolve) => {
    const child = spawn("npm", ["run", script, "--silent"], { cwd: dir, env: process.env });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.once("close", (code) => resolve({ dir, script, code, out }));
});

const pool = async (jobs) => {
    const results = [];
    let i = 0;
    const workers = Array.from({ length: Math.min(LIMIT, jobs.length) }, async () => {
        while (i < jobs.length) results.push(await jobs[i++]());
    });
    await Promise.all(workers);
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

const phase = async (title, script, subset) => {
    const started = Date.now();
    const { included, excluded } = partitionByScript(subset, script);
    const jobs = included
        .map((w) => () => run(w.dir, script));
    const results = await pool(jobs);
    const reds = results.filter((r) => r.code !== 0);
    console.log(formatPhaseSummary({
        title,
        results,
        reds,
        excluded,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
    }));
    for (const r of reds) {
        console.log(`\n===== RED ${r.dir} (${r.script}) =====`);
        console.log(r.out);
    }
    return reds.length === 0;
};

if (import.meta.main) {
    const t0 = Date.now();
    if (!(await phase("root", "root:lint", [rootTarget]))) process.exit(1);
    if (!(await phase("lint", "test:lint", workspaces))) process.exit(1);
    if (!(await phase("unit", "test:unit", workspaces))) process.exit(1);

    const targets = await intgTargets();
    if (targets === null) console.log(`intg: full (${process.env.PLURNK_GATE_BASE ? "root-level change" : "no base"})`);
    else console.log(`intg: scoped to ${targets.length} changed workspace(s)${targets.length ? `: ${targets.map((w) => w.dir).join(", ")}` : ""}`);

    if (!(await phase("intg", "test:intg", targets ?? workspaces))) process.exit(1);
    console.log(`drill green in ${Math.round((Date.now() - t0) / 1000)}s`);
}
