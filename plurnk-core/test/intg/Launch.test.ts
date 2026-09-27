// {§daemon-launch} — the service's launcher against the real entry: readiness by the published
// line, a private state root, stop-and-wait, and every way a start can fail without touching
// state or leaving a process behind.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    const root = join(home, "private");
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
