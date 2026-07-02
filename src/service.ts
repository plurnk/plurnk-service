#!/usr/bin/env node

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import SqlRite from "@possumtech/sqlrite";
import type { Db } from "./core/Db.ts";
import Daemon from "./server/Daemon.ts";
import EnvFlags from "./core/EnvFlags.ts";
import ProviderInstantiate from "./core/ProviderInstantiate.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";

// The `plurnk-service` executable: launches the daemon (start) or runs migrations.
// Not the user-facing client — that is the separate `plurnk` project.
export default class Service {
    // This file's own directory holds the runtime code + its .sql (src/ in dev, dist/ in a
    // published install); its parent is the package root (migrations/, requirements.md, .env.example).
    static #codeDir = dirname(fileURLToPath(import.meta.url));
    static #projectRoot = resolve(Service.#codeDir, "..");
    static #ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    static #homeDir = resolve(homedir(), ".plurnk");

    // First-run bootstrap — run-time, NOT an install script: seed ~/.plurnk so a global
    // install has a stable home for config + the DB. Idempotent (only acts when absent).
    static #ensureHome(): void {
        // Seed ONCE, on first run (the home is absent). After that the user owns ~/.plurnk —
        // edits and deletions stick, no silent re-seed. `~/.plurnk/.env.example` is the cascade
        // FLOOR (the visible legend); the node_modules copy is the seed + CLI-flag source only.
        // Wiping the whole dir is a deliberate reset. A deleted floor stays deleted; a missing
        // required knob then surfaces as a clear `missing PLURNK_X` error, not a crash.
        if (existsSync(Service.#homeDir)) return;
        mkdirSync(Service.#homeDir, { recursive: true });
        const shipped = resolve(Service.#projectRoot, ".env.example");
        if (existsSync(shipped)) copyFileSync(shipped, resolve(Service.#homeDir, ".env.example"));
        // The first-run model selection lives HERE, as commented peers — an honest surfaced
        // choice (no active default ships; #307). One uncomment per option; agents read this
        // file as naturally as humans do.
        writeFileSync(resolve(Service.#homeDir, ".env"), [
            "# plurnk config — overrides the shipped defaults (~/.plurnk/.env.example is the legend).",
            "#",
            "# Pick a model — uncomment ONE block:",
            "#",
            "# LOCAL — your own llama-server / any OpenAI-compatible endpoint:",
            "# PLURNK_MODEL_local=\"openai/gemma\"",
            "# OPENAI_BASE_URL=http://127.0.0.1:11434",
            "# PLURNK_MODEL=local",
            "#",
            "# CLOUD — bring your own key, any openrouter model:",
            "# PLURNK_MODEL_cloud=\"openrouter/qwen/qwen3-coder\"",
            "# OPENROUTER_API_KEY=\"...\"",
            "# PLURNK_MODEL=cloud",
            "#",
            "# PLURNK.AI — the hosted relay (free tier: https://plurnk.ai):",
            "# PLURNK_MODEL_plurnk=\"plurnk/plurnk\"",
            "# PLURNK_API_KEY=\"...\"",
            "# PLURNK_MODEL=plurnk",
            "",
        ].join("\n"));
        // Seed the default operating policy → ~/.plurnk/AGENTS.md, foisted as ## Plurnk Service Policy
        // (readSystemPolicy). A new install opens with a sane disposition, not a blank policy; the user
        // owns + edits it after — a deleted policy stays deleted, like the .env floor.
        const shippedPolicy = resolve(Service.#projectRoot, "PLURNK_PERSONALITY.md");
        if (existsSync(shippedPolicy)) copyFileSync(shippedPolicy, resolve(Service.#homeDir, "AGENTS.md"));
        process.stderr.write(`plurnk-service: created ${Service.#homeDir} — config in ${resolve(Service.#homeDir, ".env")}\n`);
    }

    static #expandHome(p: string): string {
        if (p === "~") return homedir();
        return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
    }

    // The node_modules holding the service's plugin deps (exec/scheme/mimetype), resolved
    // package-relative so a global install finds them regardless of run-CWD. Falls back to CWD.
    static #pluginsNodeModules(): string {
        try {
            const execs = createRequire(import.meta.url).resolve("@plurnk/plurnk-execs/package.json");
            return resolve(dirname(execs), "..", "..");
        } catch {
            return resolve(process.cwd(), "node_modules");
        }
    }

    static #die(code: number, message: string): never {
        process.stderr.write(`${message}\n`);
        process.exit(code);
    }

    static #loadEnv(path: string, required: boolean): void {
        if (existsSync(path)) {
            try { process.loadEnvFile(path); }
            catch (cause) { Service.#die(64, `failed to load ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        } else if (required) {
            Service.#die(64, `${path} does not exist`);
        }
    }

    // node-style env-file flags: --env-file=<path> (required) / --env-file-if-exists=<path>
    // (skip if missing), repeatable, in command-line order. node only loads pre-script files;
    // a published `plurnk-service --env-file=…` needs this post-script loader.
    static #envFileArgs(): Array<{ path: string; required: boolean }> {
        return process.argv.flatMap((a): Array<{ path: string; required: boolean }> => {
            if (a.startsWith("--env-file-if-exists=")) return [{ path: a.slice(a.indexOf("=") + 1), required: false }];
            if (a.startsWith("--env-file=")) return [{ path: a.slice(a.indexOf("=") + 1), required: true }];
            return [];
        });
    }

    static #requireEnv(name: string): string {
        const value = process.env[name];
        if (value === undefined || value.length === 0) Service.#die(78, `missing required env ${name} (declare it in .env.example)`);
        return value;
    }

    static #sqliteKnob(name: string): number | undefined {
        const raw = process.env[name];
        if (raw === undefined || raw.trim() === "") return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n)) Service.#die(78, `${name} must be an integer, got ${JSON.stringify(raw)}`);
        return n;
    }

