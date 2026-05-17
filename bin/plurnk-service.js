#!/usr/bin/env node

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Migrator from "../src/core/Migrator.ts";
import Engine from "../src/core/Engine.ts";
import SchemeRegistry from "../src/core/SchemeRegistry.ts";
import OpenAI from "@plurnk/plurnk-providers-openai";

try { process.loadEnvFile(".env"); } catch { /* .env is optional */ }

const USAGE = `usage: plurnk-service <subcommand> [options]

subcommands:
  start <prompt>   run a single loop against the configured provider with <prompt>
  migrate          apply pending migrations against PLURNK_DB_PATH
  stop             signal a running engine to shut down (not yet implemented)
  status           query the running engine's state (not yet implemented)

options:
  -h, --help   print this message and exit

env (all required for start):
  PLURNK_DB_PATH        sqlite file path
  PLURNK_MAX_TURNS      loop safety cap
  OPENAI_BASE_URL       provider endpoint
  OPENAI_API_KEY        provider auth (empty for local)
  OPENAI_MODEL          model id
  OPENAI_CONTEXT_SIZE   provider context window in tokens
  OPENAI_FETCH_TIMEOUT_MS  request timeout in ms
  OPENAI_THINK          1 to enable provider reasoning toggle, else 0
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

const start = async (prompt) => {
    if (prompt === undefined || prompt.length === 0) die(64, "start: missing <prompt> argument\n\n" + USAGE);

    const dbPath = requireEnv("PLURNK_DB_PATH");
    const maxTurns = Number(requireEnv("PLURNK_MAX_TURNS"));
    const model = requireEnv("OPENAI_MODEL");

    const dir = resolve(projectRoot, "migrations");
    const systemPrompt = await readFile(resolve(projectRoot, "instructions-system.md"), "utf8");

    const db = openDb(dbPath);
    try {
        await new Migrator({ db, dir }).migrate();

        const sessionName = `${model.replace(/\.[^/]+$/, "")}-${Math.floor(Date.now() / 1000)}`;
        const sessionId = db.prepare("INSERT INTO sessions (name) VALUES (?) RETURNING id").get(sessionName).id;
        const runId = db.prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id").get(sessionId).id;
        const loopId = db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, 1, ?) RETURNING id").get(runId, prompt).id;

        const provider = new OpenAI({
            baseUrl: requireEnv("OPENAI_BASE_URL"),
            apiKey: process.env.OPENAI_API_KEY ?? "",
            model,
            contextSize: Number(requireEnv("OPENAI_CONTEXT_SIZE")),
            fetchTimeoutMs: Number(requireEnv("OPENAI_FETCH_TIMEOUT_MS")),
            think: requireEnv("OPENAI_THINK") === "1",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        process.stdout.write(`session: ${sessionName} (id=${sessionId})\n`);
        process.stdout.write(`run: ${runId} | loop: ${loopId}\n`);
        process.stdout.write(`provider: ${provider.baseUrl} (${provider.model}, ${provider.contextSize} ctx)\n`);
        process.stdout.write(`prompt: ${prompt}\n\n`);

        const start = Date.now();
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
            ],
        });
        const elapsed = Date.now() - start;

        for (const [i, turnId] of result.turnIds.entries()) {
            const turn = db.prepare("SELECT status, packet, usage_completion FROM turns WHERE id = ?").get(turnId);
            const packet = JSON.parse(turn.packet);
            process.stdout.write(`--- turn ${i + 1} (status ${turn.status}, ${turn.usage_completion} tokens) ---\n`);
            process.stdout.write(packet.assistant.content);
            process.stdout.write("\n\n");
        }

        const entries = db.prepare("SELECT scheme, pathname FROM entries WHERE session_id = ? ORDER BY pathname").all(sessionId);
        process.stdout.write(`--- final ---\n`);
        process.stdout.write(`final status: ${result.finalStatus}${result.hitMaxTurns ? " (maxTurns reached)" : ""}\n`);
        process.stdout.write(`turns: ${result.turnIds.length}, wall: ${(elapsed / 1000).toFixed(2)}s\n`);
        if (entries.length > 0) {
            process.stdout.write(`entries written:\n`);
            for (const e of entries) process.stdout.write(`  ${e.scheme}://${e.pathname}\n`);
        }

        if (result.finalStatus === 200) return;
        if (result.hitMaxTurns) die(2, "loop hit maxTurns");
        die(3, `loop ended non-success (${result.finalStatus})`);
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

const dispatch = {
    migrate: () => { if (rest.length > 0) die(64, `migrate takes no arguments`); return migrate(); },
    start: () => start(rest.join(" ")),
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
