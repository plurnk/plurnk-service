// {§daemon-launch} — the service's launcher against the real entry: readiness by the published
// line, a private state root, stop-and-wait, and every way a start can fail without touching
// state or leaving a process behind.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import Launch, { LaunchError, READINESS_LINE } from "../../src/launch/Launch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
// Only the resolution mode crosses into spawned daemons, never the harness's own --import flags.
const CONDITION_ARGS = process.execArgv.filter((a) => a.startsWith("--conditions"));
const COMMAND = [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"];

const daemonEnv = (home: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        PLURNK_WS_PORT: "0",
    };
    delete env.PLURNK_MODEL;
    delete env.PLURNK_SERVICE_DB_PATH;
    return env;
};

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

const freePort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    await new Promise<void>((accept) => server.close(() => accept()));
    return address.port;
};

test("{§daemon-launch} {§state-root}: a private daemon publishes its address, roots its database under the state root, and stops on request", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-"));
    // A root with a space: the readiness line carries the path as a JSON string, so it parses exact.
    const root = join(home, "private world");
    try {
        const first = await Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: root, host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 });
        assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
        assert.equal(first.host, "127.0.0.1");
        assert.ok(first.port > 0);
        assert.equal(first.dbPath, join(root, "data", "plurnk", "plurnk.db"), "the database lives under the state root, never under XDG_DATA_HOME");
        assert.equal(first.route, "no model", "a modelless boot is still a ready daemon");
        assert.ok(READINESS_LINE.test(first.stdout()), "the readiness line is the contract the helper parsed");
        assert.equal(await exists(join(home, ".local", "share", "plurnk")), false, "nothing under the XDG data home");
        const response = await fetch(`${first.url}/`);
        assert.notEqual(response.status, 503, "after readiness the listener is past service-starting");
        const stopped = await first.stop();
        assert.deepEqual(stopped, { code: 0, signal: null }, "SIGTERM is a clean teardown");
        assert.deepEqual(await first.stop(), stopped, "stop is idempotent");
        assert.ok(await exists(first.dbPath), "stopping keeps the state root: retention is the launcher's decision");

        // {§state-root}: the same root re-enters the same world.
        const second = await Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: root, host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 });
        try {
            assert.equal(second.dbPath, first.dbPath);
        } finally { await second.stop(); }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("{§daemon-launch} {§startup-listener-admission}: an occupied address is an exit before readiness, with the state root untouched", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-occupied-"));
    const root = join(home, "private");
    const squatter = createServer((_request, response) => { response.statusCode = 200; response.end("not plurnk"); });
    try {
        await new Promise<void>((accept) => squatter.listen(0, "127.0.0.1", accept));
        const address = squatter.address();
        if (address === null || typeof address === "string") throw new Error("no TCP address");
        await assert.rejects(
            Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: root, host: "127.0.0.1", port: address.port, readyTimeoutMs: 60_000, stopGraceMs: 5_000 }),
            (error: unknown) => {
                assert.ok(error instanceof LaunchError);
                assert.equal(error.kind, "exited", "the daemon lost the bind and said so by exiting");
                assert.notEqual(error.code, 0);
                assert.match(error.stderr, /EADDRINUSE|address/u, "the stderr carries the originating address error");
                return true;
            },
        );
        assert.equal(await exists(root), false, "a lost bind race touches no durable state: the launcher decides nothing about the root");
    } finally {
        await new Promise<void>((accept) => squatter.close(() => accept()));
        await rm(home, { recursive: true, force: true });
    }
});

