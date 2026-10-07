import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// {§package-release-contract}: Changesets owns version calculation and range updates.
const run = (command, args) => new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
});

if (process.argv.length !== 2) throw new Error("release:version takes no version argument; record package changes with npm run changeset first");
await run(process.execPath, [fileURLToPath(import.meta.resolve("@changesets/cli/bin.js")), "version"]);
await run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
