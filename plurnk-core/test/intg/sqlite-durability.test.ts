import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "./_launcher.ts";

const SERVICE = resolve(import.meta.dirname, "../../src/service.ts");
const BUILT_SERVICE = resolve(import.meta.dirname, "../../dist/service.js");
const PRELOAD = resolve(import.meta.dirname, "../fixtures/sqlite-durability/preload.mjs");
const CONDITIONS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));

type Posture = { synchronous: number; journal_mode: string };
type Witness = {
    writer: Posture;
    readers: Posture[];
    history: Array<Posture & { stage: string }>;
    integrity: { integrity_check: string };
};

const witness = (stderr: string): Witness => {
    const match = /^durability-witness: (.+)$/mu.exec(stderr);
    assert.ok(match, `launcher must expose the connection witness: ${stderr}`);
    return JSON.parse(match[1]!) as Witness;
};

const invoke = (dir: string, args: string[], overrides: Record<string, string> = {}, entrypoint = SERVICE) => {
    const env = { ...process.env };
    delete env.PLURNK_MODEL;
    delete env.PLURNK_SERVICE_SQLITE_SYNCHRONOUS;
    return spawnSync(process.execPath, [...(entrypoint === SERVICE ? CONDITIONS : []), `--import=${PRELOAD}`, entrypoint, ...args], {
        cwd: dir,
        env: {
            ...env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, "config"),
            XDG_DATA_HOME: join(dir, "data"),
            PLURNK_SERVICE_DB_PATH: join(dir, "plurnk.db"),
            PLURNK_SERVICE_SQLITE_READERS: "2",
            ...overrides,
        },
        encoding: "utf8",
        timeout: 30_000,
    });
};

for (const [mode, value] of [[undefined, 2], ["OFF", 0], ["NORMAL", 1], ["FULL", 2], ["EXTRA", 3]] as const) {
    test(`{§db-durability}: launcher ${mode ?? "floor"} applies before migration/INIT, on every connection and reopen`, async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const posture = { synchronous: value, journal_mode: "wal" };
        for (const opening of [0, 1]) {
            const result = invoke(dir, ["migrate"], mode === undefined ? {} : { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: mode });
            assert.equal(result.status, 0, result.stderr);
            const seen = witness(result.stderr);
            assert.deepEqual(seen.writer, posture);
            assert.deepEqual(seen.readers, [posture, posture]);
            assert.deepEqual(seen.history, ["migration", "init", "writer", ...(opening === 1 ? ["init", "writer"] : [])]
                .map((stage) => ({ stage, ...posture })));
            assert.deepEqual(seen.integrity, { integrity_check: "ok" });
        }
    });
}

test("{§db-durability}: CLI overrides the environment and reopening retains committed data", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const normal = invoke(dir, ["migrate"], { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "NORMAL" });
    assert.equal(normal.status, 0, normal.stderr);
    const full = invoke(dir, ["migrate", "--service-sqlite-synchronous=FULL"], { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "NORMAL" });
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(witness(full.stderr).history.map(({ synchronous }) => synchronous), [1, 1, 1, 2, 2]);
});

test("{§db-durability}: invalid modes are diagnosed offline and refuse database admission without blocking config inspection", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const mode of ["", "full", "2", "BROKEN"]) {
        for (const args of [["config", "check"], ["migrate"]]) {
            const result = invoke(dir, args, { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: mode });
            assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
            assert.match(result.stderr, /PLURNK_SERVICE_SQLITE_SYNCHRONOUS must be one of OFF, NORMAL, FULL, EXTRA/);
            assert.equal(existsSync(join(dir, "plurnk.db")), false, "invalid policy must not write a database");
        }
    }
    const repair = invoke(dir, ["config", "defaults"], { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "BROKEN" });
    assert.equal(repair.status, 0, repair.stderr);
    assert.match(repair.stdout, /^PLURNK_SERVICE_SQLITE_SYNCHRONOUS=FULL$/mu);
});

test("{§db-durability}: daemon startup uses the same connection policy as migrate", async () => {
    const result = await launch({
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${PRELOAD}`,
        PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "FULL",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(witness(result.stderr).writer, { synchronous: 2, journal_mode: "wal" });
    const invalid = await launch({ PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "BROKEN" });
    assert.equal(invalid.code, 1, invalid.stderr);
    assert.match(invalid.stderr, /PLURNK_SERVICE_SQLITE_SYNCHRONOUS must be one of OFF, NORMAL, FULL, EXTRA/);
    assert.equal(invalid.dbConnections, null, "invalid policy must not admit the daemon");
});

test("{§db-durability}: the built launcher applies the floor and explicit CLI policy", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const full = invoke(dir, ["migrate"], {}, BUILT_SERVICE);
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(witness(full.stderr).writer, { synchronous: 2, journal_mode: "wal" });
    const normal = invoke(dir, ["migrate", "--service-sqlite-synchronous=NORMAL"], {}, BUILT_SERVICE);
    assert.equal(normal.status, 0, normal.stderr);
    assert.deepEqual(witness(normal.stderr).history.map(({ synchronous }) => synchronous), [2, 2, 2, 1, 1]);
});
