// Smoke coverage for src/service.ts (the plurnk-service launcher). Lint and intg
// exercise the in-tree Daemon class directly; nothing else catches rot in the
// entrypoint (config cascade, env→arg mapping, signal handlers, the dynamic
// provider load path, the startup-line stdout format clients may parse). This test
// spawns the actual entry, waits for the one AG-UI+ client listener
// ({§agui-daemon-client}), probes it over HTTP, and ensures clean SIGTERM shutdown.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { insertWorkspace, openMigrated } from "./_helpers.ts";

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

interface BootPaths {
    readonly dir: string;
    readonly dbPath: string;
}

const bootDaemon = (
    prepare?: (paths: BootPaths) => Promise<NodeJS.ProcessEnv | void>,
): Promise<BootedDaemon> => new Promise((resolvePromise, rejectPromise) => {
    void (async () => {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-bin-smoke-"));
        const dbPath = join(dir, "plurnk.db");
        const overrides = await prepare?.({ dir, dbPath }) ?? {};
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, ".config"),
            XDG_DATA_HOME: join(dir, ".local", "share"),
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",      // the AG-UI+ surface — THE listener; OS picks a free port
            ...overrides,
        };
        delete env.PLURNK_MODEL;

        // cwd isolation, same reason as HOME: the service cascade loads ./.env (operator config,
        // the owner's surface) — an inherited cwd leaks the box's model selector into this
        // hermetic tier and can introduce unrelated provider credential requirements ({§operator-config}).
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuf = "";
        let stderrBuf = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            // 90s, below the test's own 120s timeout: concurrent lanes drill on one box, so a
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
    })().catch(rejectPromise);
});

