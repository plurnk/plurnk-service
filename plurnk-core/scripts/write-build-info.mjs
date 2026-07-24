import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const revision = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;

writeFileSync(
    resolve(root, "dist", "build-info.json"),
    `${JSON.stringify({ package: pkg.name, version: pkg.version, revision, dirty })}\n`,
);

// npm's `bin` target must be executable on POSIX. TypeScript creates emitted
// files with the process default mode, so every clean build otherwise turns
// the installed command back into a non-executable 0644 file.
chmodSync(resolve(root, "dist", "service.js"), 0o755);
