import { readFile } from "node:fs/promises";
import path from "node:path";

export const shipsDist = (manifest) => Array.isArray(manifest.files)
    && manifest.files.some((entry) => typeof entry === "string"
        && !entry.startsWith("!")
        && (entry === "dist" || entry.startsWith("dist/")));

export const packageBuildViolations = (dir, manifest) => {
    if (manifest.private === true || !shipsDist(manifest)) return [];

    const scripts = manifest.scripts ?? {};
    const violations = [];
    if (scripts["build:clean"] !== "rm -rf dist") {
        violations.push(`${dir}: build:clean must be exactly \`rm -rf dist\``);
    }
    if (typeof scripts.build !== "string" || !scripts.build.startsWith("npm run build:clean && ")) {
        violations.push(`${dir}: build must begin with \`npm run build:clean && \``);
    }
    if (typeof scripts["build:dist"] !== "string" || scripts["build:dist"].length === 0) {
        violations.push(`${dir}: a dist-shipping package must declare build:dist`);
    } else if (scripts["build:dist"].includes("rm -rf dist")) {
        violations.push(`${dir}: build:dist must emit only; build:clean owns deletion`);
    }
    if (scripts.prepack !== "npm run build") {
        violations.push(`${dir}: prepack must invoke the complete public build`);
    }
    return violations;
};

export const inspectPackageBuilds = async (root) => {
    const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (!Array.isArray(rootManifest.workspaces)) {
        throw new Error("root package.json must declare workspaces");
    }

    const violations = [];
    let distPackages = 0;
    for (const dir of rootManifest.workspaces) {
        const manifest = JSON.parse(await readFile(path.join(root, dir, "package.json"), "utf8"));
        if (manifest.private !== true && shipsDist(manifest)) distPackages++;
        violations.push(...packageBuildViolations(dir, manifest));
    }
    return { distPackages, violations };
};

if (import.meta.main) {
    const root = path.resolve(import.meta.dirname, "..");
    const { distPackages, violations } = await inspectPackageBuilds(root);
    if (violations.length > 0) {
        throw new Error(`package build policy violations:\n  ${violations.join("\n  ")}`);
    }
    console.log(`package build policy OK: ${distPackages} dist-shipping workspace(s)`);
}
