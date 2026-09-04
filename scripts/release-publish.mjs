// The deterministic publish machine replaces the shell loop whose piped
// exit codes masked a refused publish and announced a torn release. Five laws, mechanized:
//   1. The committed stamp is clean, then built and gated before the first publish.
//   2. npm's REAL exit code — execFile rejects on nonzero; a refused publish HALTS the train.
//   3. Nothing counts as published until the REGISTRY SERVES the stamped version (bounded poll).
//   4. Managed dependency leaves publish after their platform owner and before any clean
//      consumer install; that install counts the dep tree and boots a live listener as a gate.
//   5. The script's green exit is the ONLY state that permits a release announcement.
// Idempotent: a package the registry already serves at the stamp is skipped — a torn release
// rerun publishes exactly the missing rungs.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveClientCheckout } from "./project-topology.mjs";
import { awaitRegistryVersion } from "./registry-visibility.mjs";
import { probeInstalledDaemon } from "./release-daemon-probe.mjs";

const run = promisify(execFile);
const ROOT_PKG = "@plurnk/plurnk-service";
const CLIENT_PKG = "@plurnk/plurnk";
const CLIENT_ROOT = resolveClientCheckout(process.env);
const CLIENT_RELEASE = path.join(CLIENT_ROOT, "scripts", "release-publish.mjs");
const clientVersion = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(clientVersion ?? "")) {
    throw new Error("usage: release-publish.mjs <client-version>");
}

const assertClean = async (phase) => {
    const dirty = (await run("git", ["status", "--porcelain"])).stdout.trim();
    if (dirty !== "") {
        throw new Error(`release-publish requires a clean committed stamp ${phase}:\n${dirty}`);
    }
};
const runVisible = (command, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} failed (exit ${code})`)));
});

const root = JSON.parse(await fs.readFile("package.json", "utf8"));
const order = [];
for (const dir of root.workspaces) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    order.push({ name: pkg.name, version: pkg.version });
}
const version = order[0].version;
if (!order.every((p) => p.version === version)) throw new Error("lockstep violated: workspaces disagree on version — stamp before publishing");

await runVisible("node", ["scripts/release-check.mjs", clientVersion]);
await assertClean("before publication");

const served = async (name) => {
    try { return (await run("npm", ["view", name, "version"])).stdout.trim(); }
    catch { return null; } // never published — view exits nonzero
};

console.log(`release-publish: ${order.length} workspaces at ${version}`);
for (const { name } of order) {
    if (await served(name) === version) { console.log(`  serves  ${name}`); continue; }
    console.log(`  publish ${name}`);
    // The committed stamp was built and gated once above. Publication remains
    // script-free so no package can mutate or re-prove itself mid-train.
    await run("npm", ["publish", "-w", name, "--access", "public", "--ignore-scripts"], { maxBuffer: 16 * 1024 * 1024 }); // Law 1: rejects on refusal
    await awaitRegistryVersion({ name, version, lookup: served });
}

// Managed leaves may depend on the just-published platform while the platform
// also installs them as optional runtime capabilities. Publish them between
// their owner and the clean consumer, never after a consumer has resolved stale
// leaf metadata.
console.log("release-publish: external package phase");
await new Promise((res, rej) => {
    const ph = spawn("node", ["scripts/release-external-packages.mjs"], { stdio: "inherit" });
    ph.on("exit", (code) => code === 0 ? res() : rej(new Error(`external package phase failed (exit ${code})`)));
});

// Law 3: the consumer's seat. Install the root artifact FROM THE REGISTRY and boot it.
console.log(`verify: consumer install of ${ROOT_PKG}@${version}`);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-release-verify-"));
try {
    await run("npm", ["init", "-y"], { cwd: tmp });
    await run("npm", ["i", `${ROOT_PKG}@${version}`], { cwd: tmp, maxBuffer: 64 * 1024 * 1024 });
    await run("npm", ["ls", "--all"], { cwd: tmp, maxBuffer: 64 * 1024 * 1024 });
    const installed = await fs.readdir(path.join(tmp, "node_modules", "@plurnk"));
    console.log(`verify: dependency graph valid; ${installed.length} @plurnk packages on disk`);

    const probeEnv = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("PLURNK_")),
    );
    const probe = await probeInstalledDaemon({
        command: path.join(tmp, "node_modules", ".bin", "plurnk-service"),
        cwd: tmp,
        env: {
            ...probeEnv,
            HOME: tmp,
            XDG_CONFIG_HOME: path.join(tmp, ".config"),
            XDG_DATA_HOME: path.join(tmp, ".local", "share"),
            OTEL_TRACES_EXPORTER: "none",
            OTEL_METRICS_EXPORTER: "none",
            OTEL_LOGS_EXPORTER: "none",
        },
        packageName: ROOT_PKG,
        version,
    });
    console.log(`verify: installed artifact ${ROOT_PKG}@${version} owned ${probe.address} and exited cleanly`);
} finally {
    await fs.rm(tmp, { recursive: true, force: true });
}

// The client has an independent version line but consumes the platform. Only
// prepare and publish it after its exact contracts are registry-resolvable.
console.log(`release-publish: client phase ${CLIENT_PKG}@${clientVersion}`);
await runVisible("node", [CLIENT_RELEASE, clientVersion, version], { cwd: CLIENT_ROOT });

// Verify the exact served artifacts rather than whichever client happened to
// own the latest tag before this train.
console.log(`verify: packed composition ${CLIENT_PKG}@${clientVersion} + ${ROOT_PKG}@${version}`);
await runVisible("node", [path.join(CLIENT_ROOT, "scripts", "test-composition.mjs")], {
    cwd: CLIENT_ROOT,
    env: {
        ...process.env,
        PLURNK_COMPOSITION_CLIENT: `${CLIENT_PKG}@${clientVersion}`,
        PLURNK_COMPOSITION_SERVICE: `${ROOT_PKG}@${version}`,
    },
});

console.log(`release-publish: platform ${version}, managed externals, and client ${clientVersion} published and consumer-verified`);
