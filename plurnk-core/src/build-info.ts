import { errnoCode, isRecord } from "@plurnk/plurnk-contracts";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticGitEnv } from "./core/git-env.ts";

export interface BuildInfo {
    package: string;
    version: string;
    revision?: string;
    dirty?: boolean;
    artifact: "source" | "dist";
    path: string;
}

const codeDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(codeDir, "..");
const artifact = import.meta.url.endsWith(".ts") ? "source" : "dist";

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

// The package manifest's identity: the installation's own file, so a mismatch is a violation.
const packageIdentity = (value: unknown): { name: string; version: string } => {
    if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
        throw new TypeError("package.json names a package and a version.");
    }
    return { name: value.name, version: value.version };
};

// build-info.json as `scripts/write-build-info.mjs` wrote it.
const buildRecord = (value: unknown): Omit<BuildInfo, "artifact" | "path"> => {
    if (!isRecord(value) || typeof value.package !== "string" || typeof value.version !== "string"
        || (value.revision !== undefined && typeof value.revision !== "string")
        || (value.dirty !== undefined && typeof value.dirty !== "boolean")) {
        throw new TypeError("build-info.json names a package and a version, and may name a revision and whether the tree was dirty.");
    }
    return {
        package: value.package,
        version: value.version,
        ...(value.revision === undefined ? {} : { revision: value.revision }),
        ...(value.dirty === undefined ? {} : { dirty: value.dirty }),
    };
};

export const getBuildInfo = async (): Promise<BuildInfo> => {
    const pkg = packageIdentity(await readJson(resolve(packageRoot, "package.json")));

    if (artifact === "dist") {
        try {
            const built = buildRecord(await readJson(resolve(codeDir, "build-info.json")));
            return { ...built, artifact, path: packageRoot };
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") throw error;
        }
    }

    try {
        const git = (...args: string[]): string =>
            // {§membership} — the installation repository is inspected
            // through the same boundary as a workspace: no ambient GIT_*, no global
            // config, no repository-supplied fsmonitor helper or hooks (#568).
            execFileSync("git", ["-C", packageRoot, ...args], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                env: hermeticGitEnv(),
            }).trim();
        return {
            package: pkg.name,
            version: pkg.version,
            revision: git("rev-parse", "HEAD"),
            dirty: git("status", "--porcelain").length > 0,
            artifact,
            path: packageRoot,
        };
    } catch {
        return { package: pkg.name, version: pkg.version, artifact, path: packageRoot };
    }
};

export const formatBuildInfo = (info: BuildInfo): string => {
    const revision = info.revision === undefined
        ? "unknown"
        : `${info.revision.slice(0, 12)}${info.dirty ? "-dirty" : ""}`;
    return `${info.package}@${info.version} ${revision} ${info.artifact} ${info.path}`;
};
