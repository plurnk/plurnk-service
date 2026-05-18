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

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Env cascade: .env.example (shipped defaults) < .env (project) < .env.<config> (--config)
// < shell. process.loadEnvFile is set-if-unset, so loading in low→high precedence
// order yields the right effective env.
const configFlagIndex = process.argv.findIndex((a) => a === "--config" || a.startsWith("--config="));
const configFile = (() => {
    if (configFlagIndex === -1) return null;
    const arg = process.argv[configFlagIndex];
    if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
    return process.argv[configFlagIndex + 1] ?? null;
})();

const loadEnv = (path, required) => {
    if (existsSync(path)) {
        try { process.loadEnvFile(path); }
        catch (cause) { die(64, `failed to load ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    } else if (required) {
        die(64, `--config: ${path} does not exist`);
    }
};

// Highest precedence loads FIRST (set-if-unset semantics: first write wins).
if (configFile !== null) loadEnv(configFile, true);
loadEnv(".env", false);
loadEnv(resolve(projectRoot, ".env.example"), false);

const flagDescriptors = await parseEnvExample(resolve(projectRoot, ".env.example"));
const flagOptions = {};
for (const f of flagDescriptors) {
    flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
}

const USAGE = `usage: plurnk-service [options] [migrate]

${formatFlagsHelp(flagDescriptors)}

  --config=<path>  layer additional env from <path>
  -h, --help       show this help
`;

const openDb = async (dbPath) => SqlRite.open({
    path: dbPath,
    dir: [resolve(projectRoot, "migrations"), resolve(projectRoot, "src")],
});

const migrate = async () => {
    const db = await openDb(process.env.PLURNK_DB_PATH);
    try { process.stdout.write(`migrated: ${process.env.PLURNK_DB_PATH}\n`); }
    finally { await db.close(); }
};

const loadOpenAIProvider = async () => {
    if (!process.env.OPENAI_BASE_URL) return null;
    const mod = await import("@plurnk/plurnk-providers-openai");
    return new mod.default({
        baseUrl: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY ?? "",
        model: process.env.OPENAI_MODEL ?? "",
        contextSize: Number(process.env.OPENAI_CONTEXT_SIZE ?? "8192"),
        fetchTimeoutMs: Number(process.env.OPENAI_FETCH_TIMEOUT_MS ?? "60000"),
        think: process.env.OPENAI_THINK === "1",
    });
};

const start = async () => {
    const dbPath = process.env.PLURNK_DB_PATH;
    const host = process.env.PLURNK_HOST;
    const port = Number(process.env.PLURNK_PORT);

    const db = await openDb(dbPath);
    const provider = await loadOpenAIProvider();
    const daemon = new Daemon({ db, provider });
    const addr = await daemon.start({ host, port });
    process.stdout.write(`plurnk-service ws://${addr.host}:${addr.port} db=${dbPath}\n`);

    const shutdown = async () => { await daemon.stop(); await db.close(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
};

const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: { help: { type: "boolean", short: "h" }, config: { type: "string" }, ...flagOptions },
});

for (const f of flagDescriptors) {
    const key = f.flagName.replace(/^--/, "");
    if (typeof values[key] === "string") process.env[f.envName] = values[key];
}

if (values.help) { process.stdout.write(USAGE); process.exit(0); }

const dispatch = { migrate, start };
const subcommand = positionals[0] ?? "start";
const handler = dispatch[subcommand];
if (handler === undefined) die(64, `unknown subcommand: ${subcommand}\n\n${USAGE}`);
if (positionals.length > 1) die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);

try { await handler(); }
catch (cause) {
    process.stderr.write(`${subcommand}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    if (cause instanceof Error && cause.cause) process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
    process.exit(1);
}
