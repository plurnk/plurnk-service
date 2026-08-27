import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("candidate SIGTERM stops its client and daemon, writes the digest, and preserves the signal status", { timeout: 30_000 }, async (t) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "plurnk-candidate-signal-"));
    const clientRoot = resolve(fixture, "client");
    const candidateDir = resolve(fixture, "candidate");
    mkdirSync(resolve(clientRoot, "bin"), { recursive: true });
    writeFileSync(resolve(clientRoot, "bin", "plurnk.js"), [
        'process.stderr.write("fixture-client-ready\\n");',
        "setInterval(() => {}, 1_000);",
        "",
    ].join("\n"));

    const env = {
        ...process.env,
        XDG_CONFIG_HOME: resolve(fixture, ".config"),
        OPENAI_API_KEY: "candidate-fixture",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        PLURNK_MODEL: "openai/gpt-4.1-mini",
        PLURNK_CANDIDATE_DIR: candidateDir,
        PLURNK_CANDIDATE_SKIP_BUILD: "1",
        PLURNK_CLIENT_CHECKOUT: clientRoot,
    };
    delete env.PLURNK_CANDIDATE_MODEL;
    for (const key of Object.keys(env)) {
        if (key === "PLURNK_PROVIDERS_GBNF" || key.startsWith("PLURNK_PROVIDERS_GBNF_")) delete env[key];
    }
    env.PLURNK_PROVIDERS_GBNF = "0";

    const child = spawn(process.execPath, ["scripts/candidate.mjs"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        rmSync(fixture, { recursive: true, force: true });
    });

    let stdout = "";
    let stderr = "";
    let signaled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (!signaled && stderr.includes("fixture-client-ready")) {
            signaled = true;
            child.kill("SIGTERM");
        }
    });

    const result = await new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => accept({ code, signal }));
    });

    assert.equal(signaled, true, `the fixture client started\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.deepEqual(result, { code: 143, signal: null }, `SIGTERM is finalized by the launcher\n${stderr}`);
    assert.match(stderr, /candidate artifact:/, "the launcher reports the preserved artifact");
    assert.equal(existsSync(resolve(candidateDir, "digest", "digest.json")), true, "SIGTERM still produces the supported digest");
});
