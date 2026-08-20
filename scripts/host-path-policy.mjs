import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IGNORED_DIRECTORIES = new Set([".git", ".tmp", "coverage", "dist", "node_modules"]);
const TEXT_EXTENSIONS = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".sh", ".ts"]);
const LEGACY_RENDERED_PATH = /(?:~|\$HOME|\$\{HOME\})\/\.plurnk(?=\/|\b)/gu;
const LEGACY_CONSTRUCTION = /\b(?:join|resolve)\([^;\n]*["']\.plurnk["']/gu;

// These are transition teaching, not active path ownership. Increasing an
// allowance requires an explicit review of why another legacy mention belongs.
const LEGACY_REFERENCE_ALLOWANCE = new Map([
    ["CHANGELOG.md", 1],
    ["plurnk-core/INSTALL.md", 1],
    ["plurnk-core/README.md", 1],
    ["plurnk-core/SPEC.md", 1],
    ["plurnk-core/src/service.ts", 1],
]);
const PATH_OWNER = "plurnk-core/src/core/HostPaths.ts";

const isTest = (name) => /(?:^|\/)(?:test|tests)\//u.test(name) || /\.test\.[^.]+$/u.test(name);

export const hostPathViolations = (sources) => {
    const violations = [];
    for (const { name, content } of sources) {
        if (isTest(name)) continue;

        const legacyCount = [
            ...content.matchAll(LEGACY_RENDERED_PATH),
            ...(name === PATH_OWNER ? [] : content.matchAll(LEGACY_CONSTRUCTION)),
        ].length;
        const allowedLegacy = LEGACY_REFERENCE_ALLOWANCE.get(name) ?? 0;
        if (legacyCount > allowedLegacy) {
            violations.push(`${name}: ${legacyCount} legacy-home reference(s), allowance ${allowedLegacy}`);
        }

        if (name !== PATH_OWNER && /\b(?:join|resolve)\(\s*homedir\(\)/u.test(content)) {
            violations.push(`${name}: reconstructs a host path from homedir() outside ${PATH_OWNER}`);
        }
    }
    return violations;
};

const filesUnder = async (directory) => {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...await filesUnder(join(directory, entry.name)));
        } else if (entry.name !== "package-lock.json" && TEXT_EXTENSIONS.has(extname(entry.name))) {
            files.push(join(directory, entry.name));
        }
    }
    return files;
};

if (import.meta.main) {
    const files = await filesUnder(ROOT);
    const sources = await Promise.all(files.map(async (file) => ({
        name: relative(ROOT, file),
        content: await readFile(file, "utf8"),
    })));
    const violations = hostPathViolations(sources);
    if (violations.length > 0) {
        process.stderr.write(`Host path policy violations:\n  ${violations.join("\n  ")}\n`);
        process.exit(1);
    }
    process.stdout.write("host path policy OK\n");
}
