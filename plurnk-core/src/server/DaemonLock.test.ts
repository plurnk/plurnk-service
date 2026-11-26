import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DaemonLock, { type ProcessIdentityProbe } from "./DaemonLock.ts";

test("{§session-causal-admission} DaemonLock permits exactly one live daemon owner and releases cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-daemon-lock-"));
    const dbPath = join(dir, "plurnk.db");
    try {
        const first = await DaemonLock.acquire(dbPath);
        assert.equal(await DaemonLock.owner(dbPath), process.pid);
        await assert.rejects(
            () => DaemonLock.acquire(dbPath),
            new RegExp(`already owned by daemon pid ${process.pid}`),
        );
        await first.release();
        assert.equal(await DaemonLock.owner(dbPath), null);

        const second = await DaemonLock.acquire(dbPath);
        await second.release();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§session-causal-admission} DaemonLock replaces a crash-stale owner without a timeout guess", async () => {
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

test("{§session-causal-admission} {§startup-admission} DaemonLock replaces a stale same-PID lockfile (PID 1 container restart) without self-deadlocking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-daemon-lock-pid1-"));
    const dbPath = join(dir, "plurnk.db");
    const path = `${dbPath}.lock`;
    const pid1Probe: ProcessIdentityProbe = {
        pid: 1,
        bootId: "boot-current",
        pidNamespace: "pid:[4026532999]",
        isPidAlive: () => true,
        readProcStartTime: () => "500",
    };
    try {
        await writeFile(path, `${JSON.stringify({ pid: 1, token: "crashed-previous-pid1" })}\n`, { mode: 0o600 });
        assert.equal(await DaemonLock.owner(dbPath, pid1Probe), null);
        assert.equal(await DaemonLock.status(dbPath, pid1Probe), null);

        const lock = await DaemonLock.acquire(dbPath, pid1Probe);
        try {
            const record = JSON.parse(await readFile(path, "utf8")) as {
                pid: number;
                token: string;
                bootId?: string;
                pidNamespace?: string;
                procStartTime?: string;
            };
            assert.equal(record.pid, 1);
            assert.notEqual(record.token, "crashed-previous-pid1");
            assert.equal(record.bootId, "boot-current");
            assert.equal(record.pidNamespace, "pid:[4026532999]");
            assert.equal(record.procStartTime, "500");

            assert.equal(await DaemonLock.owner(dbPath, pid1Probe), 1);
            await assert.rejects(
                () => DaemonLock.acquire(dbPath, pid1Probe),
                /already owned by daemon pid 1/u,
            );
        } finally {
            await lock.release();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§session-causal-admission} {§startup-admission} DaemonLock liveness matrix handles reboot, same-namespace PID reuse, and sibling-namespace safety", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-daemon-lock-matrix-"));
    const dbPath = join(dir, "plurnk.db");
    const path = `${dbPath}.lock`;
    const current: ProcessIdentityProbe = {
        pid: 200,
        bootId: "boot-2",
        pidNamespace: "pid:[100]",
        isPidAlive: (pid) => pid === 42,
        readProcStartTime: (pid) => (pid === 42 ? "9999" : pid === 200 ? "10000" : undefined),
    };
    try {
        // Cross-boot stale claim: PID 42 happens to be alive after reboot, but bootId differs.
        await writeFile(path, `${JSON.stringify({
            pid: 42, token: "old-boot", bootId: "boot-1", pidNamespace: "pid:[100]", procStartTime: "9999",
        })}\n`, { mode: 0o600 });
        assert.equal(await DaemonLock.owner(dbPath, current), null, "cross-boot lock is stale");
        const afterReboot = await DaemonLock.acquire(dbPath, current);
        await afterReboot.release();

        // Same-namespace PID reuse: PID 42 is alive, same boot and namespace, but starttime differs.
        await writeFile(path, `${JSON.stringify({
            pid: 42, token: "reused-pid", bootId: "boot-2", pidNamespace: "pid:[100]", procStartTime: "1111",
        })}\n`, { mode: 0o600 });
        assert.equal(await DaemonLock.owner(dbPath, current), null, "same-namespace PID reuse is stale");
        const afterReuse = await DaemonLock.acquire(dbPath, current);
        await afterReuse.release();

        // Live same-namespace owner: matching bootId, pidNamespace, and procStartTime must refuse.
        await writeFile(path, `${JSON.stringify({
            pid: 42, token: "live-peer", bootId: "boot-2", pidNamespace: "pid:[100]", procStartTime: "9999",
        })}\n`, { mode: 0o600 });
        assert.equal(await DaemonLock.owner(dbPath, current), 42);
        await assert.rejects(() => DaemonLock.acquire(dbPath, current), /already owned by daemon pid 42/u);

        // Sibling PID namespace: different pidNamespace with a live PID fails closed (never clobbers).
        await writeFile(path, `${JSON.stringify({
            pid: 42, token: "sibling-ns", bootId: "boot-2", pidNamespace: "pid:[200]", procStartTime: "1111",
        })}\n`, { mode: 0o600 });
        assert.equal(await DaemonLock.owner(dbPath, current), 42);
        await assert.rejects(() => DaemonLock.acquire(dbPath, current), /already owned by daemon pid 42/u);

        // Unreadable /proc/<pid>/stat (e.g. hidepid or non-Linux): fails closed while PID is alive.
        const opaqueProbe: ProcessIdentityProbe = {
            ...current,
            readProcStartTime: () => undefined,
        };
        await writeFile(path, `${JSON.stringify({
            pid: 42, token: "opaque-proc", bootId: "boot-2", pidNamespace: "pid:[100]", procStartTime: "1111",
        })}\n`, { mode: 0o600 });
        assert.equal(await DaemonLock.owner(dbPath, opaqueProbe), 42);
        await assert.rejects(() => DaemonLock.acquire(dbPath, opaqueProbe), /already owned by daemon pid 42/u);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§startup-admission} DaemonLock.annotate preserves internal identity fields and DaemonLock.status strips them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-daemon-lock-annotate-"));
    const dbPath = join(dir, "plurnk.db");
    const path = `${dbPath}.lock`;
    try {
        const lock = await DaemonLock.acquire(dbPath);
        try {
            const before = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
            await DaemonLock.annotate(dbPath, {
                reloadedAt: 1234,
                acpUrl: "http://127.0.0.1:1066/acp",
                route: "no model",
            });
            const after = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
            assert.equal(after.token, before.token);
            assert.equal(after.bootId, before.bootId);
            assert.equal(after.pidNamespace, before.pidNamespace);
            assert.equal(after.procStartTime, before.procStartTime);

            const status = await DaemonLock.status(dbPath);
            assert.ok(status !== null);
            assert.equal(status.pid, process.pid);
            assert.equal(status.acpUrl, "http://127.0.0.1:1066/acp");
            assert.equal("token" in status, false);
            assert.equal("bootId" in status, false);
            assert.equal("pidNamespace" in status, false);
            assert.equal("procStartTime" in status, false);
        } finally {
            await lock.release();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
