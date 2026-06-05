// Smoke coverage for bin/plurnk-service.ts. Lint and intg exercise the
// in-tree Daemon class directly; nothing today catches rot in the bin
// entrypoint (config cascade, env→arg mapping, signal handlers, the
// dynamic provider load path, the startup-line stdout format clients
// may parse). This test spawns the actual binary, waits for it to
// listen, sends one `discover` RPC, and ensures clean SIGTERM shutdown.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../bin/plurnk-service.ts");

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
            PLURNK_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",   // OS picks a free port
        };
        delete env.PLURNK_MODEL;

        const child = spawn(process.execPath, [BIN_PATH], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuf = "";
        let stderrBuf = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            rejectPromise(new Error(`bootDaemon timeout after 10s. stdout=${stdoutBuf} stderr=${stderrBuf}`));
        }, 10_000);

        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString("utf8");
            const match = stdoutBuf.match(/plurnk-service ws:\/\/([^:]+):(\d+)/);
            if (match !== null && !settled) {
                settled = true;
                clearTimeout(timer);
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
    const result = await Promise.race([
        exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, reject) =>
            setTimeout(() => reject(new Error("daemon did not exit within 5s of SIGTERM")), 5_000),
        ),
    ]);
    await rm(booted.tmpdir, { recursive: true, force: true });
    return result;
};

const rpcCall = (ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<{ result?: unknown; error?: { message: string } }> => {
    return new Promise((resolvePromise, rejectPromise) => {
        const onMessage = (data: unknown): void => {
            const parsed = JSON.parse(String(data));
            if (parsed.id === id) {
                ws.off("message", onMessage);
                resolvePromise(parsed);
            }
        };
        ws.on("message", onMessage);
        ws.once("error", rejectPromise);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
};

test("bin: spawns, listens on assigned port, accepts discover RPC, exits cleanly on SIGTERM", async () => {
    const booted = await bootDaemon();
    let ws: WebSocket | null = null;
    try {
        ws = await new Promise<WebSocket>((resolvePromise, rejectPromise) => {
            const sock = new WebSocket(`ws://${booted.host}:${booted.port}`);
            sock.once("open", () => resolvePromise(sock));
            sock.once("error", rejectPromise);
        });

        const response = await rpcCall(ws, 1, "discover");
        assert.ok(response.result, "discover returned a result");
        const cat = response.result as { methods: Record<string, unknown>; notifications: Record<string, unknown> };
        assert.ok(typeof cat.methods === "object" && cat.methods !== null, "catalog has methods");
        assert.ok(typeof cat.notifications === "object" && cat.notifications !== null, "catalog has notifications");
        assert.ok("session.create" in cat.methods, "session.create method registered");
        assert.ok("telemetry/event" in cat.notifications, "telemetry/event notification registered");
    } finally {
        if (ws !== null) ws.close();
        const { code, signal } = await stopDaemon(booted);
        assert.ok(code === 0 || signal === "SIGTERM",
            `daemon exited cleanly (code=${code} signal=${signal})`);
    }
});

test("bin: --help prints usage without booting daemon", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [BIN_PATH, "--help"], {
            env: { ...process.env, PLURNK_DB_PATH: "/tmp/plurnk-help-test.db", PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" },
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
