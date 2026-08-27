import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveClientCheckout, resolveExternalReposRoot } from "./project-topology.mjs";
import {
    assertNpmPublisher,
    assertReleaseRepository,
} from "./release-authority.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const clientVersion = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(clientVersion ?? "")) {
    throw new Error("usage: release-check.mjs <client-version>");
}

const clientRoot = resolveClientCheckout(process.env);
const externalRoot = resolveExternalReposRoot(process.env);
const clientRelease = path.join(clientRoot, "scripts", "release-publish.mjs");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const versions = await Promise.all(manifest.workspaces.map(async (dir) =>
    JSON.parse(await readFile(path.join(root, dir, "package.json"), "utf8")).version));
const [version] = versions;
if (!versions.every((candidate) => candidate === version)) {
    throw new Error("lockstep violated: workspaces disagree on version — stamp before checking");
}

const assertClean = async (phase) => {
    const dirty = (await run("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
    if (dirty !== "") {
        throw new Error(`release-check requires a clean committed stamp ${phase}:\n${dirty}`);
    }
};

const runVisible = (command, args, options = {}) => new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
        ? accept()
        : reject(new Error(`${command} ${args.join(" ")} failed (exit ${code})`)));
});

await assertClean("before build");
const serviceAuthority = await assertReleaseRepository(root, "plurnk-service");
const npmAuthority = await assertNpmPublisher(root);
console.log(`release authority: ${serviceAuthority.origin}#${serviceAuthority.head.slice(0, 12)}; npm ${npmAuthority.identity} at ${npmAuthority.registry}`);
console.log(`release topology: client=${clientRoot}; externals=${externalRoot}; probe=child-owned ephemeral listener`);
await runVisible(process.execPath, [clientRelease, "--check", clientVersion, version], { cwd: clientRoot });
await runVisible("npm", ["run", "build"]);
await runVisible("npm", ["test"]);
await runVisible(process.execPath, ["scripts/release-gates.mjs"]);
await runVisible(process.execPath, ["scripts/release-external-packages.mjs", "--check"]);
await assertClean("after gates");

console.log(`release-check GREEN: platform ${version} + client ${clientVersion}`);
