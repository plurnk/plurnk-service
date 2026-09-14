// {§operator-config-env-defaults} — PLURNK_SERVICE_SQLITE_READERS reaches the database pool.
// The launcher is spawned for real and the pool is observed from outside: every sqlrite Worker
// holds its own connection, so the open descriptors on the database file count the Workers
// (one writer plus the readers). Parsing alone is not proof; the descriptors are.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const CONDITION_ARGS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));
const PROC = existsSync("/proc/self/fd");

type Launch = { code: number | null; stderr: string; dbConnections: number | null };

// Boots the launcher with the given overrides; on the banner, counts the connections open on
// the database file, then terminates. An exit before the banner is reported with its code.
const launch = (overrides: Readonly<Record<string, string>>): Promise<Launch> => new Promise((resolvePromise, rejectPromise) => {
    void (async () => {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-sqlite-readers-"));
        const dbPath = join(dir, "plurnk.db");
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, ".config"),
            XDG_DATA_HOME: join(dir, ".local", "share"),
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
        };
        delete env.PLURNK_MODEL;
        delete env.PLURNK_SERVICE_SQLITE_READERS;
        Object.assign(env, overrides);
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let counted = false;
        let dbConnections: number | null = null;
        const finish = async (result: Launch | Error): Promise<void> => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
            if (result instanceof Error) rejectPromise(result); else resolvePromise(result);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            void finish(new Error(`launch timeout after 90s. stdout=${stdout} stderr=${stderr}`));
        }, 90_000);
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            if (counted || !/plurnk-service agui=http:\/\//.test(stdout)) return;
            counted = true;
            void (async () => {
                const fds = await readdir(`/proc/${child.pid}/fd`);
                const targets = await Promise.all(fds.map((fd) => readlink(`/proc/${child.pid}/fd/${fd}`).catch(() => "")));
                dbConnections = targets.filter((target) => target === dbPath).length;
                child.kill("SIGTERM");
            })().catch((error: unknown) => { child.kill("SIGKILL"); void finish(error as Error); });
        });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("exit", (code) => { void finish({ code, stderr, dbConnections }); });
        child.once("error", (error) => { void finish(error); });
    })().catch(rejectPromise);
});

test("{§operator-config-env-defaults}: the shipped default is one database Worker; a positive count adds readers", { skip: PROC ? false : "no /proc on this host" }, async () => {
    const floor = await launch({});
    assert.equal(floor.dbConnections, 1, `.env.defaults ships PLURNK_SERVICE_SQLITE_READERS=0: the writer alone holds the database (stderr: ${floor.stderr})`);
    const two = await launch({ PLURNK_SERVICE_SQLITE_READERS: "2" });
    assert.equal(two.dbConnections, 3, `two readers beside the writer: three connections (stderr: ${two.stderr})`);
});

test("{§operator-config-env-defaults}: an invalid reader count fails the launcher legibly, never clamps", async () => {
    const negative = await launch({ PLURNK_SERVICE_SQLITE_READERS: "-1" });
    assert.equal(negative.code, 78, `-1 is refused, not read as "match cores" (stderr: ${negative.stderr})`);
    assert.match(negative.stderr, /PLURNK_SERVICE_SQLITE_READERS must be a non-negative integer/);
    const fraction = await launch({ PLURNK_SERVICE_SQLITE_READERS: "1.5" });
    assert.equal(fraction.code, 78);
    assert.match(fraction.stderr, /PLURNK_SERVICE_SQLITE_READERS must be an integer/);
});
