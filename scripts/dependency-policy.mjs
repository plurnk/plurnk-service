import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// {§core-plugin-composition}: capability frameworks own contracts and
// discovery, never runtime edges to their leaf consumers. The composed host's
// manifest is the one default-inventory owner ({§bundled-set}).
const leanFrameworks = new Map([
    ["plurnk-mimetypes/package.json", "@plurnk/plurnk-mimetypes-"],
    ["plurnk-execs/package.json", "@plurnk/plurnk-execs-"],
]);

export const installScriptViolations = (report) => {
    if (!Array.isArray(report?.allowScripts)) {
        throw new TypeError("npm install-scripts returned an invalid allowScripts report");
    }
    return report.allowScripts.flatMap(({ name, changes = [] }) => changes.map(({ key }) =>
        `package.json: allowScripts does not review ${key ?? name}`));
};

export const workspaceNpmConfigViolations = (files) => files.map((file) =>
    `${file}: npm ignores workspace-local configuration; declare repository policy in the root .npmrc`);

if (import.meta.main) {
    const root = JSON.parse(await fs.readFile("package.json", "utf8"));
    const manifests = ["package.json", ...root.workspaces.map((dir) => path.join(dir, "package.json"))];
    const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"];
    const forbidden = /^(?:@tree-sitter-grammars\/)?tree-sitter(?:-|$)/;
    const { stdout: installScriptReport } = await run("npm", ["install-scripts", "ls", "--json"]);
    const violations = installScriptViolations(JSON.parse(installScriptReport));
    const workspaceNpmConfigs = (await Promise.all(root.workspaces.map((dir) => {
        const file = path.join(dir, ".npmrc");
        return fs.stat(file).then(() => file, (error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
        });
    }))).filter((file) => file !== null);
    violations.push(...workspaceNpmConfigViolations(workspaceNpmConfigs));

    for (const file of manifests) {
        const manifest = JSON.parse(await fs.readFile(file, "utf8"));
        for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
            if (typeof command === "string" && /\bnpm outdated\b/.test(command)) {
                violations.push(`${file}: scripts.${name} duplicates the root release freshness gate`);
            }
        }
        for (const section of sections) {
            for (const name of Object.keys(manifest[section] ?? {})) {
                if (name !== "web-tree-sitter" && forbidden.test(name)) {
                    violations.push(`${file}: ${section}.${name}`);
                }
            }
        }
        const leafPrefix = leanFrameworks.get(file);
        if (leafPrefix !== undefined) {
            for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
                for (const name of Object.keys(manifest[section] ?? {})) {
                    if (name.startsWith(leafPrefix)) {
                        violations.push(`${file}: ${section}.${name} makes the framework depend on a leaf consumer`);
                    }
                }
            }
        }
    }

    if (violations.length > 0) {
        console.error("Dependency policy violations:");
        for (const violation of violations) console.error(`  ${violation}`);
        process.exit(1);
    }

    console.log("dependency policy OK");
}
