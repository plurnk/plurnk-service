import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeInstalledDaemon } from "./release-daemon-probe.mjs";

const fixture = fileURLToPath(new URL("./fixtures/release-daemon.mjs", import.meta.url));
const silent = () => {};

const runProbe = (env, options = {}) => probeInstalledDaemon({
    command: process.execPath,
    args: [fixture],
    cwd: import.meta.dirname,
    env: { ...process.env, ...env },
    packageName: "@plurnk/plurnk-service",
    version: "1.10.1",
    timeoutMs: 5_000,
    stopTimeoutMs: 2_000,
    writeStdout: silent,
    writeStderr: silent,
    ...options,
});

test("release probe uses a child-owned ephemeral listener and awaits graceful teardown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-release-probe-"));
    const cleanup = join(dir, "closed");
    const stale = createServer();
    try {
        await new Promise((resolve, reject) => {
            stale.once("error", reject);
            stale.listen(0, "127.0.0.1", resolve);
        });
        const address = stale.address();
        if (address === null || typeof address === "string") throw new Error("stale fixture did not bind TCP");
        const result = await runProbe({
            PLURNK_PORT: String(address.port),
            PLURNK_RELEASE_PROBE_CLEANUP: cleanup,
        });
        assert.notEqual(new URL(result.address).port, String(address.port), "operator/stale port input cannot select the probe listener");
        await access(cleanup);
    } finally {
        await new Promise((resolve) => stale.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

test("release probe rejects the spawned artifact's wrong version and still reaps it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-release-probe-version-"));
    const cleanup = join(dir, "closed");
    try {
        await assert.rejects(
            runProbe({
                PLURNK_RELEASE_PROBE_VERSION: "1.9.2",
                PLURNK_RELEASE_PROBE_CLEANUP: cleanup,
            }),
            /identified @plurnk\/plurnk-service@1\.9\.2; expected @plurnk\/plurnk-service@1\.10\.1/,
        );
        await access(cleanup);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("release probe rejects premature child exit with its exact status", async () => {
    await assert.rejects(
        runProbe({ PLURNK_RELEASE_PROBE_FIXTURE: "exit" }),
        /exited before readiness \(7\)/,
    );
});

test("release probe preserves a spawn failure instead of masking it during teardown", async () => {
    await assert.rejects(
        runProbe({}, { command: join(tmpdir(), "plurnk-missing-release-probe") }),
        { code: "ENOENT" },
    );
});

test("release probe rejects a non-AG-UI responder and still reaps the child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-release-probe-http-"));
    const cleanup = join(dir, "closed");
    try {
        await assert.rejects(
            runProbe({
                PLURNK_RELEASE_PROBE_FIXTURE: "bad-http",
                PLURNK_RELEASE_PROBE_CLEANUP: cleanup,
            }),
            /listener returned 200 text\/plain/,
        );
        await access(cleanup);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