    static async #openDb(dbPath: string): Promise<Db> {
        const tuning: Record<string, number> = {};
        for (const [env, opt] of [
            ["PLURNK_SQLITE_TIMEOUT", "timeout"],
            ["PLURNK_SQLITE_CACHE_SIZE", "cacheSize"],
            ["PLURNK_SQLITE_MMAP_SIZE", "mmapSize"],
            ["PLURNK_SQLITE_MAX_PAGE_COUNT", "maxPageCount"],
        ] as const) {
            const v = Service.#sqliteKnob(env);
            if (v !== undefined) tuning[opt] = v;
        }
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = await SqlRite.open({
            path: dbPath,
            dir: [resolve(Service.#projectRoot, "migrations"), Service.#codeDir],
            functions: [resolve(Service.#codeDir, `schemes/cosine${Service.#ext}`)],
            ...tuning,
        });
        return db as unknown as Db;
    }

    static async #migrate(): Promise<void> {
        const dbPath = Service.#expandHome(Service.#requireEnv("PLURNK_DB_PATH"));
        const db = await Service.#openDb(dbPath);
        try { process.stdout.write(`migrated: ${dbPath}\n`); }
        finally { await db.close(); }
    }

    static async #start(): Promise<void> {
        const dbPath = Service.#expandHome(Service.#requireEnv("PLURNK_DB_PATH"));
        const host = Service.#requireEnv("PLURNK_HOST");
        const port = Number(Service.#requireEnv("PLURNK_PORT"));

        const db = await Service.#openDb(dbPath);
        const alias = resolveActiveAlias();
        const provider = alias === null ? null : await ProviderInstantiate.loadActiveProvider();
        const daemon = new Daemon({ db, provider, nodeModulesPath: Service.#pluginsNodeModules() });
        const addr = await daemon.start({ host, port });
        if (await daemon.mimetypes.embedderInfo() === null) {
            process.stderr.write("plurnk-service: embedder inactive — semantic ~query falls back to FTS keyword ranking. Install @plurnk/plurnk-mimetypes-embeddings for vector search, or see README.md#semantic-search\n");
        }
        if (alias === null) {
            process.stderr.write(`plurnk-service: no model configured — uncomment one of the three options (local / cloud / plurnk.ai) in ${resolve(Service.#homeDir, ".env")}. Loops fail legibly until then.\n`);
        }
        const aliasStr = alias === null ? "no model" : `${alias.alias}=${alias.provider}/${alias.model}`;
        process.stdout.write(`plurnk-service ws://${addr.host}:${addr.port} db=${dbPath} ${aliasStr}\n`);

        const shutdown = async (): Promise<void> => { await daemon.stop(); await db.close(); process.exit(0); };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }

    static async main(): Promise<void> {
        if (!process.argv.includes("--help") && !process.argv.includes("-h")) Service.#ensureHome();
        // Env cascade — first write wins (loadEnvFile is set-if-unset), so load highest first.
        // Precedence high→low: CLI --flags > shell env > --env-file/--config > ./.env >
        // ~/.plurnk/.env > ~/.plurnk/.env.example > package .env.example (the floor).
        for (const { path: envFile, required } of Service.#envFileArgs()) Service.#loadEnv(envFile, required);

        const configFlagIndex = process.argv.findIndex((a) => a === "--config" || a.startsWith("--config="));
        const configFile = ((): string | null => {
            if (configFlagIndex === -1) return null;
            const arg = process.argv[configFlagIndex];
            if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
            return process.argv[configFlagIndex + 1] ?? null;
        })();

        if (configFile !== null) Service.#loadEnv(configFile, true);
        Service.#loadEnv(".env", false);
        Service.#loadEnv(resolve(Service.#homeDir, ".env"), false);
        Service.#loadEnv(resolve(Service.#homeDir, ".env.example"), false);   // the cascade floor (NOT the node_modules copy)

        const flagDescriptors = await EnvFlags.parseEnvExample(resolve(Service.#projectRoot, ".env.example"));
        const flagOptions: Record<string, { type: "string" }> = {};
        for (const f of flagDescriptors) {
            flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
        }

        const usage = `usage: plurnk-service [options] [migrate]

${EnvFlags.formatFlagsHelp(flagDescriptors)}

  --env-file=<path>            layer env from <path> (repeatable; errors if missing)
  --env-file-if-exists=<path>  layer env from <path> if present (repeatable)
  --config=<path>              layer additional env from <path>
  -h, --help                   show this help
`;

        const { positionals, values } = parseArgs({
            allowPositionals: true,
            strict: false,
            options: { help: { type: "boolean", short: "h" }, config: { type: "string" }, ...flagOptions },
        });

        for (const f of flagDescriptors) {
            const key = f.flagName.replace(/^--/, "");
            const v = values[key];
            if (typeof v === "string") process.env[f.envName] = v;
        }

        if (values.help) { process.stdout.write(usage); process.exit(0); }

        const dispatch: Record<string, () => Promise<void>> = { migrate: Service.#migrate, start: Service.#start };
        const subcommand = typeof positionals[0] === "string" ? positionals[0] : "start";
        const handler = dispatch[subcommand];
        if (handler === undefined) Service.#die(64, `unknown subcommand: ${subcommand}\n\n${usage}`);
        if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);

        try { await handler(); }
        catch (cause) {
            process.stderr.write(`${subcommand}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            if (cause instanceof Error && cause.cause) process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
            process.exit(1);
        }
    }
}

await Service.main();
