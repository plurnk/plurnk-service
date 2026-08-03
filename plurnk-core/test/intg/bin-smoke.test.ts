// Smoke coverage for src/service.ts (the plurnk-service launcher). Lint and intg
// exercise the in-tree Daemon class directly; nothing else catches rot in the
// entrypoint (config cascade, env→arg mapping, signal handlers, the dynamic
// provider load path, the startup-line stdout format clients may parse). This test
// spawns the actual entry, waits for the AG-UI listener (production is
// single-listener, #357), probes it over HTTP, and ensures clean SIGTERM shutdown.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
// Only the resolution mode crosses into spawned daemons — NEVER the test harness's own
// --import/--env-file flags, which would re-run the mock fixture inside the child and
// silently repoint its DB/model at the fixture's.
const CONDITION_ARGS = process.execArgv.filter((a) => a.startsWith("--conditions"));

interface BootedDaemon {
    child: ChildProcess;
    host: string;
    port: number;
    tmpdir: string;
}

const bootDaemon = (): Promise<BootedDaemon> => new Promise((resolvePromise, rejectPromise) => {
    void (async () => {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-bin-smoke-"));
        const dbPath = join(dir, "plurnk.db");
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,   // isolate the ~/.plurnk first-run bootstrap into the temp dir
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",      // the AG-UI+ surface — THE listener; OS picks a free port
            PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled", // {§browser-provisioning}: no operator browser in this launcher fixture
        };
        delete env.PLURNK_MODEL;

        // cwd isolation, same reason as HOME: the service cascade loads ./.env (operator config,
        // the owner's surface) — an inherited cwd leaks the box's model selector into this
        // hermetic tier (a jennifer pivot + #537's required key = boot death, no test bug).
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuf = "";
        let stderrBuf = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            // 90s, under the test's own 120s override (#495): concurrent lanes drill on one box, so a
            // healthy boot is legitimately slow under tier concurrency — this smoke asserts
            // BOOTS-AND-ANSWERS, never boots-fast. Internal < per-test, so the legible diagnostic
            // (with captured stdout/stderr) always beats the runner's bare cancellation.
            rejectPromise(new Error(`bootDaemon timeout after 90s. stdout=${stdoutBuf} stderr=${stderrBuf}`));
        }, 90_000);

        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString("utf8");
            const match = stdoutBuf.match(/plurnk-service agui=http:\/\/([^:]+):(\d+)/);
            if (match !== null && !settled) {
                settled = true;
                clearTimeout(timer);
                // The banner must report the BOUND port, not the configured one — booted with
                // port 0 here, so a 0 in the field means a parser downstream gets garbage.
                if (Number(match[2]) === 0) {
                    child.kill("SIGKILL");
                    rejectPromise(new Error(`banner agui= port unbound (configured-port leak): ${stdoutBuf}`));
                    return;
                }
                resolvePromise({ child, host: match[1], port: Number(match[2]), tmpdir: dir });
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });
        child.once("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(new Error(`bootDaemon: child exited before startup. code=${code} signal=${signal} stdout=${stdoutBuf} stderr=${stderrBuf}`));
        });
        child.once("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(err);
        });
    })();
});

const stopDaemon = async (booted: BootedDaemon): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
        booted.child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    booted.child.kill("SIGTERM");
    // Generous, contention-tolerant: this spawns a REAL daemon process that competes for CPU with the
    // rest of the parallel intg suite (subprocess-heavy exec tests included). Shutdown is clean and sub-second
    // in isolation; the budget exists only to absorb CPU starvation on a saturated box, not slow teardown.
    const result = await Promise.race([
        exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, reject) =>
            setTimeout(() => reject(new Error("daemon did not exit within 15s of SIGTERM")), 15_000),
        ),
    ]);
    await rm(booted.tmpdir, { recursive: true, force: true });
    return result;
};

