import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const readJson = async <T>(path: string): Promise<T> =>
    JSON.parse(await readFile(path, "utf8")) as T;

export const getBuildInfo = async (): Promise<BuildInfo> => {
    const pkg = await readJson<{ name: string; version: string }>(
        resolve(packageRoot, "package.json"),
    );

    if (artifact === "dist") {
        try {
            const built = await readJson<Omit<BuildInfo, "artifact" | "path">>(
                resolve(codeDir, "build-info.json"),
            );
            return { ...built, artifact, path: packageRoot };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }

    try {
        const git = (...args: string[]): string =>
            execFileSync("git", ["-C", packageRoot, ...args], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
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
