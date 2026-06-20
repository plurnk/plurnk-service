// Off-hot-path e2e: install the built package into a clean sandbox as a consumer would, then
// prove it works out of the box — lean (no optional embedder / native deps), the bin boots the
// DB from the installed dist, the daemon listens, and the embedder-inactive notice surfaces.
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
        const stdout = execFileSync(bin, args, { cwd: sandbox, encoding: "utf8", env: { ...process.env, ...env } });
        return { code: 0, stdout };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
};

const bootStart = (env = {}) => new Promise((res) => {
    const child = spawn(bin, ["start"], { cwd: sandbox, env: { ...process.env, PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0", ...env } });
    let stdout = "", stderr = "", listening = false;
    // Resolve on EXIT (after a graceful SIGTERM) so both pipes fully drain — the
    // embedder notice rides stderr and races the stdout startup line otherwise.
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (c) => { stdout += c; if (/plurnk-service ws:\/\//.test(stdout) && !listening) { listening = true; setTimeout(() => child.kill("SIGTERM"), 300); } });
    child.stderr.on("data", (c) => { stderr += c; });
    child.once("exit", () => { clearTimeout(hardKill); res({ stdout, stderr, listening }); });
    child.once("error", () => { clearTimeout(hardKill); res({ stdout, stderr, listening, error: true }); });
});

process.stdout.write("== plurnk-service installation e2e ==\n");
process.stdout.write("-- local sandbox install --\n");
installSandbox();
ok(existsSync(bin), "plurnk-service bin linked in the sandbox");

const mods = resolve(sandbox, "node_modules");
ok(!existsSync(resolve(mods, "@plurnk", "plurnk-mimetypes-embeddings")), "optional embedder NOT auto-installed (lean base)");
ok(!existsSync(resolve(mods, "onnxruntime-node")) && !existsSync(resolve(mods, "sharp")), "native onnxruntime/sharp NOT pulled (script-free, portable)");

const help = runBin(["--help"], { PLURNK_DB_PATH: resolve(sandbox, "x.db"), PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" });
ok(help.code === 0 && /usage: plurnk-service/.test(help.stdout), "`--help` prints usage, exit 0");

const mig = runBin(["migrate"], { PLURNK_DB_PATH: resolve(sandbox, "test.db") });
ok(mig.code === 0 && /migrated:/.test(mig.stdout), "`migrate` boots the DB from installed dist (SQL + cosine load)");

const boot = await bootStart({ PLURNK_DB_PATH: resolve(sandbox, "start.db") });
ok(boot.listening === true, "`start` boots the daemon (WebSocket listening)");
ok(/embedder inactive/.test(boot.stderr), "embedder-inactive notice on stderr when the embedder is absent");

process.stdout.write("  ⚠ hosted-model round-trip: deliberate red (endpoint not live) — not yet asserted\n");

uninstallSandbox();
process.stdout.write(failures === 0 ? "\n== PASS ==\n" : `\n== FAIL (${failures}) ==\n`);
process.exit(failures === 0 ? 0 : 1);
