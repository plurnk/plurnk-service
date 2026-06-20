// Pack the built package and install it into .sandbox/ as a real consumer would.
// `npm run build:local:install` / `build:local:uninstall`; also the engine for test:installation.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Outside the repo tree, so node's module resolution can't walk up into the repo's own
// node_modules — a nested sandbox would resolve the dev-installed embedder and defeat the
// isolation (and the lean-install / embedder-notice checks).
export const sandbox = resolve(tmpdir(), "plurnk-service-sandbox");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

export function pack() {
    const out = execFileSync("npm", ["pack"], { cwd: root, encoding: "utf8" });
    return resolve(root, out.trim().split("\n").pop().trim());
}

function cleanTarballs() {
    for (const f of readdirSync(root)) {
        if (f.startsWith("plurnk-plurnk-service-") && f.endsWith(".tgz")) rmSync(resolve(root, f));
    }
}

export function installSandbox() {
    sh("npm", ["run", "build"], { cwd: root });
    const tarball = pack();
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(
        resolve(sandbox, "package.json"),
        `${JSON.stringify({ name: "plurnk-sandbox", version: "1.0.0", private: true }, null, 2)}\n`,
    );
    sh("npm", ["install", tarball], { cwd: sandbox });
    return { sandbox, tarball };
}

export function uninstallSandbox() {
    rmSync(sandbox, { recursive: true, force: true });
    cleanTarballs();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2];
    if (cmd === "install") { installSandbox(); process.stdout.write(`sandbox installed: ${sandbox}\n`); }
    else if (cmd === "uninstall") { uninstallSandbox(); process.stdout.write("sandbox removed\n"); }
    else { process.stderr.write("usage: install-sandbox.mjs install|uninstall\n"); process.exit(1); }
}
