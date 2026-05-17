#!/usr/bin/env node

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Migrator from "../src/core/Migrator.ts";

try { process.loadEnvFile(".env"); } catch { /* .env is optional */ }

const USAGE = `usage: plurnk-service <subcommand> [options]

subcommands:
  migrate    apply pending migrations against PLURNK_DB_PATH
  start      boot the engine (not yet implemented)
  stop       signal a running engine to shut down (not yet implemented)
  status     query the running engine's state (not yet implemented)

options:
  -h, --help   print this message and exit

env:
  PLURNK_DB_PATH   sqlite file path (required; see .env.example)
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

const migrate = async () => {
    const dbPath = requireEnv("PLURNK_DB_PATH");
    const dir = resolve(projectRoot, "migrations");
    const db = new DatabaseSync(dbPath);
    try {
        db.exec("PRAGMA foreign_keys = ON");
        db.exec("PRAGMA journal_mode = WAL");
        const result = await new Migrator({ db, dir }).migrate();
        process.stdout.write(`migrate: applied ${result.applied.length}, skipped ${result.skipped.length}\n`);
        for (const id of result.applied) process.stdout.write(`  + ${id}\n`);
    } finally { db.close(); }
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
    start: notYet("start"),
    stop:  notYet("stop"),
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
