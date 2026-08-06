// The deterministic publish machine replaces the shell loop whose piped
// exit codes masked a refused publish and announced a torn release. Five laws, mechanized:
//   1. The committed stamp is clean, then built and gated before the first publish.
//   2. npm's REAL exit code — execFile rejects on nonzero; a refused publish HALTS the train.
//   3. Nothing counts as published until the REGISTRY SERVES the stamped version (bounded poll).
//   4. The run ends with the consumer-install verification: temp dir, install the root package
//      from the registry, dep tree counted, boot probe, live listener — as a GATE, not a courtesy.
//   5. The script's green exit is the ONLY state that permits a release announcement.
// Idempotent: a package the registry already serves at the stamp is skipped — a torn release
// rerun publishes exactly the missing rungs.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const run = promisify(execFile);
const ROOT_PKG = "@plurnk/plurnk-service";
const CLIENT_PKG = "@plurnk/plurnk";
const CLIENT_ROOT = path.resolve(import.meta.dirname, "..", "..", "plurnk");
const CLIENT_RELEASE = path.join(CLIENT_ROOT, "scripts", "release-publish.mjs");
const BOOT_PORT = 17821;
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

await assertClean("before build");
await runVisible("node", [CLIENT_RELEASE, "--check", clientVersion, version], { cwd: CLIENT_ROOT });
console.log("release-publish: building and gating the committed stamp");
await runVisible("npm", ["run", "build"]);
await runVisible("node", ["scripts/release-gates.mjs"]);
await assertClean("after gates");

const served = async (name) => {
    try { return (await run("npm", ["view", name, "version"])).stdout.trim(); }
    catch { return null; } // never published — view exits nonzero
};

// Law 2: the registry must SERVE the version. Publish-then-poll, bounded.
const awaitServed = async (name) => {
    for (let i = 0; i < 12; i++) {
        if (await served(name) === version) return;
        await sleep(10_000);
    }
    throw new Error(`${name}: published but the registry never served ${version} within the poll budget — do NOT announce`);
};

console.log(`release-publish: ${order.length} workspaces at ${version}`);
for (const { name } of order) {
    if (await served(name) === version) { console.log(`  serves  ${name}`); continue; }
    console.log(`  publish ${name}`);
    // The committed stamp was built and gated once above. Publication remains
    // script-free so no package can mutate or re-prove itself mid-train.
    await run("npm", ["publish", "-w", name, "--access", "public", "--ignore-scripts"], { maxBuffer: 16 * 1024 * 1024 }); // Law 1: rejects on refusal
    await awaitServed(name);
}

// Law 3: the consumer's seat. Install the root artifact FROM THE REGISTRY and boot it.
console.log(`verify: consumer install of ${ROOT_PKG}@${version}`);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-release-verify-"));
try {
    await run("npm", ["init", "-y"], { cwd: tmp });
    await run("npm", ["i", `${ROOT_PKG}@${version}`], { cwd: tmp, maxBuffer: 64 * 1024 * 1024 });
    const installed = await fs.readdir(path.join(tmp, "node_modules", "@plurnk"));
    console.log(`verify: ${installed.length} @plurnk packages on disk`);
    if (installed.length < order.length - 1) throw new Error(`dep tree incomplete: ${installed.length} < ${order.length - 1}`);

    const svc = spawn("npx", ["plurnk-service"], {
        cwd: tmp,
        env: { ...process.env, HOME: tmp, PLURNK_HOST: "127.0.0.1", PLURNK_PORT: String(BOOT_PORT), PLURNK_WS_PORT: String(BOOT_PORT + 1) },
        stdio: "ignore",
    });
    try {
        let alive = false;
        for (let i = 0; i < 10 && !alive; i++) {
            await sleep(2_000);
            try { await fetch(`http://127.0.0.1:${BOOT_PORT}/`); alive = true; } catch { /* not up yet */ }
        }
        if (!alive) throw new Error("installed artifact never answered HTTP — do NOT announce");
        console.log("verify: installed artifact boots, listener live");
    } finally {
        svc.kill("SIGTERM");
    }
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

// Align managed external packages before completing the release.
console.log("release-publish: external package phase");
await new Promise((res, rej) => {
    const ph = spawn("node", ["scripts/release-external-packages.mjs"], { stdio: "inherit" });
    ph.on("exit", (code) => code === 0 ? res() : rej(new Error(`external package phase failed (exit ${code})`)));
});

console.log(`release-publish: platform ${version} and client ${clientVersion} published, consumer-verified, and external packages checked`);