const action = async (
    booted: BootedDaemon,
    kind: string,
    params: Readonly<Record<string, unknown>> = {},
    threadId = "startup-specimen",
    workspace?: string,
): Promise<unknown> => {
    const response = await fetch(`http://${booted.host}:${booted.port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            runId: crypto.randomUUID(),
            threadId,
            state: {},
            messages: [],
            tools: [],
            context: [],
            forwardedProps: {
                plurnk: {
                    ...(workspace === undefined ? {} : { workspace }),
                    action: { kind, ...params },
                },
            },
        }),
    });
    assert.equal(response.status, 200);
    const frames = (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as {
            type?: string;
            name?: string;
            value?: { ok?: boolean; result?: unknown; problem?: unknown };
        });
    const outcome = frames.find(({ type, name }) =>
        type === "CUSTOM" && name === "plurnk.action.result")?.value;
    assert.equal(outcome?.ok, true, `action ${kind} failed: ${JSON.stringify(outcome?.problem)}`);
    return outcome?.result;
};

const markerLines = async (path: string): Promise<string[]> => {
    try {
        return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
};

const waitForMarkerLines = async (path: string): Promise<string[]> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const lines = await markerLines(path);
        if (lines.length > 0) return lines;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.fail(`marker ${path} remained empty`);
};

const waitForExit = async (pids: readonly number[]): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const alive = pids.filter((pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
                throw error;
            }
        });
        if (alive.length === 0) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.fail(`processes remained alive: ${pids.join(", ")}`);
};

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

test("bin: persisted and attached workspaces stay cold until capability demand", { timeout: 120_000 }, async () => {
    let startMarker = "";
    const booted = await bootDaemon(async ({ dir, dbPath }) => {
        const db = await openMigrated(dbPath);
        try {
            await insertWorkspace(db, "cold-one");
            await insertWorkspace(db, "cold-two");
            await insertWorkspace(db, "cold-three");
        } finally {
            await db.close();
        }
        startMarker = join(dir, "mcp-starts.txt");
        return {
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([
                resolve(here, "../../../plurnk-mcp/src/fixtures/echo-server.mjs"),
            ]),
            PLURNK_MCP_ECHO_ENV: JSON.stringify({
                PLURNK_MCP_TEST_START_MARKER: startMarker,
            }),
            PLURNK_MCP_ENABLED: JSON.stringify(["echo"]),
        };
    });
    try {
        assert.deepEqual(
            await markerLines(startMarker),
            [],
            "global boot must not launch one enabled MCP process per dormant workspace",
        );
        await action(booted, "workspace.attach", { id: 1 });
        assert.deepEqual(
            await markerLines(startMarker),
            [],
            "attachment must not launch the configured MCP endpoint",
        );
        await action(booted, "workspace.mcp.list", {}, "cold-one", "cold-one");
        const firstActivationStarts = (await markerLines(startMarker)).length;
        assert.ok(
            firstActivationStarts > 0,
            "first demand opens the configured MCP endpoint",
        );
        await action(booted, "workspace.mcp.list", {}, "cold-one", "cold-one");
        assert.equal(
            (await markerLines(startMarker)).length,
            firstActivationStarts,
            "an already-active workspace remains warm instead of reconnecting",
        );
    } finally {
        await stopDaemon(booted);
    }
});

test("bin: SIGTERM interrupts capability-demand activation and reaps its MCP process", { timeout: 120_000 }, async () => {
    let startMarker = "";
    const booted = await bootDaemon(async ({ dir, dbPath }) => {
        const db = await openMigrated(dbPath);
        try {
            await insertWorkspace(db, "activation-stop");
        } finally {
            await db.close();
        }
        startMarker = join(dir, "mcp-starts.txt");
        return {
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([
                resolve(here, "../../../plurnk-mcp/src/fixtures/echo-server.mjs"),
            ]),
            PLURNK_MCP_ECHO_ENV: JSON.stringify({
                PLURNK_MCP_TEST_START_MARKER: startMarker,
                PLURNK_MCP_TEST_START_DELAY_MS: "30000",
            }),
            PLURNK_MCP_ENABLED: JSON.stringify(["echo"]),
        };
    });
    let stopped = false;
    try {
        await action(booted, "workspace.attach", { id: 1 });
        assert.deepEqual(await markerLines(startMarker), [], "attachment remains passive");
        const demand = action(
            booted,
            "workspace.mcp.list",
            {},
            "activation-stop",
            "activation-stop",
        ).catch((error: unknown) => error);
        const pids = (await waitForMarkerLines(startMarker)).map(Number);
        const { code, signal } = await stopDaemon(booted);
        stopped = true;
        assert.equal(code, 0, `SIGTERM during activation exits zero (signal=${signal})`);
        assert.equal(signal, null, "the daemon handled SIGTERM during activation");
        await Promise.race([
            demand,
            new Promise<never>((_resolvePromise, rejectPromise) =>
                setTimeout(() => rejectPromise(new Error("capability demand did not settle after daemon shutdown")), 2_000)),
        ]);
        await waitForExit(pids);
    } finally {
        if (!stopped) await stopDaemon(booted);
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
            // {§startup-admission-order}: the independently broken provider is a
            // witness that database admission fails before provider initialization.
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                HOME: dir,
                PLURNK_SERVICE_DB_PATH: dbPath,
                PLURNK_HOST: "127.0.0.1",
                PLURNK_PORT: "0",
                PLURNK_WS_PORT: "0",
                PLURNK_MODEL: "dbguard",
                PLURNK_MODEL_dbguard: "missing/model",
            };
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
        assert.doesNotMatch(result.stderr, /unknown provider "missing"/, "provider initialization was never reached");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("bin: provider initialization failure closes the admitted database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-provider-startup-"));
    try {
        const dbPath = join(dir, "plurnk.db");
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            PLURNK_MODEL: "broken",
            PLURNK_MODEL_broken: "missing/model",
        };
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "start"], {
            env,
            cwd: dir,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                rejectPromise(new Error(`provider-startup timeout; stderr=${stderr}`));
            }, 10_000);
            child.once("exit", (code, signal) => {
                clearTimeout(timer);
                resolvePromise({ code, signal });
            });
            child.once("error", (cause) => {
                clearTimeout(timer);
                rejectPromise(cause);
            });
        });
        assert.equal(result.code, 1, `provider initialization fails startup (signal=${result.signal})`);
        assert.match(stderr, /unknown provider "missing"/, "the originating provider failure is preserved");
        await access(dbPath);
        await assert.rejects(
            access(`${dbPath}.lock`),
            { code: "ENOENT" },
            "the admitted database owner is closed and its lock released",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("bin: observability initialization failure closes the admitted database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-observe-startup-"));
    try {
        const dbPath = join(dir, "plurnk.db");
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            OTEL_TRACES_EXPORTER: "unsupported",
            OTEL_METRICS_EXPORTER: "none",
        };
        delete env.PLURNK_MODEL;
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "start"], {
            env,
            cwd: dir,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                rejectPromise(new Error(`observability-startup timeout; stderr=${stderr}`));
            }, 10_000);
            child.once("exit", (code, signal) => {
                clearTimeout(timer);
                resolvePromise({ code, signal });
            });
            child.once("error", (cause) => {
                clearTimeout(timer);
                rejectPromise(cause);
            });
        });
        assert.equal(result.code, 1, `observability initialization fails startup (signal=${result.signal})`);
        assert.match(stderr, /unsupported OTEL_TRACES_EXPORTER value "unsupported"/);
        await access(dbPath);
        await assert.rejects(
            access(`${dbPath}.lock`),
            { code: "ENOENT" },
            "the admitted database owner is closed and its lock released",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// {§provider-resolution}: a set-but-unresolvable PLURNK_MODEL fails boot naming the value;
// it never degrades to a silently modelless daemon.
test("bin: a malformed exact PLURNK_MODEL route fails boot loudly", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-bin-model-"));
    try {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            PLURNK_SERVICE_DB_PATH: join(dir, "plurnk.db"),
            PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0",
            PLURNK_MODEL: "plurnk/",
        };
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); // cwd-isolated from ./.env like the boot smoke
        let stderrBuf = "";
        child.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
        const code = await new Promise<number | null>((res) => { child.on("exit", (c) => res(c)); });
        assert.notEqual(code, 0, "the boot FAILED — no silent modelless daemon");
        assert.match(stderrBuf, /PLURNK_MODEL 'plurnk\/' is neither a declared alias nor a provider\/model route/, "the error names the value and selector contract");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bin: PLURNK_MODEL_CHILD must resolve as an alias or exact route", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-bin-child-model-"));
    try {
        const missing = `missing-${crypto.randomUUID()}`;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            PLURNK_SERVICE_DB_PATH: join(dir, "plurnk.db"),
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            PLURNK_MODEL_CHILD: missing,
        };
        delete env.PLURNK_MODEL;
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        const code = await new Promise<number | null>((resolvePromise) => { child.on("exit", resolvePromise); });
        assert.notEqual(code, 0);
        assert.match(stderr, new RegExp(`PLURNK_MODEL_CHILD=${missing} is neither a declared alias nor a provider/model route`));
        assert.match(stderr, /Unset it to inherit\./);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
