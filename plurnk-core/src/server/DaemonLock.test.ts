import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DaemonLock from "./DaemonLock.ts";

test("DaemonLock permits exactly one live daemon owner and releases cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-daemon-lock-"));
    const dbPath = join(dir, "plurnk.db");
    try {
        const first = await DaemonLock.acquire(dbPath);
        await assert.rejects(
            () => DaemonLock.acquire(dbPath),
            new RegExp(`already owned by daemon pid ${process.pid}`),
        );
        await first.release();

        const second = await DaemonLock.acquire(dbPath);
        await second.release();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("DaemonLock replaces a crash-stale owner without a timeout guess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-daemon-lock-"));
    const dbPath = join(dir, "plurnk.db");
    const path = `${dbPath}.lock`;
    try {
        await writeFile(path, `${JSON.stringify({ pid: 2 ** 30, token: "dead" })}\n`, { mode: 0o600 });
        const lock = await DaemonLock.acquire(dbPath);
        const record = JSON.parse(await readFile(path, "utf8")) as { pid: number; token: string };
        assert.equal(record.pid, process.pid);
        assert.notEqual(record.token, "dead");
        await lock.release();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
