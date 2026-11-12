import assert from "node:assert/strict";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import FilePublication from "./FilePublication.ts";

test("{§file-snapshot-revision}: creating a new file as root under a non-root ancestor inherits ancestor ownership on created directories and the file", async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "plurnk-pub-owner-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = join(root, "pkg", "sub", "mod.py");
    const dirChowns: Array<{ path: string; uid: number; gid: number }> = [];
    const handleChowns: Array<{ uid: number; gid: number }> = [];

    t.mock.method(process as NodeJS.Process & { geteuid(): number }, "geteuid", () => 0);
    const realStat = fs.stat.bind(fs);
    t.mock.method(fs, "stat", (async (path: Parameters<typeof fs.stat>[0], opts?: Parameters<typeof fs.stat>[1]) => {
        const stats = await realStat(path, opts as never);
        if (String(path) === root && typeof stats === "object" && stats !== null && typeof stats.uid === "bigint") {
            return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: 60007n, gid: 60008n }) as BigIntStats;
        }
        return stats;
    }) as typeof fs.stat);
    t.mock.method(fs, "chown", async (path: Parameters<typeof fs.chown>[0], uid: number, gid: number) => {
        dirChowns.push({ path: String(path), uid, gid });
    });
    const realOpen = fs.open.bind(fs);
    t.mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (!String(args[0]).endsWith("/content")) return handle;
        const origStat = handle.stat.bind(handle);
        Object.defineProperty(handle, "stat", {
            configurable: true,
            value: async (opts?: Parameters<typeof handle.stat>[0]) => {
                const st = await origStat(opts as never);
                if (typeof st.uid === "bigint") {
                    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 0n, gid: 0n }) as BigIntStats;
                }
                return st;
            },
        });
        Object.defineProperty(handle, "chown", {
            configurable: true,
            value: async (uid: number, gid: number) => {
                handleChowns.push({ uid, gid });
            },
        });
        return handle;
    }) as typeof fs.open);

    const published = await FilePublication.write(target, target, null, Buffer.from("x = 1\n"));
    assert.equal(published.status, "published", published.status === "failed" ? String(published.cause) : "");
    assert.equal(await fs.readFile(target, "utf8"), "x = 1\n");
    assert.deepEqual(dirChowns, [
        { path: join(root, "pkg"), uid: 60007, gid: 60008 },
        { path: join(root, "pkg", "sub"), uid: 60007, gid: 60008 },
    ]);
    assert.deepEqual(handleChowns, [{ uid: 60007, gid: 60008 }]);
});
