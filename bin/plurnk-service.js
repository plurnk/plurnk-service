#!/usr/bin/env node

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import SqlRite from "@possumtech/sqlrite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Daemon from "../src/server/Daemon.ts";
import { parseEnvExample, formatFlagsHelp } from "../src/core/EnvFlags.ts";

const die = (code, message) => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

// --config=<path> wins over default .env. Pre-parse before parseArgs runs
// so the loaded env informs the rest of bootstrap.
const envFlagIndex = process.argv.findIndex((a) => a === "--config" || a.startsWith("--config="));
const envFile = (() => {
    if (envFlagIndex === -1) return ".env";
    const arg = process.argv[envFlagIndex];
    if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
    return process.argv[envFlagIndex + 1] ?? ".env";
})();
if (existsSync(envFile)) {
    try { process.loadEnvFile(envFile); }
    catch (cause) { die(64, `--config: failed to load ${envFile}: ${cause instanceof Error ? cause.message : String(cause)}`); }
} else if (envFlagIndex !== -1) {
    die(64, `--config: ${envFile} does not exist`);
}
// default .env is optional

const requireEnv = (name) => {
    const value = process.env[name];
    if (value === undefined || value === "") die(64, `${name} is not set. Copy .env.example to .env or export the variable in your shell.`);
    return value;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const flagDescriptors = await parseEnvExample(resolve(projectRoot, ".env.example"));
const flagOptions = {};
for (const f of flagDescriptors) {
    flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
}

const USAGE = `usage: plurnk-service <subcommand> [options]

Admin CLI for the plurnk service. User-facing CLI/TUI lives in
@plurnk/plurnk (separate package).

subcommands:
  migrate    apply pending migrations against PLURNK_DB_PATH
  start      run the daemon (WebSocket RPC on PLURNK_HOST:PLURNK_PORT)

${formatFlagsHelp(flagDescriptors)}

  --config=<path>  load env from <path> instead of ./.env
  -h, --help       print this message and exit
`;

const openDb = async (dbPath) => {
    return await SqlRite.open({
        path: dbPath,
        dir: [resolve(projectRoot, "migrations"), resolve(projectRoot, "src")],
    });
};

const migrate = async () => {
    const dbPath = requireEnv("PLURNK_DB_PATH");
    // SqlRite runs -- INIT: blocks on open; opening IS the migration.
    const db = await openDb(dbPath);
    try {
        process.stdout.write(`migrate: schema applied against ${dbPath}\n`);
    } finally { await db.close(); }
};

const loadOpenAIProvider = async () => {
    if (process.env.OPENAI_BASE_URL === undefined || process.env.OPENAI_BASE_URL === "") {
        return null;
    }
    try {
        const mod = await import("@plurnk/plurnk-providers-openai");
        const OpenAI = mod.default;
        const provider = new OpenAI({
            baseUrl: process.env.OPENAI_BASE_URL,
            apiKey: process.env.OPENAI_API_KEY ?? "",
            model: process.env.OPENAI_MODEL ?? "",
            contextSize: Number(process.env.OPENAI_CONTEXT_SIZE ?? "8192"),
            fetchTimeoutMs: Number(process.env.OPENAI_FETCH_TIMEOUT_MS ?? "60000"),
            think: process.env.OPENAI_THINK === "1",
        });
        process.stdout.write(`plurnk-service: provider openai (${process.env.OPENAI_MODEL ?? "<model unset>"})\n`);
        return provider;
    } catch (cause) {
        process.stderr.write(`plurnk-service: failed to load OpenAI provider: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        return null;
    }
};

const start = async () => {
    const dbPath = requireEnv("PLURNK_DB_PATH");
    const host = process.env.PLURNK_HOST ?? "127.0.0.1";
    const port = Number(process.env.PLURNK_PORT ?? "3044");

    const db = await openDb(dbPath);
    const provider = await loadOpenAIProvider();
    const daemon = new Daemon({ db, provider });
    const addr = await daemon.start({ host, port });
    process.stdout.write(`plurnk-service: listening on ws://${addr.host}:${addr.port}\n`);
    process.stdout.write(`plurnk-service: db ${dbPath}\n`);

    const shutdown = async (signal) => {
        process.stdout.write(`plurnk-service: ${signal} received; shutting down\n`);
        await daemon.stop();
        await db.close();
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
};

const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: { help: { type: "boolean", short: "h" }, "env-file": { type: "string" }, ...flagOptions },
});

for (const f of flagDescriptors) {
    const key = f.flagName.replace(/^--/, "");
    if (typeof values[key] === "string") {
        process.env[f.envName] = values[key];
    }
}

if (values.help) { process.stdout.write(USAGE); process.exit(0); }
if (positionals.length === 0) { process.stdout.write(USAGE); process.exit(64); }

const [subcommand, ...rest] = positionals;
if (rest.length > 0) die(64, `unexpected arguments: ${rest.join(" ")}\n\n${USAGE}`);

const dispatch = { migrate, start };

const handler = dispatch[subcommand];
if (handler === undefined) die(64, `unknown subcommand: ${subcommand}\n\n${USAGE}`);

try { await handler(); }
catch (cause) {
    process.stderr.write(`${subcommand}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    if (cause instanceof Error && cause.cause) process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
    process.exit(1);
}
