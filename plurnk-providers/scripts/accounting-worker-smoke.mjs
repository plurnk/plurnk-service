import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exerciseAccountingWorker } from "./accounting-worker-control.mjs";

const run = promisify(execFile);
const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("npm_")),
);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const consumerDir = await mkdtemp(join(tmpdir(), "plurnk-provider-worker-"));
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
    await run(
        "npm",
        ["install", "--no-package-lock", "--no-audit", "--no-fund", "--silent", tarballPath],
        { cwd: consumerDir, env: cleanEnv, maxBuffer: 64 * 1024 * 1024 },
    );
    await exerciseAccountingWorker({ absWorkingDir: consumerDir });
    process.stdout.write("[smoke] packed accounting subpath bundled and initialized in a browser Worker\n");
} finally {
    if (tarballPath !== undefined) await rm(tarballPath, { force: true });
    await rm(consumerDir, { recursive: true, force: true });
}
