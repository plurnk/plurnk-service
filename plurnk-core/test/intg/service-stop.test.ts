// {§service-stop} {§daemon-launch} — `plurnk-service stop` against a real shared daemon on a private state root.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Launch, { READINESS_LINE } from "../../src/launch/Launch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const CONDITION_ARGS = process.execArgv.filter((a) => a.startsWith("--conditions"));

// Everything the daemon or the command could write lands under `home`; the operator's own service is never named.
const serviceEnv = (home: string, root: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        PLURNK_SERVICE_STATE_ROOT: root,
    };
    delete env.PLURNK_MODEL;
    delete env.PLURNK_SERVICE_DB_PATH;
    return env;
};

const stop = (env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> => new Promise((accept) => {
    const run = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "stop"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    run.stderr.setEncoding("utf8");
    run.stderr.on("data", (chunk: string) => { stderr += chunk; });
    run.once("exit", (code) => accept({ code, stderr }));
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("{§service-stop}: stop ends the service holding the configured database and returns once it has exited; a second stop finds nothing running", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-service-stop-"));
    const root = join(home, "root");
    const env = serviceEnv(home, root);
    let pid: number | undefined;
    try {
        const daemon = await Launch.start({
            command: [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"], env, lifetime: "shared",
            host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000,
        });
        pid = daemon.child.pid;
        assert.ok(pid !== undefined && alive(pid), "the shared daemon runs");
        assert.equal(daemon.logFile, join(root, "state", "plurnk", "service.log"));
        assert.match(await readFile(daemon.logFile, "utf8"), READINESS_LINE, "a shared daemon writes to the service's own log");

        const stopped = await stop(env);
        assert.equal(stopped.code, 0, stopped.stderr);
        assert.match(stopped.stderr, new RegExp(`stopped pid ${pid} \\(`, "u"));
        assert.equal(alive(pid), false, "stop returns only after the process has exited");
        await assert.rejects(access(`${daemon.dbPath}.lock`), "its lock is released");
        pid = undefined;

        const again = await stop(env);
        assert.equal(again.code, 0, "a database nobody holds is not an error");
        assert.match(again.stderr, /not running \(/u);
    } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        await rm(home, { recursive: true, force: true });
    }
});
