// {§operator-config-env-defaults} — PLURNK_SERVICE_SQLITE_READERS reaches the database pool.
// The launcher is spawned for real and the pool is observed from outside: every sqlrite Worker
// holds its own connection, so the open descriptors on the database file count the Workers
// (one writer plus the readers). Parsing alone is not proof; the descriptors are.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { launch } from "./_launcher.ts";

const PROC = existsSync("/proc/self/fd");

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