test("bin: spawns, the AG-UI listener answers HTTP on its bound port, exits cleanly on SIGTERM", { timeout: 120_000 }, async () => {
    const booted = await bootDaemon();
    try {
        // Any HTTP response proves the module's listener is live and serving — the route
        // surface is the agui module's own contract, not this launcher smoke's business.
        const res = await fetch(`http://${booted.host}:${booted.port}/`, { signal: AbortSignal.timeout(5000) });
        assert.ok(res.status > 0, `the AG-UI listener answered HTTP (status ${res.status})`);
    } finally {
        const { code, signal } = await stopDaemon(booted);
        assert.equal(code, 0, `the service handled SIGTERM and exited zero (signal=${signal})`);
        assert.equal(signal, null, "SIGTERM was handled rather than killing the process directly");
    }
});

test("bin: --help prints usage without booting daemon", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "--help"], {
            env: { ...process.env, HOME: "/tmp/plurnk-help-home", PLURNK_SERVICE_DB_PATH: "/tmp/plurnk-help-test.db", PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
        child.once("error", rejectPromise);
        setTimeout(() => { child.kill("SIGKILL"); rejectPromise(new Error("--help timeout")); }, 5_000);
    });
    assert.equal(result.code, 0, `--help exits 0; got ${result.code}, stderr=${result.stderr}`);
    assert.match(result.stdout, /usage: plurnk-service/);
});

test("bin: a failed DB open names the path and any stale sidecars — never a bare 'disk I/O error'", async () => {
    // The classic footgun: the main DB deleted while -wal/-shm sidecars survive (often held by a
    // still-running daemon) — SQLite reports only "disk I/O error". Repro deterministically by
    // squatting a DIRECTORY on the -wal path; assert the boot error is legible: path + sidecar hint.
    const dir = await mkdtemp(join(tmpdir(), "plurnk-sidecar-"));
    try {
        const dbPath = join(dir, "plurnk.db");
        await mkdir(`${dbPath}-wal`);
        const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, rejectPromise) => {
            // same isolation as bootDaemon: the fixture's mock model must not reach the child,
            // or its provider probe stalls the boot before the DB open this test asserts on
            const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PLURNK_SERVICE_DB_PATH: dbPath, PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0", PLURNK_WS_PORT: "0" };
            delete env.PLURNK_MODEL;
            const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "start"], {
                env,
                stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
            child.once("exit", (code) => resolvePromise({ code, stderr }));
            child.once("error", rejectPromise);
            setTimeout(() => { child.kill("SIGKILL"); rejectPromise(new Error(`sidecar-boot timeout; stderr=${stderr}`)); }, 10_000);
        });
        assert.equal(result.code, 1, "a poisoned DB home fails the boot hard");
        assert.match(result.stderr, /open .*plurnk\.db failed/, "the error names the DB path");
        assert.match(result.stderr, /stale sidecar/, "the error names the surviving sidecars and the likely culprit");
        assert.match(result.stderr, /plurnk\.db-wal/, "the offending sidecar path is spelled out");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// #501 (owner ruling, gates 1.0.6) — a SET-but-unresolvable PLURNK_MODEL must fail the boot hard,
// naming the value and the contract; the old path booted silently modelless behind a warning that
// claimed the knob was unset (the operator's live daemon was doing exactly this).
test("bin: PLURNK_MODEL naming no declared alias fails the boot LOUD — never a silent modelless daemon", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-bin-501-"));
    try {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            PLURNK_SERVICE_DB_PATH: join(dir, "plurnk.db"),
            PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0",
            PLURNK_MODEL: "plurnk/jennifer",  // the run112-adjacent specimen: a provider/model PATH where an ALIAS belongs
        };
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); // cwd-isolated from ./.env like the boot smoke
        let stderrBuf = "";
        child.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
        const code = await new Promise<number | null>((res) => { child.on("exit", (c) => res(c)); });
        assert.notEqual(code, 0, "the boot FAILED — no silent modelless daemon");
        assert.match(stderrBuf, /PLURNK_MODEL=plurnk\/jennifer names no declared alias/, "the error names the VALUE and the violated contract");
        assert.match(stderrBuf, /declare PLURNK_MODEL_<alias>=plurnk\/jennifer/, "the corrective declaration form is stated");
    } finally { await rm(dir, { recursive: true, force: true }); }
});
