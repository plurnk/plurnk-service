import { readFile } from "node:fs/promises";
import path from "node:path";

const TEST_TIERS = ["test:lint", "test:unit", "test:intg"];
const AUXILIARY_TEST_SCRIPTS = new Set([
    "test:live",
    "test:live:specimen",
    "test:live:zeropin",
    "test:demo",
    "test:demo:zeropin",
    "test:benchlet",
    "test:providersPing",
    "test:llama",
    "test:installation",
]);

export const canonicalTestCommand = (scripts = {}) => TEST_TIERS
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => `npm run ${name}`)
    .join(" && ");

export const packageLifecycleViolations = (dir, manifest) => {
    const scripts = manifest.scripts ?? {};
    const expected = canonicalTestCommand(scripts);
    const violations = [];

    if (expected === "") {
        violations.push(`${dir}: declare at least one of test:lint, test:unit, or test:intg`);
        if (scripts.test !== undefined) {
            violations.push(`${dir}: test must be absent until a canonical tier exists`);
        }
    } else if (scripts.test !== expected) {
        violations.push(`${dir}: test must be \`${expected}\``);
    }

    for (const name of Object.keys(scripts)) {
        if (name === "test" || TEST_TIERS.includes(name) || AUXILIARY_TEST_SCRIPTS.has(name)) continue;
        if (name.startsWith("test:")) {
            violations.push(`${dir}: ${name} is not a classified test lifecycle script`);
        }
    }
    return violations;
};

export const inspectPackageLifecycles = async (root) => {
    const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (!Array.isArray(rootManifest.workspaces)) {
        throw new Error("root package.json must declare workspaces");
    }

    const violations = [];
    for (const dir of rootManifest.workspaces) {
        const manifest = JSON.parse(await readFile(path.join(root, dir, "package.json"), "utf8"));
        violations.push(...packageLifecycleViolations(dir, manifest));
    }
    return { workspaces: rootManifest.workspaces.length, violations };
};

if (import.meta.main) {
    const root = path.resolve(import.meta.dirname, "..");
    const { workspaces, violations } = await inspectPackageLifecycles(root);
    if (violations.length > 0) {
        throw new Error(`package lifecycle policy violations:\n  ${violations.join("\n  ")}`);
    }
    console.log(`package lifecycle policy OK: ${workspaces} workspace(s)`);
}