test("{§daemon-launch}: two simultaneous starters on one address — one is ready, the other exits", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-race-"));
    const port = await freePort();
    try {
        const settled = await Promise.allSettled([1, 2].map((n) =>
            Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: join(home, `private-${n}`), host: "127.0.0.1", port, readyTimeoutMs: 60_000, stopGraceMs: 5_000 })));
        const ready = settled.filter((result) => result.status === "fulfilled");
        const lost = settled.filter((result) => result.status === "rejected");
        assert.equal(ready.length, 1, "exactly one daemon owns the address");
        assert.equal(lost.length, 1);
        assert.ok(lost[0]!.status === "rejected" && lost[0]!.reason instanceof LaunchError && lost[0]!.reason.kind === "exited");
        for (const result of ready) if (result.status === "fulfilled") await result.value.stop();
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("{§daemon-launch}: a start that never becomes ready is stopped, awaited and reported as a timeout, leaving no process", { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-timeout-"));
    try {
        let child: import("node:child_process").ChildProcess | undefined;
        await assert.rejects(
            Launch.start({
                command: [process.execPath, "-e", "process.stdout.write('starting but never ready\\n'); setTimeout(() => {}, 60_000)"],
                env: daemonEnv(home), readyTimeoutMs: 1_000, stopGraceMs: 1_000,
                onOutput: () => {},
            }).then((daemon) => { child = daemon.child; return daemon; }),
            (error: unknown) => {
                assert.ok(error instanceof LaunchError);
                assert.equal(error.kind, "timeout");
                assert.match(error.stdout, /starting but never ready/u, "what the process did say is carried");
                return true;
            },
        );
        assert.equal(child, undefined, "a timed-out start never hands out a daemon; the helper stopped and awaited it before throwing");
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("{§daemon-launch}: an executable that cannot be spawned is a spawn failure, not a hang", { timeout: 30_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-spawn-"));
    try {
        await assert.rejects(
            Launch.start({ command: [join(home, "no-such-executable"), "start"], env: daemonEnv(home), readyTimeoutMs: 5_000, stopGraceMs: 1_000 }),
            (error: unknown) => error instanceof LaunchError && error.kind === "spawn",
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("{§startup-readiness-line}: an IPv6 host is bracketed in the published URL and parsed back as the host", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-v6-"));
    try {
        const daemon = await Launch.start({ command: COMMAND, env: daemonEnv(home), stateRoot: join(home, "private"), host: "::1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 });
        try {
            assert.match(daemon.url, /^http:\/\/\[::1\]:\d+$/u);
            assert.equal(daemon.host, "[::1]");
            assert.ok(daemon.port > 0);
            const response = await fetch(`${daemon.url}/`);
            assert.notEqual(response.status, 503);
        } finally { await daemon.stop(); }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const untilGone = async (pid: number, deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (alive(pid)) {
        if (Date.now() > deadline) return false;
        await new Promise((accept) => setTimeout(accept, 100));
    }
    return true;
};

test("{§daemon-launch}: a shared daemon logs to its file, is released at readiness, and survives the launcher that started it", { timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-shared-"));
    const logFile = join(home, "service.log");
    const launcher = join(home, "launcher.mjs");
    let pid: number | undefined;
    try {
        // The launcher is a separate process that starts a shared daemon and exits without stopping it.
        const options = { command: COMMAND, env: daemonEnv(home), stateRoot: join(home, "private"), lifetime: "shared", logFile, host: "127.0.0.1", port: 0, readyTimeoutMs: 60_000, stopGraceMs: 5_000 };
        await writeFile(launcher, [
            `import Launch from ${JSON.stringify(pathToFileURL(resolve(here, "../../src/launch/Launch.ts")).href)};`,
            `const daemon = await Launch.start(${JSON.stringify(options)});`,
            "process.stdout.write(JSON.stringify({ pid: daemon.child.pid, url: daemon.url, dbPath: daemon.dbPath, sawLine: daemon.stdout().includes('plurnk-service agui=') }));",
        ].join("\n"));
        const run = spawn(process.execPath, [...CONDITION_ARGS, launcher], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        run.stdout.setEncoding("utf8"); run.stderr.setEncoding("utf8");
        run.stdout.on("data", (chunk: string) => { out += chunk; });
        run.stderr.on("data", (chunk: string) => { err += chunk; });
        const ended = await new Promise<{ code: number | null }>((accept) => run.once("exit", (code) => accept({ code })));
        assert.equal(ended.code, 0, `the launcher exited on its own once the daemon was ready (a released daemon holds no event-loop handle)\n${err}`);
        const report = JSON.parse(out) as { pid: number; url: string; dbPath: string; sawLine: boolean };
        pid = report.pid;
        assert.ok(report.sawLine, "readiness was read from the log file");
        assert.equal(report.dbPath, join(home, "private", "data", "plurnk", "plurnk.db"));
        assert.ok(alive(pid), "the daemon outlives its launcher");
        const response = await fetch(`${report.url}/`);
        assert.notEqual(response.status, 503, "and still answers");
        assert.match(await readFile(logFile, "utf8"), READINESS_LINE, "the daemon's output is in the caller's log, not in a departed launcher");
        process.kill(pid, "SIGTERM");
        assert.ok(await untilGone(pid, 10_000), "SIGTERM by pid still ends it");
        pid = undefined;
    } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        await rm(home, { recursive: true, force: true });
    }
});

test("{§daemon-launch}: a shared start that exits before readiness is owned to the end and reports the log's last words", { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-launch-shared-exit-"));
    const logFile = join(home, "service.log");
    try {
        await assert.rejects(
            Launch.start({
                command: [process.execPath, "-e", "process.stderr.write('admission refused\\n'); process.exit(17)"],
                env: daemonEnv(home), lifetime: "shared", logFile, readyTimeoutMs: 10_000, stopGraceMs: 1_000,
            }),
            (error: unknown) => {
                assert.ok(error instanceof LaunchError);
                assert.equal(error.kind, "exited");
                assert.equal(error.code, 17);
                assert.match(error.stdout, /admission refused/u, "both streams of a shared daemon land in the log, and the failure carries what it said");
                return true;
            },
        );
        await assert.rejects(Launch.start({ command: COMMAND, env: daemonEnv(home), lifetime: "shared", readyTimeoutMs: 1, stopGraceMs: 1 }), /needs a logFile/u);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
