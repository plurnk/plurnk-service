// Off-hot-path e2e: install the built package into a clean sandbox as a consumer would, then
// prove it works out of the box — the embedder ships (default-on OOTB, a bundle member since the -all removal) with no
// native install scripts, the bin boots the DB from the installed dist, the daemon listens, and a
// fresh install has NO active model (the #307 no-phone-home posture): the pointer surfaces instead.
// The hosted-model round-trip is a deliberate red until that endpoint is live.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installSandbox, uninstallSandbox, sandbox } from "./install-sandbox.mjs";

let failures = 0;
const ok = (cond, msg) => { process.stdout.write(`  ${cond ? "✓" : "✗"} ${msg}\n`); if (!cond) failures++; };
const bin = resolve(sandbox, "node_modules", ".bin", "plurnk-service");

const runBin = (args, env = {}) => {
    try {
        const stdout = execFileSync(bin, args, { cwd: sandbox, encoding: "utf8", env: { ...process.env, HOME: sandbox, ...env } });
        return { code: 0, stdout };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
};

const bootStart = (env = {}) => new Promise((res) => {
    // Run from OUTSIDE the install dir so discovery must resolve plugins package-relative,
    // not from CWD/node_modules — the global-dogfood scenario (start from your own project).
    const child = spawn(bin, ["start"], { cwd: resolve(sandbox, ".."), env: { ...process.env, HOME: sandbox, PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0", ...env } });
    let stdout = "", stderr = "", listening = false;
    // Resolve on EXIT (after a graceful SIGTERM) so both pipes fully drain — the
    // embedder notice rides stderr and races the stdout startup line otherwise.
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (c) => { stdout += c; if (/plurnk-service agui=http:\/\//.test(stdout) && !listening) { listening = true; setTimeout(() => child.kill("SIGTERM"), 300); } });
    child.stderr.on("data", (c) => { stderr += c; });
    child.once("exit", () => { clearTimeout(hardKill); res({ stdout, stderr, listening }); });
    child.once("error", () => { clearTimeout(hardKill); res({ stdout, stderr, listening, error: true }); });
});

process.stdout.write("== plurnk-service installation e2e ==\n");
process.stdout.write("-- local sandbox install --\n");
installSandbox();
ok(existsSync(bin), "plurnk-service bin linked in the sandbox");

const mods = resolve(sandbox, "node_modules");
ok(existsSync(resolve(mods, "@plurnk", "plurnk-mimetypes-embeddings")), "embedder ships OOTB (default-on bundle member)");
for (const provider of ["cloudflare", "google", "openrouter", "xai"]) {
    ok(existsSync(resolve(mods, "@plurnk", `plurnk-providers-${provider}`)), `${provider} provider ships OOTB`);
}
ok(!existsSync(resolve(mods, "onnxruntime-node")) && !existsSync(resolve(mods, "sharp")), "native onnxruntime/sharp NOT pulled (script-free, portable)");

const help = runBin(["--help"], { PLURNK_DB_PATH: resolve(sandbox, "x.db"), PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" });
ok(help.code === 0 && /usage: plurnk-service/.test(help.stdout), "`--help` prints usage, exit 0");

const mig = runBin(["migrate"], { PLURNK_DB_PATH: resolve(sandbox, "test.db") });
ok(mig.code === 0 && /migrated:/.test(mig.stdout), "`migrate` boots the DB from installed dist (SQL + cosine load)");

// first-run bootstrap: ~/.plurnk seeded with config (HOME → sandbox), no PLURNK_DB_PATH so it homes the DB
const home = runBin(["migrate"], {});
ok(existsSync(resolve(sandbox, ".plurnk", ".env")) && existsSync(resolve(sandbox, ".plurnk", "plurnk.db")),
    "first run bootstraps ~/.plurnk (.env seeded + DB homed there, not CWD)");
void home;

const boot = await bootStart({ PLURNK_DB_PATH: resolve(sandbox, "start.db") });
ok(boot.listening === true, "`start` boots the daemon (the AG-UI listener bound — single-listener production, #357)");
ok(!/embedder inactive/.test(boot.stderr), "no embedder-inactive notice — the shipped embedder is active");
// #307 — a fresh install resolves NO model: the boot line says so, the stderr pointer names the
// three options, and nothing can phone the hosted relay without the user uncommenting it.
ok(/ no model\n?$/m.test(boot.stdout) || /no model/.test(boot.stdout), "startup line reports 'no model' on an untouched install (no hosted default)");
ok(/no model configured/.test(boot.stderr) && /local \/ cloud \/ plurnk\.ai/.test(boot.stderr), "the pointer names the three options in ~/.plurnk/.env");

process.stdout.write("  ⚠ hosted-model round-trip: deliberate red (endpoint not live) — not yet asserted\n");

uninstallSandbox();
process.stdout.write(failures === 0 ? "\n== PASS ==\n" : `\n== FAIL (${failures}) ==\n`);
process.exit(failures === 0 ? 0 : 1);
