import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exerciseRuntimeNeutralWorker } from "./runtime-neutral-worker-control.mjs";

const run = promisify(execFile);
const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("npm_")),
);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const workspaceDir = join(packageDir, "..");
const consumerDir = await mkdtemp(join(workspaceDir, ".plurnk-provider-worker-"));
const installedPackage = join(consumerDir, "node_modules", "@plurnk", "plurnk-providers");
let tarballPath;

try {
    const { stdout } = await run(
        "npm",
        ["pack", "--json", "--silent", "--ignore-scripts"],
        { cwd: packageDir, env: cleanEnv },
    );
    const [{ filename }] = JSON.parse(stdout);
    tarballPath = join(packageDir, filename);
    await writeFile(join(consumerDir, "package.json"), `${JSON.stringify({
        name: "plurnk-provider-worker-control",
        version: "0.0.0",
        private: true,
        type: "module",
    }, null, 2)}\n`);
    // The pre-publication gate cannot install this lockstep candidate from npm.
    // Extract its exact artifact; bundling fails if either runtime-neutral
    // contract gains a dependency unavailable to browser Workers.
    await mkdir(installedPackage, { recursive: true });
    await run(
        "tar",
        ["-xzf", tarballPath, "--strip-components=1", "-C", installedPackage],
        { maxBuffer: 64 * 1024 * 1024 },
    );
    const manifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
    if (manifest.dependencies?.["@plurnk/plurnk-contracts"] === undefined) {
        throw new Error("Packed provider does not declare its runtime contracts dependency");
    }
    await exerciseRuntimeNeutralWorker({ absWorkingDir: consumerDir });
    process.stdout.write("[smoke] packed accounting and error subpaths initialized in a browser Worker\n");
} finally {
    if (tarballPath !== undefined) await rm(tarballPath, { force: true });
    await rm(consumerDir, { recursive: true, force: true });
}
