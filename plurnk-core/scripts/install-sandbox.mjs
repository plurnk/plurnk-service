// Pack the built package and install it into a sandbox as a real consumer would.
// Monorepo-aware: EVERY workspace is packed (prepack builds each — the real publish
// path) and the sandbox resolves @plurnk/* from those tarballs via overrides, so the
// naive-install e2e runs pre-publish against the exact artifacts that will ship.
// `npm run build:local:install` / `build:local:uninstall`; also the engine for test:installation.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const monoRoot = resolve(root, "..");
// Outside the repo tree, so node's module resolution can't walk up into the repo's own
// node_modules — a nested sandbox would resolve the dev-installed workspaces and defeat the
// isolation (and the lean-install / embedder-notice checks).
export const sandbox = resolve(tmpdir(), "plurnk-service-sandbox");
const tarballDir = resolve(tmpdir(), "plurnk-service-sandbox-tarballs");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

// Pack every workspace (prepack builds each). Returns { packageName: tarballPath }.
export function packAll() {
    rmSync(tarballDir, { recursive: true, force: true });
    mkdirSync(tarballDir, { recursive: true });
    const workspaces = JSON.parse(readFileSync(resolve(monoRoot, "package.json"), "utf8")).workspaces;
    const map = {};
    for (const w of workspaces) {
        const dir = resolve(monoRoot, w);
        const name = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).name;
        const out = execFileSync("npm", ["pack", "--pack-destination", tarballDir], { cwd: dir, encoding: "utf8" });
        map[name] = resolve(tarballDir, out.trim().split("\n").pop().trim());
    }
    return map;
}

export function installSandbox() {
    const tarballs = packAll();
    const core = tarballs["@plurnk/plurnk-service"];
    if (core === undefined) throw new Error("packAll produced no @plurnk/plurnk-service tarball");
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(sandbox, { recursive: true });
    // core itself is the direct install target — npm rejects (EOVERRIDE) an override
    // that names a direct dependency; only its TREE resolves through overrides
    const overrides = Object.fromEntries(
        Object.entries(tarballs).filter(([name]) => name !== "@plurnk/plurnk-service").map(([name, file]) => [name, `file:${file}`]),
    );
    writeFileSync(
        resolve(sandbox, "package.json"),
        `${JSON.stringify({ name: "plurnk-sandbox", version: "1.0.0", private: true, overrides }, null, 2)}\n`,
    );
    sh("npm", ["install", core], { cwd: sandbox });
    return { sandbox, tarball: core, tarballs };
}

// Add one packed optional workspace to the already-installed consumer. The
// package becomes a direct dependency exactly as it would in a real project;
// remove its test-only override first because npm rejects an override that also
// names a direct dependency.
export function installPacked(tarballs, packageName) {
    const tarball = tarballs[packageName];
    if (tarball === undefined) throw new Error(`packAll produced no ${packageName} tarball`);
    const manifestPath = resolve(sandbox, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.overrides?.[packageName];
    manifest.dependencies = { ...manifest.dependencies, [packageName]: `file:${tarball}` };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    sh("npm", ["install"], { cwd: sandbox });
}

export function uninstallSandbox() {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(tarballDir, { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2];
    if (cmd === "install") { installSandbox(); process.stdout.write(`sandbox installed: ${sandbox}\n`); }
    else if (cmd === "uninstall") { uninstallSandbox(); process.stdout.write("sandbox removed\n"); }
    else { process.stderr.write("usage: install-sandbox.mjs install|uninstall\n"); process.exit(1); }
}
