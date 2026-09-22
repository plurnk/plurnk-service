// The published manifest is a projection of the source manifest (#797). Every workspace
// declares the monorepo's `plurnk-dev` export condition first, aimed at TypeScript sources,
// so Node's first-match resolution reaches `src/` under --conditions=plurnk-dev; the tarball
// ships no `src/`, so a consumer running with that condition would resolve a file that does
// not exist. The tarball carries no such condition, and nothing else it declares may point
// outside the files it ships.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DEV_CONDITION = "plurnk-dev";

const shipped = (target) => target.replace(/^\.\//u, "");
// A subpath pattern (`./docs/*.md`) ships when at least one packed file matches it.
const ships = (packed, target) => {
    const relative = shipped(target);
    if (!relative.includes("*")) return packed.has(relative);
    const pattern = new RegExp(`^${relative.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u");
    return [...packed].some((file) => pattern.test(file));
};

export const projectManifest = (manifest, files) => {
    const packed = new Set(files);
    const violations = [];
    const check = (subpath, condition, target) => {
        if (typeof target !== "string") {
            violations.push(`exports[${JSON.stringify(subpath)}]${condition === null ? "" : `.${condition}`}: nested conditions are not projected`);
        } else if (!ships(packed, target)) {
            violations.push(`exports[${JSON.stringify(subpath)}]${condition === null ? "" : `.${condition}`} -> ${target}: the tarball does not ship it`);
        }
    };
    const project = (subpath, entry) => {
        if (typeof entry === "string") {
            check(subpath, null, entry);
            return entry;
        }
        const projected = Object.fromEntries(Object.entries(entry).filter(([condition]) => condition !== DEV_CONDITION));
        for (const [condition, target] of Object.entries(projected)) check(subpath, condition, target);
        return projected;
    };
    const { exports } = manifest;
    if (exports === undefined) return { manifest, violations };
    const projected = typeof exports === "string" ? project(".", exports)
        : Object.fromEntries(Object.entries(exports).map(([subpath, entry]) => [subpath, project(subpath, entry)]));
    return { manifest: { ...manifest, exports: projected }, violations };
};

// Rewrite one packed tarball in place: its manifest becomes the projection of what it ships.
// Returns the projected manifest and the shipped file list (package-relative).
export const projectTarball = async (archive) => {
    const stage = await mkdtemp(path.join(tmpdir(), "plurnk-package-projection-"));
    try {
        await run("tar", ["-xzf", archive, "-C", stage]);
        const listing = (await run("tar", ["-tzf", archive], { maxBuffer: 16 * 1024 * 1024 })).stdout;
        const files = listing.split("\n").filter((line) => line.startsWith("package/") && !line.endsWith("/")).map((line) => line.slice("package/".length));
        const manifestPath = path.join(stage, "package", "package.json");
        const source = JSON.parse(await readFile(manifestPath, "utf8"));
        const { manifest, violations } = projectManifest(source, files);
        if (violations.length > 0) {
            throw new Error(`${source.name}: the published manifest points outside the tarball:\n  ${violations.join("\n  ")}`);
        }
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await run("tar", ["-czf", archive, "-C", stage, "package"]);
        return { manifest, files };
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
};

// The projection is what a consumer installs: under --conditions=plurnk-dev every export
// resolves to a file the tarball ships, never to a missing source file.
export const resolveProjected = async (archive, manifest, files) => {
    const consumer = await mkdtemp(path.join(tmpdir(), "plurnk-package-consumer-"));
    try {
        const home = path.join(consumer, "node_modules", ...manifest.name.split("/"));
        await run("mkdir", ["-p", home]);
        await run("tar", ["-xzf", archive, "-C", home, "--strip-components=1"]);
        const subpaths = typeof manifest.exports === "string" ? ["."] : Object.keys(manifest.exports ?? { ".": null });
        const specifiers = subpaths.filter((subpath) => !subpath.includes("*")).map((subpath) => `${manifest.name}${subpath.slice(1)}`);
        const probe = `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map((s) => import.meta.resolve(s))))`;
        const { stdout } = await run("node", ["--conditions", DEV_CONDITION, "--input-type=module", "-e", probe], { cwd: consumer });
        const resolved = JSON.parse(stdout);
        const packed = new Set(files);
        const outside = resolved.filter((url) => !url.startsWith(`file://${home}/`) || !packed.has(fileURLToPath(url).slice(home.length + 1)));
        if (outside.length > 0) throw new Error(`${manifest.name}: an export resolves outside the shipped files under --conditions=${DEV_CONDITION}:\n  ${outside.join("\n  ")}`);
        return resolved;
    } finally {
        await rm(consumer, { recursive: true, force: true });
    }
};
