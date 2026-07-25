import fs from "node:fs/promises";
import path from "node:path";

const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const manifests = ["package.json", ...root.workspaces.map((dir) => path.join(dir, "package.json"))];
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"];
const forbidden = /^(?:@tree-sitter-grammars\/)?tree-sitter(?:-|$)/;
const violations = [];

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
}

if (violations.length > 0) {
    console.error("Dependency policy violations:");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
}

console.log("dependency policy OK");
