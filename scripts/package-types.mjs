import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

// Exported documents are resolvable assets, not type-importable code modules.
const excludedEntrypoints = {
    "@plurnk/plurnk-meta": ["./POLICY.md", "./recap.md"],
};

const runChecker = (command, args, cwd) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
});

export const checkPackageTypes = async (root, { only, run = runChecker, report = console.log } = {}) => {
    const { workspaces } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (only !== undefined && !workspaces.includes(only)) throw new Error(`Unknown workspace: ${only}`);
    const failures = [];
    let checked = 0;
    for (const directory of only === undefined ? workspaces : [only]) {
        const manifest = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));
        if (manifest.private === true) continue;
        const exclusions = excludedEntrypoints[manifest.name] ?? [];
        report(`ATTW ${directory}: esm-only${exclusions.length === 0 ? "" : `; file assets excluded: ${exclusions.join(", ")}`}`);
        const { code, signal } = await run("npm", [
            "exec", "--yes", "--package=@arethetypeswrong/cli@0.18.5", "--", "attw", "--pack", directory,
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
    const { values } = parseArgs({ options: { only: { type: "string" } } });
    const count = await checkPackageTypes(path.resolve(import.meta.dirname, ".."), values);
    console.log(`ATTW GREEN: ${count} public workspace package(s)`);
}
