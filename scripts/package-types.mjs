import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run packages:types [-- --only <workspace-dir>]...
Checks that every package's exported types resolve from a consumer's view ({§type-resolution-audit}).
Reads: every workspace's package.json exports.
Writes: findings to stdout; exit 1 on any.
`);

// Exported documents are resolvable assets, not type-importable code modules.
const excludedEntrypoints = {
    "@plurnk/plurnk-meta": ["./POLICY.md", "./recap.md"],
};

const binDir = path.resolve(import.meta.dirname, "../node_modules/.bin");

const runChecker = (command, args, cwd) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
        cwd,
        stdio: "inherit",
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
});

export const checkPackageTypes = async (root, { only, run = runChecker, report = console.log } = {}) => {
    const { workspaces } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const selected = only === undefined
        ? workspaces
        : [...new Set(Array.isArray(only) ? only : [only])];
    for (const directory of selected) {
        if (!workspaces.includes(directory)) throw new Error(`Unknown workspace: ${directory}`);
    }
    const failures = [];
    let checked = 0;
    for (const directory of selected) {
        const manifest = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));
        if (manifest.private === true) continue;
        const exclusions = excludedEntrypoints[manifest.name] ?? [];
        report(`ATTW ${directory}: esm-only${exclusions.length === 0 ? "" : `; file assets excluded: ${exclusions.join(", ")}`}`);
        const { code, signal } = await run("attw", [
            "--pack", directory,
            "--profile", "esm-only", "--format", "table", "--no-color",
            ...(exclusions.length === 0 ? [] : ["--exclude-entrypoints", ...exclusions]),
        ], root);
        checked++;
        if (code !== 0) failures.push(`${directory}: ${signal === null ? `exit ${code}` : `signal ${signal}`}`);
    }
    if (checked === 0) throw new Error("No public package selected");
    if (failures.length > 0) throw new Error(`ATTW failed for ${failures.length} package(s):\n${failures.join("\n")}`);
    return checked;
};

if (import.meta.main) {
    const { values } = parseArgs({ options: { only: { type: "string", multiple: true } } });
    const count = await checkPackageTypes(path.resolve(import.meta.dirname, ".."), values);
    console.log(`ATTW GREEN: ${count} public workspace package(s)`);
}
