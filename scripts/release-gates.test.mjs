import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const gates = path.join(import.meta.dirname, "release-gates.mjs");

test("{§release-candidate-graph} release gates check selected packages without invoking an excluded product", async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "plurnk-selected-gates-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const json = (file, value) => writeFile(path.join(cwd, file), JSON.stringify(value));
    await mkdir(path.join(cwd, "scripts"));
    await mkdir(path.join(cwd, "bin"));
    const record = 'import { appendFileSync } from "node:fs"; appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(1)) + "\\n");';
    for (const script of ["package-build-policy", "package-provenance", "package-publint"]) {
        await writeFile(path.join(cwd, "scripts", `${script}.mjs`), record);
    }
    await json("package.json", { name: "fixture", private: true, workspaces: ["alpha", "beta", "excluded"] });
    for (const name of ["alpha", "beta", "excluded"]) {
        await mkdir(path.join(cwd, name));
        await json(`${name}/package.json`, {
            name, version: "2.0.0",
            scripts: { "release:check": name === "excluded" ? "node -e 'process.exit(19)'" : 'node -e \'require("node:fs").writeFileSync("checked", "yes")\'' },
        });
    }
    const npm = await realpath((await run("which", ["npm"])).stdout.trim());
    const shim = path.join(cwd, "bin", "npm");
    await writeFile(shim, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify(["npm", ...args]) + "\\n");
if (args[0] !== "audit") {
    const child = spawnSync(process.execPath, [${JSON.stringify(npm)}, ...args], { stdio: "inherit" });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
}
`);
    await chmod(shim, 0o755);
    const env = { ...process.env, PATH: `${path.join(cwd, "bin")}${path.delimiter}${process.env.PATH}` };
    const selected = await run(process.execPath, [gates, "--only", "alpha", "--only", "beta"], { cwd, env });
    assert.equal(await readFile(path.join(cwd, "alpha", "checked"), "utf8"), "yes");
    assert.equal(await readFile(path.join(cwd, "beta", "checked"), "utf8"), "yes");
    assert.match(selected.stdout, /2 package-specific check\(s\)/);
    const calls = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some((args) => args[0].endsWith("package-provenance.mjs") && args.includes("--pack") && args.includes("alpha") && args.includes("beta")));
    assert.ok(calls.some((args) => args[0].endsWith("package-publint.mjs") && args.includes("alpha") && args.includes("beta")));
    assert.equal(calls.some((args) => args.includes("excluded")), false);
    await assert.rejects(run(process.execPath, [gates, "--only", "missing"], { cwd, env }), /unknown workspace directory: missing/);
    await assert.rejects(run(process.execPath, [gates], { cwd, env }), /release:check/);
});
