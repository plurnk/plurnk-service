#!/usr/bin/env node

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
        const db = await SqlRite.open({
            path: dbPath,
            dir: [resolve(Service.#projectRoot, "migrations"), Service.#codeDir],
            functions: [resolve(Service.#codeDir, `schemes/cosine${Service.#ext}`)],
            ...tuning,
        });
        return db as unknown as Db;
    }

    static async #migrate(): Promise<void> {
        const dbPath = Service.#requireEnv("PLURNK_DB_PATH");
        const db = await Service.#openDb(dbPath);
        try { process.stdout.write(`migrated: ${dbPath}\n`); }
        finally { await db.close(); }
    }

    static async #start(): Promise<void> {
        const dbPath = Service.#requireEnv("PLURNK_DB_PATH");
        const host = Service.#requireEnv("PLURNK_HOST");
        const port = Number(Service.#requireEnv("PLURNK_PORT"));

        const db = await Service.#openDb(dbPath);
        const alias = resolveActiveAlias();
        const provider = alias === null ? null : await ProviderInstantiate.loadActiveProvider();
        const daemon = new Daemon({ db, provider });
        const addr = await daemon.start({ host, port });
        if (await daemon.mimetypes.embedderInfo() === null) {
            process.stderr.write("plurnk-service: embedder inactive — semantic search (FIND) is degraded. Install @plurnk/plurnk-mimetypes-embeddings, or see README.md#semantic-search\n");
        }
        const aliasStr = alias === null ? "no model" : `${alias.alias}=${alias.provider}/${alias.model}`;
        process.stdout.write(`plurnk-service ws://${addr.host}:${addr.port} db=${dbPath} ${aliasStr}\n`);

        const shutdown = async (): Promise<void> => { await daemon.stop(); await db.close(); process.exit(0); };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }

    static async main(): Promise<void> {
        // Env cascade, first write wins (loadEnvFile is set-if-unset): --env-file(s) < --config
        // < .env < .env.example, all outranked by shell env, then by the --<knob> CLI flags.
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
        Service.#loadEnv(resolve(Service.#projectRoot, ".env.example"), false);

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
