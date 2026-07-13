// The gate drill, parallelized (AGENTS one-gate). Same tiers, same coverage, same
// fail-hard — lint and unit fan out across workspaces (they are independent), intg
// follows once both are green. Every red's full output is printed; any red fails.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const LIMIT = 8;
const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const workspaces = [];
for (const dir of root.workspaces) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    workspaces.push({ dir, name: pkg.name, scripts: Object.keys(pkg.scripts ?? {}) });
}

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

const phase = async (title, script) => {
    const started = Date.now();
    const jobs = workspaces
        .filter((w) => w.scripts.includes(script))
        .map((w) => () => run(w.dir, script));
    const results = await pool(jobs);
    const reds = results.filter((r) => r.code !== 0);
    console.log(`${title}: ${results.length - reds.length}/${results.length} green in ${Math.round((Date.now() - started) / 1000)}s`);
    for (const r of reds) {
        console.log(`\n===== RED ${r.dir} (${r.script}) =====`);
        console.log(r.out);
    }
    return reds.length === 0;
};

const t0 = Date.now();
if (!(await phase("lint", "test:lint"))) process.exit(1);
if (!(await phase("unit", "test:unit"))) process.exit(1);
if (!(await phase("intg", "test:intg"))) process.exit(1);
console.log(`drill green in ${Math.round((Date.now() - t0) / 1000)}s`);
