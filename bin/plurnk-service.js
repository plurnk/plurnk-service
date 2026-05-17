#!/usr/bin/env node

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Migrator from "../src/core/Migrator.ts";
import Daemon from "../src/server/Daemon.ts";

try { process.loadEnvFile(".env"); } catch { /* .env is optional */ }

const USAGE = `usage: plurnk-service <subcommand> [options]

Admin CLI for the plurnk engine library. User-facing run behavior lives
in @plurnk/plurnk (separate package).

subcommands:
  migrate    apply pending migrations against PLURNK_DB_PATH
  start      run the daemon (WebSocket RPC on PLURNK_HOST:PLURNK_PORT)
  stop       signal a running engine to shut down (not yet implemented)
  status     query the running engine's state (not yet implemented)

options:
  -h, --help   print this message and exit

env:
  PLURNK_DB_PATH   sqlite file path (required for migrate)
  PLURNK_HOST      bind address for start (default 127.0.0.1)
  PLURNK_PORT      bind port for start (default 3044)
`;

const die = (code, message) => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

const requireEnv = (name) => {
    const value = process.env[name];
    if (value === undefined || value === "") die(64, `${name} is not set. Copy .env.example to .env or export the variable in your shell.`);
    return value;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const openDb = (dbPath) => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    return db;
};

const migrate = async () => {
    const dbPath = requireEnv("PLURNK_DB_PATH");
    const dir = resolve(projectRoot, "migrations");
    const db = openDb(dbPath);
    try {
        const result = await new Migrator({ db, dir }).migrate();
        process.stdout.write(`migrate: applied ${result.applied.length}, skipped ${result.skipped.length}\n`);
        for (const id of result.applied) process.stdout.write(`  + ${id}\n`);
    } finally { db.close(); }
};

const start = async () => {
    const dbPath = requireEnv("PLURNK_DB_PATH");
    const host = process.env.PLURNK_HOST ?? "127.0.0.1";
    const port = Number(process.env.PLURNK_PORT ?? "3044");
    const dir = resolve(projectRoot, "migrations");

    const db = openDb(dbPath);
    await new Migrator({ db, dir }).migrate();
    const daemon = new Daemon({ db });
    const addr = await daemon.start({ host, port });
    process.stdout.write(`plurnk-service: listening on ws://${addr.host}:${addr.port}\n`);
    process.stdout.write(`plurnk-service: db ${dbPath}\n`);

    const shutdown = async (signal) => {
        process.stdout.write(`plurnk-service: ${signal} received; shutting down\n`);
        await daemon.stop();
        db.close();
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
};

const notYet = (subcommand) => () => die(64, `${subcommand}: not yet implemented`);

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
});

if (values.help) { process.stdout.write(USAGE); process.exit(0); }
if (positionals.length === 0) { process.stdout.write(USAGE); process.exit(64); }

const [subcommand, ...rest] = positionals;
if (rest.length > 0) die(64, `unexpected arguments: ${rest.join(" ")}\n\n${USAGE}`);

const dispatch = {
    migrate,
    start,
    stop: notYet("stop"),
    status: notYet("status"),
};

const handler = dispatch[subcommand];
if (handler === undefined) die(64, `unknown subcommand: ${subcommand}\n\n${USAGE}`);

try { await handler(); }
catch (cause) {
    process.stderr.write(`${subcommand}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    if (cause instanceof Error && cause.cause) process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
    process.exit(1);
}
